// Сокеты: апгрейд, проверки входящего кадра, исполнение эффектов, бэкпрешер,
// ping/pong (§7 плана репозитория, osn§6.4, osn§10).
//
// Ядро остаётся чистым: транспорт разбирает кадр, зовёт `rooms.dispatch` и
// раскладывает эффекты по сокетам. Ни одного решения протокола здесь нет —
// всё, что решает, что ответить клиенту, живёт в `core/room.ts` и проверяется
// без сети. Здесь — только то, чего в чистой функции быть не может: сокет,
// часы для срока токена, буфер отправки и число соединений.
//
// Порядок проверок кадра — ровно как в §7, от дешёвых к дорогим:
//
//   1. путь и `Origin`            → close 1008
//   2. размер кадра > 1 МБ        → close 1009 (рвёт сам `ws` по maxPayload)
//   3. не JSON / двоичный кадр    → close 1007 / 1003
//   4. первый кадр не `hello`     → close 1008
//   5. токен: подпись, exp, доска → close 1008 (`error token-expired`/`forbidden`)
//   6. `delta` от роли `view`     → `reject view-only`, соединение живёт (ядро)
//   7. пятое соединение `sub`     → close 1008

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import { WebSocket, WebSocketServer } from 'ws'

import { boardTokenKey, CLOCK_TOLERANCE_S, verifyBoardToken } from './auth.js'
import type { Config } from './config.js'
import { appStatePatch } from './core/doc.js'
import type { ClientDeltaFrame, Claims, ConnId, ErrorCode, FileRef, StateVector } from './core/types.js'
import type { Room } from './core/room.js'
import { routeOf } from './http.js'
import { log } from './log.js'
import {
  closesTotal,
  connectionsGauge,
  deltaBroadcastSeconds,
  deltasTotal,
  outboxSize,
  pointersDroppedTotal,
} from './metrics.js'
import type { EffectSink, Rooms } from './rooms.js'

/** osn§6.4: кадр ≤ 1 МБ. Дробить крупную дельту — забота клиента. */
export const MAX_FRAME_BYTES = 1024 * 1024
/** osn§6.4: несколько вкладок — нормально, сотни — нет. */
export const MAX_CONNECTIONS_PER_SUB = 4
/** osn§6.4: выше этого курсоры получателю больше не шлём. */
export const BACKPRESSURE_DROP_BYTES = 4 * 1024 * 1024
/** osn§6.4: выше этого получатель безнадёжен и закрывается. */
export const BACKPRESSURE_CLOSE_BYTES = 16 * 1024 * 1024
/** §7: ws-ping раз в 25 с. */
export const PING_INTERVAL_MS = 25_000
/** §7: два неотвеченных ping подряд — соединение мертво. */
export const MAX_MISSED_PONGS = 2

// Коды закрытия. 1002 (ошибка протокола) отдаёт ядро на чужой версии.
const CLOSE_POLICY = 1008
const CLOSE_UNSUPPORTED = 1003
const CLOSE_BAD_DATA = 1007
const CLOSE_RESTART = 1012
const CLOSE_OVERLOADED = 1013

/** Что делать с исходящим кадром при таком заполнении буфера (osn§6.4). */
export type BackpressureVerdict = 'send' | 'drop' | 'close'

/**
 * Чистое решение бэкпрешера — отдельной функцией, потому что проверить его на
 * настоящем сокете значит налить в него 16 МБ.
 */
export function backpressureVerdict(bufferedBytes: number, droppable: boolean): BackpressureVerdict {
  if (bufferedBytes > BACKPRESSURE_CLOSE_BYTES) return 'close'
  if (droppable && bufferedBytes > BACKPRESSURE_DROP_BYTES) return 'drop'

  return 'send'
}

/**
 * Через сколько соединение с этим токеном пора закрывать. Тот же допуск на
 * часы, что и при проверке: закрыть раньше, чем сайт считает токен живым,
 * значило бы гонять клиента за новым токеном на ровном месте.
 */
