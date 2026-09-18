// Транспорт на настоящих сокетах (Ф4): всё, что нельзя проверить вызовом
// `step` в цикле. Протокол здесь не проверяется — он разобран поимённо в
// `room.test.ts` и прогоняется моделью доставки в `protocol.test.ts`; тут
// проверяется, что кадры действительно доезжают по сети, что порядок проверок
// §7 соблюдён и что сервис корректно останавливается.

import type { AddressInfo } from 'node:net'

import { SignJWT } from 'jose'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { createService } from '../src/index.js'
import type { Service, ServiceOverrides } from '../src/index.js'
import { memoryStorage } from './fixtures/storage.js'
import {
  BACKPRESSURE_CLOSE_BYTES,
  BACKPRESSURE_DROP_BYTES,
  MAX_CONNECTIONS_PER_SUB,
  MAX_FRAME_BYTES,
  backpressureVerdict,
} from '../src/transport.js'

const BOARD = '11111111-1111-1111-1111-111111111111'
const OTHER_BOARD = '22222222-2222-2222-2222-222222222222'
const SECRET = 'kH3v9Qb2sX7dP0nL8xW4vT6hJ3cL9gZ0aE5uF1iO7pR='
const ORIGIN = 'https://egesto.ru'

function config() {
  return loadConfig({
    BOARD_SERVER_SECRET: SECRET,
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-ключ',
    ALLOWED_ORIGINS: `${ORIGIN},https://www.egesto.ru`,
  })
}

async function token(options: { board?: string; role?: 'edit' | 'view'; sub?: string; ttlS?: number } = {}) {
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({
    board: options.board ?? BOARD,
    role: options.role ?? 'edit',
    name: options.sub === 'student' ? 'Ученик' : 'Репетитор',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(options.sub ?? 'tutor')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.ttlS ?? 7200))
    .sign(new TextEncoder().encode(SECRET))
}

type Frame = Record<string, unknown>

/** Клиент с очередью кадров: тест ждёт следующий, а не спит фиксированный срок. */
class Client {
  readonly socket: WebSocket
  readonly #queue: Frame[] = []
  #waiting: ((frame: Frame) => void) | null = null
  #closed: { code: number; reason: string } | null = null
  #closeWaiting: ((close: { code: number; reason: string }) => void) | null = null

  constructor(url: string, options: WebSocket.ClientOptions = {}) {
    this.socket = new WebSocket(url, options)
    this.socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Frame
      if (this.#waiting) {
        const resolve = this.#waiting
        this.#waiting = null
        resolve(frame)
      } else {
        this.#queue.push(frame)
      }
    })
    this.socket.on('close', (code, reason) => {
      this.#closed = { code, reason: reason.toString('utf8') }
      this.#closeWaiting?.(this.#closed)
    })
    // Отказ апгрейда приходит ошибкой; тест её ждёт через `closed()`.
    this.socket.on('error', () => undefined)
  }

  async open(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', resolve)
      this.socket.once('error', reject)
    })
  }

  send(frame: Frame | string): void {
    this.socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
  }

  async hello(raw: string, extra: Frame = {}): Promise<void> {
    this.send({ t: 'hello', v: 1, token: raw, vector: {}, files: [], outbox: [], ...extra })
  }

  /** Следующий кадр; `t` — ожидаемый тип, для внятного падения. */
  async next(t?: string): Promise<Frame> {
    const frame =
      this.#queue.shift() ??
      (await Promise.race([
        new Promise<Frame>((resolve) => {
          this.#waiting = resolve
        }),
        new Promise<Frame>((_, reject) =>
          setTimeout(() => reject(new Error(`кадр ${t ?? ''} не пришёл за 3 с`)), 3000).unref()
        ),
      ]))

    if (t) expect(frame.t).toBe(t)

    return frame
  }

  async closed(): Promise<{ code: number; reason: string }> {
    if (this.#closed) return this.#closed

    return Promise.race([
      new Promise<{ code: number; reason: string }>((resolve) => {
        this.#closeWaiting = resolve
      }),
      new Promise<{ code: number; reason: string }>((_, reject) =>
        setTimeout(() => reject(new Error('сокет не закрылся за 3 с')), 3000).unref()
      ),
    ])
  }

  dispose(): void {
    this.socket.terminate()
  }
}

let service: Service | null = null
const clients: Client[] = []

async function serve(overrides: ServiceOverrides = {}): Promise<string> {
  // Хранилище — в памяти: `SUPABASE_URL` здесь заведомо недостижим, а комнату
  // сервис с Ф5 поднимает чтением документа и без ответа не пускает.
  service = createService(config(), { storage: memoryStorage(), ...overrides })
  await new Promise<void>((resolve) => service!.server.listen(0, '127.0.0.1', resolve))
  const { port } = service.server.address() as AddressInfo

  return `ws://127.0.0.1:${port}/board-ws`
}

function connect(url: string, options: WebSocket.ClientOptions = {}): Client {
  const client = new Client(url, options)
  clients.push(client)

  return client
}

/** Подключиться, войти и дождаться `welcome`. */
async function join(
  url: string,
  options: { role?: 'edit' | 'view'; sub?: string; board?: string } = {}
): Promise<Client> {
  const client = connect(`${url}?board=${options.board ?? BOARD}`, { origin: ORIGIN })
  await client.open()
  await client.hello(await token(options))
  await client.next('welcome')

  return client
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.dispose()
  if (service) {
    await service.shutdown('тест')
    service = null
  }
})

describe('вход и обмен', () => {
  it('hello отдаёт welcome с ролью и пустой сценой', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    await client.hello(await token())

    const welcome = await client.next('welcome')

    expect(welcome.seq).toBe(0)
    expect(welcome.role).toBe('edit')
    expect(welcome.elements).toEqual([])
    expect(welcome.members).toEqual([{ userId: 'tutor', name: 'Репетитор', role: 'edit' }])
  })

  it('кадр приезжает текстовым, а не двоичным', async () => {
    // По osn§6 кадры — JSON-текст. Пока сервис слал Buffer без флага, `ws`
    // отправлял двоичный кадр: `event.data` в браузере приезжал `Blob`'ом,
    // синхронный разбор его отбрасывал, и вкладка навсегда висела в
    // `connecting` — этим кончилась ручная проверка Ф8.
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()

    const kind = new Promise<boolean>((resolve) => {
      client.socket.once('message', (_data: Buffer, isBinary: boolean) => resolve(isBinary))
    })
    await client.hello(await token())

    expect(await kind).toBe(false)
  })

  it('правка одного доезжает до второго, автору — ack', async () => {
    const url = await serve()
    const tutor = await join(url, { sub: 'tutor' })
    const student = await join(url, { sub: 'student' })

    // Вход второго виден первому.
    expect(await tutor.next('presence')).toMatchObject({
      members: [
        { userId: 'tutor', role: 'edit' },
        { userId: 'student', role: 'edit' },
      ],
    })

    tutor.send({
      t: 'delta',
      cseq: 1,
      elements: [{ id: 'a', type: 'rectangle', x: 1, y: 2, version: 1, versionNonce: 7 }],
      files: [],
    })

    const delivered = await student.next('delta')
    expect(delivered.seq).toBe(1)
    expect(delivered.from).toBe('tutor')
    expect((delivered.elements as { id: string }[])[0]).toMatchObject({ id: 'a', version: 1 })

    expect(await tutor.next('ack')).toEqual({ t: 'ack', cseq: 1, seq: 1 })
  })

  it('прикладной ping получает pong', async () => {
    const url = await serve()
    const client = await join(url)

    client.send({ t: 'ping' })

    expect(await client.next('pong')).toEqual({ t: 'pong' })
  })

  it('уход участника доезжает до оставшихся', async () => {
    const url = await serve()
    const tutor = await join(url, { sub: 'tutor' })
    const student = await join(url, { sub: 'student' })
    await tutor.next('presence')

    student.socket.close()

    expect(await tutor.next('presence')).toMatchObject({ members: [{ userId: 'tutor' }] })
  })

  it('роль view получает reject и остаётся в комнате', async () => {
    const url = await serve()
    const viewer = await join(url, { role: 'view', sub: 'guest:1' })

    viewer.send({
      t: 'delta',
      cseq: 1,
      elements: [{ id: 'a', type: 'rectangle', version: 1, versionNonce: 7 }],
    })

    expect(await viewer.next('reject')).toEqual({ t: 'reject', cseq: 1, reason: 'view-only' })

    // Соединение живёт: зритель продолжает видеть чужие правки.
    viewer.send({ t: 'ping' })
    expect(await viewer.next('pong')).toEqual({ t: 'pong' })
  })
})