export function tokenExpiryDelayMs(exp: number, now: number, graceMs: number): number {
  return Math.max(0, exp * 1000 + graceMs - now)
}

interface Conn {
  id: ConnId
  socket: WebSocket
  /** Доска из строки запроса сокета; с ней сверяется claim `board`. */
  board: string | null
  claims: Claims | null
  joined: boolean
  missedPongs: number
  expiry: NodeJS.Timeout | null
  /**
   * Обработка кадров выстроена в цепочку промисов: `hello` асинхронный
   * (проверка подписи), и без цепочки дельта, приехавшая тем же пакетом,
   * попала бы в обработчик раньше — и была бы закрыта как «первый кадр не
   * hello». Все кадры после `hello` обрабатываются синхронно, так что цепочка
   * схлопывается сразу же.
   */
  chain: Promise<void>
  ip: string
}

export interface TransportOptions {
  config: Config
  rooms: Rooms
  /** Часы для срока токена. Параметр ради теста. */
  now?: () => number
  /** Допуск к `exp` перед закрытием соединения; ради теста. */
  tokenGraceMs?: number
  pingIntervalMs?: number
}

export class Transport implements EffectSink {
  readonly #config: Config
  readonly #rooms: Rooms
  readonly #key: Uint8Array
  readonly #now: () => number
  readonly #tokenGraceMs: number
  readonly #pingIntervalMs: number

  readonly #wss: WebSocketServer
  readonly #conns = new Map<ConnId, Conn>()
  /** `board\0sub` → соединения этого человека на этой доске (лимит ≤ 4). */
  readonly #bySub = new Map<string, Set<ConnId>>()

  #nextId = 0
  #accepting = true
  #pingTimer: NodeJS.Timeout | null = null