describe('порядок проверок §7', () => {
  it('1. чужой origin — close 1008', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: 'https://evil.example' })
    await client.open()

    expect(await client.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await client.closed()).code).toBe(1008)
  })

  it('1. свой origin из списка пропускается', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: 'https://www.egesto.ru' })
    await client.open()
    await client.hello(await token())

    await client.next('welcome')
  })

  it('2. кадр больше 1 МБ — сокет рвётся с 1009', async () => {
    const url = await serve()
    const client = await join(url)

    client.send({ t: 'delta', cseq: 1, elements: [], padding: 'ф'.repeat(MAX_FRAME_BYTES) })

    expect((await client.closed()).code).toBe(1009)
  })

  it('3. не-JSON — close 1007', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    client.send('{это не json')

    expect((await client.closed()).code).toBe(1007)
  })

  it('3. двоичный кадр — close 1003', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    client.socket.send(Buffer.from([1, 2, 3]))

    expect((await client.closed()).code).toBe(1003)
  })

  it('4. первый кадр не hello — close 1008', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    client.send({ t: 'delta', cseq: 1, elements: [] })

    expect(await client.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await client.closed()).code).toBe(1008)
  })

  it('5. чужая подпись — error forbidden и close 1008', async () => {
    const url = await serve()
    const alien = await new SignJWT({ board: BOARD, role: 'edit', name: 'Чужой' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('чужой')
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode('не тот секрет'))

    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    await client.hello(alien)

    expect(await client.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await client.closed()).code).toBe(1008)
  })

  it('5. токен от другой доски не пускает', async () => {
    const url = await serve()
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    await client.hello(await token({ board: OTHER_BOARD }))

    expect(await client.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await client.closed()).code).toBe(1008)
  })

  it('5. соединение без доски в адресе не пускает', async () => {
    const url = await serve()
    const client = connect(url, { origin: ORIGIN })
    await client.open()
    await client.hello(await token())

    expect(await client.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await client.closed()).code).toBe(1008)
  })

  it('5. протухший токен — error token-expired', async () => {
    // Секундный токен и нулевой допуск: в бою это два часа плюс минута.
    const url = await serve({ tokenGraceMs: 0 })
    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    await client.hello(await token({ ttlS: 1 }))
    await client.next('welcome')

    expect(await client.next('error')).toMatchObject({ code: 'token-expired' })
    expect((await client.closed()).code).toBe(1008)
  })

  it('6. delta от view отклоняется, соединение живёт', async () => {
    // Проверено выше («роль view получает reject и остаётся в комнате»);
    // здесь — что решение принимает ядро, а не транспорт: документ не менялся.
    const url = await serve()
    const viewer = await join(url, { role: 'view', sub: 'guest:2' })
    viewer.send({ t: 'delta', cseq: 1, elements: [{ id: 'a', version: 1, versionNonce: 1 }] })
    await viewer.next('reject')

    expect(service?.rooms.peek(BOARD)?.doc.elements.size).toBe(0)
  })

  it(`7. соединение сверх ${MAX_CONNECTIONS_PER_SUB} на sub закрывается`, async () => {
    const url = await serve()
    const raw = await token({ sub: 'многовкладочный' })

    for (let i = 0; i < MAX_CONNECTIONS_PER_SUB; i += 1) {
      const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
      await client.open()
      await client.hello(raw)
      await client.next('welcome')
    }

    const extra = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await extra.open()
    await extra.hello(raw)

    expect(await extra.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await extra.closed()).code).toBe(1008)

    // Освободившееся место занимается: лимит про одновременные вкладки, а не
    // про число входов за жизнь комнаты.
    clients[0]!.socket.close()
    await clients[0]!.closed()

    const again = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await again.open()
    await again.hello(raw)
    await again.next('welcome')
  })

  it('вторая доска — вторая комната; токен одной на другую не годится', async () => {
    const url = await serve()
    await join(url, { sub: 'tutor' })
    await join(url, { sub: 'tutor', board: OTHER_BOARD })

    expect(service?.rooms.size).toBe(2)
  })
})

describe('разбор того, что пришло с провода', () => {
  it('реконнект: вектор парами и outbox в hello', async () => {
    const url = await serve()
    const tutor = await join(url, { sub: 'tutor' })
    const student = await join(url, { sub: 'student' })
    await tutor.next('presence')

    tutor.send({
      t: 'delta',
      cseq: 1,
      elements: [{ id: 'a', type: 'rectangle', version: 3, versionNonce: 700 }],
    })
    await tutor.next('ack')
    await student.next('delta')

    // Ученик «потерял» сокет и возвращается с тем, что у него есть: элемент
    // `a` третьей версии и неотправленная правка `b` в outbox.
    student.socket.close()
    await student.closed()
    await tutor.next('presence')

    const back = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await back.open()
    await back.hello(await token({ sub: 'student' }), {
      vector: { a: [3, 700] },
      outbox: [{ t: 'delta', cseq: 5, elements: [{ id: 'b', type: 'ellipse', version: 1, versionNonce: 4 }] }],
    })

    // Досланная правка уходит соседу и подтверждается автору, а `welcome`
    // содержит только разницу — `a` у ученика уже есть.
    expect(await tutor.next('delta')).toMatchObject({ from: 'student' })

    // Порядок кадров вошедшему: сначала подтверждение досланного, потом
    // `welcome` — outbox сливается до подсчёта разницы, иначе автор получил бы
    // собственные правки обратно устаревшими.
    expect(await back.next('ack')).toMatchObject({ cseq: 5 })
    const welcome = await back.next('welcome')
    expect((welcome.elements as { id: string }[]).map((el) => el.id)).toEqual(['b'])
  })

  it('вектор голым числом тоже понимается', async () => {
    const url = await serve()
    const tutor = await join(url, { sub: 'tutor' })
    tutor.send({ t: 'delta', cseq: 1, elements: [{ id: 'a', version: 2, versionNonce: 9 }] })
    await tutor.next('ack')

    const client = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await client.open()
    await client.hello(await token({ sub: 'student' }), { vector: { a: 2, мусор: 'не число' } })

    expect((await client.next('welcome')).elements).toEqual([])
  })

  it('битые поля кадра не роняют сервис', async () => {
    const url = await serve()
    const client = await join(url)

    client.send({ t: 'delta', cseq: 2, elements: 'не массив', files: 17 })
    expect(await client.next('ack')).toMatchObject({ cseq: 2, seq: 0 })

    client.send({ t: 'pointer', x: 'сюда', y: null })
    client.send({ t: 'какой-то новый кадр из будущего' })
    client.send({ t: 'ping' })

    expect(await client.next('pong')).toEqual({ t: 'pong' })
  })

  it('delta без cseq — close 1007', async () => {
    const url = await serve()
    const client = await join(url)

    client.send({ t: 'delta', elements: [] })

    expect((await client.closed()).code).toBe(1007)
  })

  it('второй hello по тому же сокету не принимается', async () => {
    const url = await serve()
    const client = await join(url)

    await client.hello(await token())

    expect(await client.next('error')).toMatchObject({ code: 'forbidden' })
    expect((await client.closed()).code).toBe(1008)
  })
})