  constructor(options: TransportOptions) {
    this.#config = options.config
    this.#rooms = options.rooms
    this.#key = boardTokenKey(options.config.boardServerSecret)
    this.#now = options.now ?? Date.now
    this.#tokenGraceMs = options.tokenGraceMs ?? CLOCK_TOLERANCE_S * 1000
    this.#pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS

    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_FRAME_BYTES,
      // Сжатие выключено намеренно: кадры мелкие и уже почти несжимаемые
      // (JSON с числами), а `permessage-deflate` держит на соединение
      // отдельный контекст zlib — это мегабайты памяти на комнату и заметная
      // доля CPU там, где её беречь важнее байтов.
      perMessageDeflate: false,
    })

    this.#rooms.attach(this)
  }

  get connections(): number {
    return this.#conns.size
  }

  /** Апгрейд принимается только по адресу сервиса; всё прочее — обычный 404. */
  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head))
    this.#pingTimer = setInterval(() => this.#sweep(), this.#pingIntervalMs)
    this.#pingTimer.unref()
  }

  // ——— апгрейд ———

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (routeOf(req.url) !== '/') {
      this.#refuse(socket, 404, 'Not Found')
      return
    }
    if (!this.#accepting) {
      // Остановка: новые соединения не принимаем, но и не обманываем — клиент
      // по 503 переподключится к тому, кто уже поднялся (osn§10, SIGTERM).
      this.#refuse(socket, 503, 'Service Unavailable')
      return
    }

    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, req))
  }

  #refuse(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    socket.destroy()
  }

  /**
   * Origin из белого списка. Отсутствие заголовка — не браузер (наш
   * нагрузочный скрипт, `wscat`, тест), и это не дыра: заголовок ставит сам
   * браузер и подделать его страница не может, а значит проверка защищает
   * ровно от того, от чего должна, — от чужой страницы, открывающей сокет от
   * имени пользователя. Всё остальное закрывает токен.
   */
  #originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true

    return this.#config.allowedOrigins.includes(origin)
  }

  #onConnection(socket: WebSocket, req: IncomingMessage): void {
    const id = `c${++this.#nextId}`
    const forwarded = req.headers['x-forwarded-for']
    const conn: Conn = {
      id,
      socket,
      board: boardOf(req.url),
      claims: null,
      joined: false,
      missedPongs: 0,
      expiry: null,
      chain: Promise.resolve(),
      // Маршрут dockhost кладёт настоящий адрес клиента в x-forwarded-for
      // (проверено пробником Ф0); socket.remoteAddress — это шлюз.
      ip: (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '?',
    }

    this.#conns.set(id, conn)
    connectionsGauge.set(this.#conns.size)

    // Обработчики вешаются до первой проверки, и до неё же соединение попадает
    // в реестр: закрытое сразу после апгрейда должно из реестра уйти так же,
    // как любое другое, — иначе остановка ждала бы его двадцать секунд.
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      conn.chain = conn.chain.then(() => this.#onMessage(conn, data, isBinary)).catch((error: unknown) => {
        log.error({ err: error, conn: id }, 'обработка кадра упала')
        this.#close(conn, CLOSE_POLICY, 'internal')
      })
    })
    socket.on('pong', () => {
      conn.missedPongs = 0
    })
    socket.on('error', (error) => {
      // Сюда же приходит превышение maxPayload: `ws` закрывает соединение сам
      // кодом 1009, нам остаётся записать это в лог с причиной.
      log.warn({ err: error, conn: id, board: conn.board }, 'ошибка сокета')
    })
    socket.on('close', (code) => this.#onClose(conn, code))

    const origin = req.headers.origin
    if (!this.#originAllowed(origin)) {
      log.warn({ conn: id, origin, ip: conn.ip }, 'апгрейд с чужого origin')
      this.#fail(conn, 'forbidden', 'источник не разрешён', 'origin')
    }
  }

  // ——— кадры ———

  async #onMessage(conn: Conn, data: Buffer, isBinary: boolean): Promise<void> {
    if (conn.socket.readyState !== WebSocket.OPEN) return

    if (isBinary) {
      // Протокол текстовый (osn§6): двоичный кадр — это другой клиент, а не
      // наш, и разбирать его нечем.
      this.#close(conn, CLOSE_UNSUPPORTED, 'binary')
      return
    }

    let frame: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(data.toString('utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('не объект')
      frame = parsed as Record<string, unknown>
    } catch (error) {
      log.warn({ conn: conn.id, err: error }, 'кадр не разобран')
      this.#close(conn, CLOSE_BAD_DATA, 'bad-json')
      return
    }

    const t = frame.t
    if (typeof t !== 'string') {
      this.#close(conn, CLOSE_BAD_DATA, 'no-type')
      return
    }

    if (!conn.joined) {
      if (t !== 'hello') {
        log.warn({ conn: conn.id, t }, 'первый кадр не hello')
        this.#fail(conn, 'forbidden', 'первым кадром ожидается hello', 'no-hello')
        return
      }

      await this.#hello(conn, frame)
      return
    }

    switch (t) {
      case 'hello':
        // Повторный вход по тому же сокету: заново считать права и членство
        // негде, а молча игнорировать — прятать расхождение клиента.
        this.#fail(conn, 'forbidden', 'hello уже был', 'double-hello')
        return

      case 'delta':
        this.#delta(conn, frame)
        return

      case 'pointer': {
        const { x, y } = frame
        if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return

        this.#dispatch(conn, { t: 'pointer', conn: conn.id, x, y })
        return
      }

      case 'appState':
        this.#dispatch(conn, {
          t: 'appState',
          conn: conn.id,
          patch: appStatePatch({
            t: 'appState',
            ...(typeof frame.theme === 'string' ? { theme: frame.theme } : {}),
            ...(typeof frame.font === 'number' ? { font: frame.font } : {}),
            ...(typeof frame.background === 'string' ? { background: frame.background } : {}),
          }),
        })
        return

      case 'ping':
        // Прикладной ping из osn§6.1. Пробник Ф0 показал, что шлюз молчащие
        // соединения не рубит, но клиенту он всё равно нужен: по нему видно,
        // что сокет жив, не дожидаясь ws-ping от сервера.
        this.#write(conn, Buffer.from('{"t":"pong"}'), false)
        return

      default:
        // Незнакомый тип не закрываем: два репозитория раскатываются порознь,
        // и кадр из версии поновее не повод ронять доску. Расхождение версий
        // ловит проверка `v` в `hello` (§15), она точнее.
        log.debug({ conn: conn.id, t }, 'незнакомый кадр пропущен')
    }
  }

  async #hello(conn: Conn, frame: Record<string, unknown>): Promise<void> {
    const verified = await verifyBoardToken(frame.token, this.#key, conn.board)
    if (conn.socket.readyState !== WebSocket.OPEN) return

    if (!verified.ok) {
      log.warn(
        { conn: conn.id, board: conn.board, reason: verified.reason, detail: verified.detail },
        'токен не принят'
      )
      // Протухший токен — единственный отказ, после которого клиенту есть куда
      // идти: за новым токеном и обратно с тем же вектором (osn§10).
      const code: ErrorCode = verified.reason === 'expired' ? 'token-expired' : 'forbidden'
      this.#fail(conn, code, verified.detail, verified.reason)
      return
    }

    const claims = verified.claims

    // Комната поднимается до всего остального: чтение документа — сетевой
    // запрос, а `dispatch` синхронный, и `welcome` собирается уже из готового
    // документа. Ждать здесь безопасно: кадры соединения обрабатываются по
    // очереди (`conn.chain`), и `delta` вперёд `join` не проскочит.
    try {
      await this.#rooms.open(claims.board)
    } catch (error) {
      // Неизвестно, что на доске, — рисовать нельзя: комната, поднятая пустой,
      // первой же записью затёрла бы настоящий документ. Клиенту это чинится
      // повторной попыткой, поэтому код `room-closing` и 1013 «попробуй позже»,
      // а не 1008.
      log.error({ conn: conn.id, board: claims.board, err: error }, 'комната не поднята')
      this.#fail(conn, 'room-closing', 'доска сейчас недоступна', 'storage', CLOSE_OVERLOADED)
      return
    }
    if (conn.socket.readyState !== WebSocket.OPEN) return

    const key = subKey(claims.board, claims.sub)
    const peers = this.#bySub.get(key) ?? new Set<ConnId>()
    if (peers.size >= MAX_CONNECTIONS_PER_SUB) {
      log.warn({ conn: conn.id, board: claims.board, sub: claims.sub, open: peers.size }, 'лимит соединений')
      this.#fail(conn, 'forbidden', `больше ${MAX_CONNECTIONS_PER_SUB} соединений на доску`, 'too-many')
      return
    }

    conn.claims = claims
    conn.joined = true
    peers.add(conn.id)
    this.#bySub.set(key, peers)

    const outbox = readOutbox(frame.outbox)
    outboxSize.observe(outbox.length)

    this.#rooms.dispatch(claims.board, {
      t: 'join',
      conn: conn.id,
      claims,
      ...(typeof frame.v === 'number' ? { v: frame.v } : {}),
      vector: readVector(frame.vector),
      files: readFileIds(frame.files),
      outbox,
    })

    // Токен живёт два часа, занятие дольше (osn§7). По его концу соединение
    // закрывается с `token-expired`: клиент берёт новый токен и возвращается с
    // вектором, заодно подхватывая смену прав. Иначе сокет, открытый по
    // валидному когда-то токену, жил бы вечно.
    const delay = tokenExpiryDelayMs(claims.exp, this.#now(), this.#tokenGraceMs)
    conn.expiry = setTimeout(() => {
      log.info({ conn: conn.id, board: claims.board, sub: claims.sub }, 'токен истёк')
      this.#fail(conn, 'token-expired', 'срок токена истёк', 'expired')
    }, delay)
    conn.expiry.unref()

    log.info(
      { conn: conn.id, board: claims.board, sub: claims.sub, role: claims.role, outbox: outbox.length, ip: conn.ip },
      'вход в комнату'
    )
  }

  #delta(conn: Conn, frame: Record<string, unknown>): void {
    const cseq = frame.cseq
    if (typeof cseq !== 'number' || !Number.isFinite(cseq)) {
      this.#close(conn, CLOSE_BAD_DATA, 'bad-cseq')
      return
    }

    deltasTotal.inc()

    // Секунды с плавающей точкой: `deltaBroadcastSeconds` меряет работу внутри
    // сервиса — слияние и сборку кадров, — а она укладывается в доли
    // миллисекунды, и целочисленный миллисекундный таймер показывал бы нули.
    const started = process.hrtime.bigint()
    this.#dispatch(conn, {
      t: 'delta',
      conn: conn.id,
      cseq,
      elements: asArray(frame.elements) as never,
      files: asArray(frame.files) as FileRef[],
    })
    deltaBroadcastSeconds.observe(Number(process.hrtime.bigint() - started) / 1e9)
  }

  #dispatch(conn: Conn, event: Parameters<Rooms['dispatch']>[1]): void {
    if (!conn.claims) return

    this.#rooms.dispatch(conn.claims.board, event)
  }

  // ——— эффекты (EffectSink) ———

  send(to: ConnId, frame: Buffer, droppable: boolean): void {
    const conn = this.#conns.get(to)
    if (conn) this.#write(conn, frame, droppable)
  }

  broadcast(room: Room, except: ConnId | null, frame: Buffer, droppable: boolean): void {
    for (const member of room.members.keys()) {
      if (member === except) continue

      const conn = this.#conns.get(member)
      if (conn) this.#write(conn, frame, droppable)
    }
  }

  close(to: ConnId, code: number, reason: string): void {
    const conn = this.#conns.get(to)
    if (conn) this.#close(conn, code, reason)
  }

  #write(conn: Conn, frame: Buffer, droppable: boolean): void {
    if (conn.socket.readyState !== WebSocket.OPEN) return

    switch (backpressureVerdict(conn.socket.bufferedAmount, droppable)) {
      case 'close':
        // Медленный клиент не должен держать память комнаты: он вернётся с
        // вектором и ничего не потеряет — ради этого протокол и делался.
        log.warn({ conn: conn.id, buffered: conn.socket.bufferedAmount }, 'бэкпрешер: закрываем')
        this.#close(conn, CLOSE_OVERLOADED, 'backpressure')
        return

      case 'drop':
        pointersDroppedTotal.inc()
        return

      case 'send':
        // Кадры протокола — JSON-текст (osn§6). Без этого флага `ws` отправляет
        // Buffer двоичным кадром: в Node такое разбирается, а в браузере
        // приезжает `Blob`'ом, который читается только асинхронно, — и клиент
        // терял первый же `welcome` (журнал Ф8).
        conn.socket.send(frame, { binary: false })
    }
  }

  // ——— закрытие ———

  /** Кадр `error` и закрытие следом: клиент должен знать причину (osn§6.2). */
  #fail(conn: Conn, code: ErrorCode, message: string, reason: string, closeCode = CLOSE_POLICY): void {
    this.#write(conn, Buffer.from(JSON.stringify({ t: 'error', code, message })), false)
    this.#close(conn, closeCode, reason)
  }

  #close(conn: Conn, code: number, reason: string): void {
    if (conn.socket.readyState === WebSocket.CLOSED || conn.socket.readyState === WebSocket.CLOSING) return

    closesTotal.inc({ reason })
    // Причина в закрытии — utf-8 и не длиннее 123 байт по RFC 6455, поэтому
    // здесь короткий латинский ярлык, а человеческий текст — в логе и в кадре
    // `error` перед закрытием.
    conn.socket.close(code, reason)
  }

  #onClose(conn: Conn, code: number): void {
    if (!this.#conns.delete(conn.id)) return

    connectionsGauge.set(this.#conns.size)
    if (conn.expiry) clearTimeout(conn.expiry)

    if (conn.claims) {
      const key = subKey(conn.claims.board, conn.claims.sub)
      const peers = this.#bySub.get(key)
      if (peers) {
        peers.delete(conn.id)
        if (peers.size === 0) this.#bySub.delete(key)
      }

      if (conn.joined) this.#rooms.dispatch(conn.claims.board, { t: 'leave', conn: conn.id })
    }

    log.info({ conn: conn.id, board: conn.board, code, open: this.#conns.size }, 'соединение закрыто')
  }

  /** ws-ping всем: два неотвеченных подряд — клиент мёртв (§7). */
  #sweep(): void {
    for (const conn of this.#conns.values()) {
      if (conn.socket.readyState !== WebSocket.OPEN) continue

      if (conn.missedPongs >= MAX_MISSED_PONGS) {
        log.warn({ conn: conn.id, board: conn.board }, 'нет pong дважды подряд — обрываем')
        closesTotal.inc({ reason: 'no-pong' })
        // Именно terminate: close ждал бы ответного кадра от того, кто уже не
        // отвечает, и сокет висел бы до таймаута.
        conn.socket.terminate()
        continue
      }

      conn.missedPongs += 1
      conn.socket.ping()
    }
  }

  /** Перестать принимать апгрейды — первый шаг остановки (§7). */
  stopAccepting(): void {
    this.#accepting = false
  }

  /**
   * Закрыть всё живое кодом 1012 «service restart» и дождаться, пока сокеты
   * действительно закроются. Клиент по 1012 переподключается сразу, поэтому
   * важно, чтобы к этому моменту `readyz` уже отвечал 503 и его не привели
   * обратно на умирающий инстанс.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.stopAccepting()
    if (this.#pingTimer) {
      clearInterval(this.#pingTimer)
      this.#pingTimer = null
    }

    for (const conn of this.#conns.values()) {
      this.#write(conn, Buffer.from(JSON.stringify({ t: 'error', code: 'room-closing', message: 'сервис перезапускается' })), false)
      this.#close(conn, CLOSE_RESTART, 'restart')
    }

    await this.#drain(timeoutMs)

    // Кто не закрылся за отведённое время — рвём, иначе процесс не кончится.
    for (const conn of this.#conns.values()) {
      log.warn({ conn: conn.id }, 'сокет не закрылся за отведённое время — обрываем')
      conn.socket.terminate()
    }

    this.#wss.close()
  }

  async #drain(timeoutMs: number): Promise<void> {
    const deadline = this.#now() + timeoutMs

    while (this.#conns.size > 0 && this.#now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
}

// ——— разбор того, что пришло с провода ———

function subKey(board: string, sub: string): string {
  return `${board}\u0000${sub}`
}

/** Доска, к которой просится соединение: `wss://…/board-ws?board=<uuid>`. */
function boardOf(url: string | undefined): string | null {
  const query = (url ?? '').split('?')[1]
  if (!query) return null

  return new URLSearchParams(query).get('board')
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Вектор состояния: `id → version` либо `id → [version, versionNonce]`. Пара
 * обязательна клиенту Ф7 — по одной версии не видно победы большего нонса при
 * равных версиях, и разошедшийся элемент так и остался бы разошедшимся
 * (найдено в Ф3).
 */
function readVector(value: unknown): StateVector {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}

  const vector: StateVector = {}
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) {
      vector[id] = entry
    } else if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === 'number' &&
      typeof entry[1] === 'number'
    ) {
      vector[id] = [entry[0], entry[1]]
    }
  }

  return vector
}

function readFileIds(value: unknown): string[] {
  return asArray(value).filter((id): id is string => typeof id === 'string')
}

/** Неподтверждённые дельты из `hello`; каждая пойдёт тем же путём, что кадр. */
function readOutbox(value: unknown): ClientDeltaFrame[] {
  const outbox: ClientDeltaFrame[] = []

  for (const entry of asArray(value)) {
    if (typeof entry !== 'object' || entry === null) continue

    const delta = entry as Partial<ClientDeltaFrame>
    if (typeof delta.cseq !== 'number' || !Number.isFinite(delta.cseq)) continue

    outbox.push({
      t: 'delta',
      cseq: delta.cseq,
      elements: asArray(delta.elements) as never,
      files: asArray(delta.files) as FileRef[],
    })
  }

  return outbox
}