describe('бэкпрешер (osn§6.4)', () => {
  it('курсоры пропускаются с 4 МБ, сокет закрывается с 16 МБ', () => {
    expect(backpressureVerdict(0, true)).toBe('send')
    expect(backpressureVerdict(BACKPRESSURE_DROP_BYTES, true)).toBe('send')
    expect(backpressureVerdict(BACKPRESSURE_DROP_BYTES + 1, true)).toBe('drop')
    // Дельту при том же заполнении не теряем — она встаёт в очередь сокета.
    expect(backpressureVerdict(BACKPRESSURE_DROP_BYTES + 1, false)).toBe('send')
    expect(backpressureVerdict(BACKPRESSURE_CLOSE_BYTES + 1, false)).toBe('close')
    expect(backpressureVerdict(BACKPRESSURE_CLOSE_BYTES + 1, true)).toBe('close')
  })
})

describe('ws-ping', () => {
  it('клиент, не отвечающий pong дважды подряд, обрывается', async () => {
    // В бою интервал 25 с; здесь 40 мс, иначе тест шёл бы минуту.
    const url = await serve({ pingIntervalMs: 40 })
    const client = await join(url)

    // `ws` отвечает на ping сам, поэтому «мёртвого» клиента приходится делать
    // руками: глушим ответ, оставив сокет открытым.
    client.socket.pong = () => undefined

    expect((await client.closed()).code).toBe(1006)
  })

  it('отвечающий клиент живёт', async () => {
    const url = await serve({ pingIntervalMs: 40 })
    const client = await join(url)

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(client.socket.readyState).toBe(WebSocket.OPEN)
  })
})

describe('остановка', () => {
  it('SIGTERM: error room-closing, код 1012, новых сокетов нет', async () => {
    const url = await serve()
    const client = await join(url)

    const stopped = service!.shutdown('SIGTERM')

    expect(await client.next('error')).toMatchObject({ code: 'room-closing' })
    expect((await client.closed()).code).toBe(1012)

    await stopped

    const refused = connect(`${url}?board=${BOARD}`, { origin: ORIGIN })
    await expect(refused.open()).rejects.toThrow()
  })

  it('остановка без единого соединения тоже завершается', async () => {
    await serve()

    await expect(service!.shutdown('SIGTERM')).resolves.toBeUndefined()
  })
})

describe('/metrics', () => {
  it('отдаёт непустой текст с метриками транспорта', async () => {
    const url = await serve()
    await join(url)

    const { port } = service!.server.address() as AddressInfo
    const response = await fetch(`http://127.0.0.1:${port}/metrics`)
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).toContain('board_rooms 1')
    expect(text).toContain('board_connections 1')
    expect(text).toContain('board_deltas_total')
    expect(text).toContain('board_delta_broadcast_seconds_bucket')
    expect(text).toContain('board_storage_errors_total')
    expect(text).toContain('board_outbox_size{quantile="0.95"}')
  })

  it('healthz и readyz отвечают и по внешнему пути маршрута', async () => {
    await serve()
    const { port } = service!.server.address() as AddressInfo

    expect(await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()).toBe('ok')
    expect((await fetch(`http://127.0.0.1:${port}/board-ws/readyz`)).status).toBe(200)
  })
})
