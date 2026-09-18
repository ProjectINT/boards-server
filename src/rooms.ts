// Реестр комнат: живое состояние вокруг чистой функции `step` (§6, §7 плана
// репозитория, osn§9).
//
// Ядро (`core/room.ts`) не знает ни про время, ни про сокеты: оно получает
// событие и `now`, возвращает состояние и список эффектов. Всё остальное —
// здесь и в `transport.ts`. Разделение проходит ровно по границе «что можно
// проверить без сети»:
//
//   rooms.ts    — карта досок, таймер `tick`, исполнение эффектов `flush` и
//                 `evict`, хранилище, часы;
//   transport.ts — сокеты и эффекты `send` / `broadcast` / `close`.
//
// Поэтому здесь нет ни одной проверки протокола: если кажется, что нужна, —
// это правка ядра, вместе с тестом в стиле Ф3.

import { docBytes, emptyDoc, tombstoneBytes } from './core/doc.js'
import { DEFAULT_LIMITS, createRoom, markFlushFailed, markFlushed, step } from './core/room.js'
import type { Effect, Event, Room, RoomLimits } from './core/room.js'
import type { BoardId, ConnId } from './core/types.js'
import type { Config } from './config.js'
import { log } from './log.js'
import { docBytes as docBytesGauge, roomsGauge, tombstoneBytes as tombstoneBytesGauge } from './metrics.js'
import type { BoardStorage } from './storage/index.js'

/**
 * Куда уходят эффекты, которым нужен сокет. Реализует `transport.ts`; в тестах
 * подставляется список.
 *
 * `droppable` — можно ли кадр потерять, если получатель не успевает читать
 * (osn§6.4: курсоры пропускаем, дельты ставим в очередь). Признак приходит
 * отсюда, а не из разбора кадра: реестр знает, какое событие он исполняет, и
 * все эффекты события `pointer` — курсоры.
 */
export interface EffectSink {
  send(conn: ConnId, frame: Buffer, droppable: boolean): void
  broadcast(room: Room, except: ConnId | null, frame: Buffer, droppable: boolean): void
  close(conn: ConnId, code: number, reason: string): void
}

/** Как часто крутится `tick`. Секунда — на порядок мельче `FLUSH_QUIET_MS`. */
export const DEFAULT_TICK_MS = 1_000

/**
 * Повтор неудачной записи: первая пауза и потолок (osn§8 — «экспоненциальная
 * задержка до 5 минут»). Пауза удваивается с каждой неудачей подряд и
 * сбрасывается первой успешной записью.
 *
 * Разброса (jitter) нет намеренно: у каждой комнаты своя отметка последней
 * правки, и запросы расходятся сами. Если Storage ляжет разом для всех, они
 * съедутся в один момент — но это сотня запросов раз в пять минут, а не
 * нагрузка, от которой стоит защищаться.
 */
export const RETRY_BASE_MS = 2_000
export const RETRY_MAX_MS = 300_000

export interface RoomsOptions {
  limits?: RoomLimits
  /** Часы. Параметр ради тестов: в бою — `Date.now`. */
  now?: () => number
  tickIntervalMs?: number
  /**
   * Хранилище. Без него реестр работает только в памяти: документ рождается
   * пустым, запись никуда не идёт. Так устроены тесты, которым Storage не
   * нужен; в бою `createService` передаёт настоящее.
   */
  storage?: BoardStorage
}

/** Пределы ядра из окружения: три из шести настраиваются (§9). */
export function limitsFrom(config: Config): RoomLimits {
  return {
    ...DEFAULT_LIMITS,
    roomIdleMs: config.roomIdleMs,
    flushQuietMs: config.flushQuietMs,
    flushMaxMs: config.flushMaxMs,
  }
}

/** Сколько весит документ комнаты; слагаемые метрик `board_*_bytes`. */
interface Weight {
  doc: number
  tombstone: number
}

interface Retry {
  attempts: number
  /** Раньше этого момента запись не повторяем. */
  nextAt: number
}

export class Rooms {
  readonly #rooms = new Map<BoardId, Room>()
  readonly #limits: RoomLimits
  readonly #now: () => number
  readonly #tickIntervalMs: number
  readonly #storage: BoardStorage | null
  /** Комнаты в процессе загрузки: второй вошедший ждёт тот же запрос. */
  readonly #loading = new Map<BoardId, Promise<Room>>()
  /** Идущие записи: `flushAll` дожидается их, а не запускает вторую. */
  readonly #saving = new Map<BoardId, Promise<void>>()
  readonly #retry = new Map<BoardId, Retry>()
  /** Доски, которым при закрытии комнаты нужен PATCH `updated_at`. */
  readonly #touched = new Set<BoardId>()
  readonly #weights = new Map<BoardId, Weight>()
  #sink: EffectSink | null = null
  #timer: NodeJS.Timeout | null = null

  constructor(options: RoomsOptions = {}) {
    this.#limits = options.limits ?? DEFAULT_LIMITS
    this.#now = options.now ?? Date.now
    this.#tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_MS
    this.#storage = options.storage ?? null
  }

  attach(sink: EffectSink): void {
    this.#sink = sink
  }

  get size(): number {
    return this.#rooms.size
  }

  has(boardId: BoardId): boolean {
    return this.#rooms.has(boardId)
  }

  /** Только для тестов и логов; обычный путь — `dispatch`. */
  peek(boardId: BoardId): Room | undefined {
    return this.#rooms.get(boardId)
  }

  /**
   * Комната под доску, при необходимости поднятая из хранилища. Асинхронная,
   * и поэтому вызывается не из `dispatch`, а до него — из `#hello`, который
   * всё равно ждёт проверки токена, и очередь кадров соединения его дожидается.
   *
   * Ошибку наружу отдаём как есть: по ней транспорт закрывает соединение, и
   * это единственный честный ответ. Комната, поднятая пустой из-за недоступного
   * Storage, первой же записью затёрла бы настоящий документ доски.
   */
  async open(boardId: BoardId): Promise<Room> {
    const existing = this.#rooms.get(boardId)
    if (existing) return existing

    const loading = this.#loading.get(boardId)
    if (loading) return loading

    const promise = this.#load(boardId).finally(() => {
      this.#loading.delete(boardId)
    })
    this.#loading.set(boardId, promise)

    return promise
  }

  async #load(boardId: BoardId): Promise<Room> {
    const loaded = this.#storage
      ? await this.#storage.load(boardId, this.#now())
      : { doc: emptyDoc(this.#now()), imported: false }

    // Пока шёл запрос, комнату мог поднять кто-то ещё — тогда живёт она, а
    // прочитанный документ выбрасывается: два документа на одну доску означали
    // бы разъехавшиеся комнаты.
    const existing = this.#rooms.get(boardId)
    if (existing) return existing

    const now = this.#now()
    const room = createRoom(boardId, loaded.doc, now, this.#limits)

    if (loaded.imported) {
      // Импорт — правка, которой нет в Storage: помечаем комнату грязной, и
      // обычная политика записи (`tick`) перекладывает снимок в объект. Без
      // этого доска читалась бы из `board_snapshots` при каждом открытии, а
      // тяжёлая картинка при каждом открытии выгружалась бы заново.
      room.dirty = true
      room.dirtySince = now
      room.lastChangeAt = now
    }

    this.#rooms.set(boardId, room)
    roomsGauge.set(this.#rooms.size)
    this.#measure(boardId, room)
    log.info(
      {
        board: boardId,
        rooms: this.#rooms.size,
        elements: loaded.doc.elements.size,
        files: loaded.doc.files.size,
        imported: loaded.imported,
      },
      'комната поднята'
    )

    return room
  }

  /**
   * Событие в комнату. Комнату поднимает только `open`: `join` приходит сюда
   * уже после него, остальные события — от участника живой комнаты.
   */
  dispatch(boardId: BoardId, event: Event): void {
    const room = this.#rooms.get(boardId)
    if (!room) {
      // Не «не может быть», а «сломан порядок вызовов»: молчать об этом нельзя,
      // клиент в такой комнате не получит `welcome` и будет ждать впустую.
      if (event.t === 'join') log.error({ board: boardId }, 'join без open: комната не поднята')

      return
    }

    this.#apply(boardId, room, event)
  }

  /** Проход по всем комнатам: политика записи и выселение (osn§8, osn§9). */
  tick(): void {
    for (const [boardId, room] of this.#rooms) {
      this.#apply(boardId, room, { t: 'tick' })
    }
  }

  start(): void {
    if (this.#timer) return

    this.#timer = setInterval(() => this.tick(), this.#tickIntervalMs)
    // Таймер не должен держать процесс живым: когда закрыты сокеты и HTTP,
    // сервису пора заканчиваться, а не крутить пустой реестр.
    this.#timer.unref()
  }

  stop(): void {
    if (!this.#timer) return

    clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * Запись всех грязных комнат — шаг остановки по SIGTERM (§7). Задержка
   * повтора здесь не соблюдается: это последняя возможность записать, и лучше
   * потратить один запрос впустую, чем потерять правки.
   */
  async flushAll(): Promise<void> {
    const pending: Promise<void>[] = []

    for (const [boardId, room] of this.#rooms) {
      if (room.dirty || this.#saving.has(boardId)) pending.push(this.#flush(boardId, room, true))
    }

    await Promise.all(pending)
    await Promise.all([...this.#touched].map((boardId) => this.#touch(boardId)))
  }

  #apply(boardId: BoardId, room: Room, event: Event): void {
    const { effects } = step(room, event, this.#now())
    if (effects.length === 0) return

    const sink = this.#sink
    const droppable = event.t === 'pointer'

    for (const effect of effects) {
      switch (effect.t) {
        case 'send':
          sink?.send(effect.to, effect.frame, droppable)
          break
        case 'broadcast':
          sink?.broadcast(room, effect.except, effect.frame, droppable)
          break
        case 'close':
          sink?.close(effect.to, effect.code, effect.reason)
          break
        case 'flush':
          // Эффект исполняется в фоне: `step` синхронный, а запись — сетевой
          // запрос. Ядро об этом знает — оно держит `flushing`, пока ответа нет.
          void this.#flush(boardId, room)
          break
        case 'evict':
          this.#evict(boardId)
          break
      }
    }
  }

  #flush(boardId: BoardId, room: Room, force = false): Promise<void> {
    const running = this.#saving.get(boardId)
    if (running) return running

    const retry = this.#retry.get(boardId)
    if (!force && retry && this.#now() < retry.nextAt) {
      // Storage не отвечает, пауза ещё не вышла. `flushing` при этом снимаем:
      // иначе ядро не отдаст следующий `flush`, и комната осталась бы грязной
      // навсегда. Сам повтор заведёт очередной `tick`.
      markFlushFailed(room)

      return Promise.resolve()
    }

    const promise = this.#save(boardId, room).finally(() => {
      this.#saving.delete(boardId)
    })
    this.#saving.set(boardId, promise)

    return promise
  }

  async #save(boardId: BoardId, room: Room): Promise<void> {
    const seq = room.seq
    // Сцена снимается в начале записи; всё, что приедет позже, в объект не
    // попадёт, и по этой отметке видно, случилось ли такое.
    const changedAt = room.lastChangeAt

    try {
      const bytes = this.#storage ? await this.#storage.save(boardId, room.doc) : 0

      markFlushed(room, this.#now())
      if (room.lastChangeAt !== changedAt) {
        // Пока шёл запрос, в комнату приехали правки: записанная сцена их не
        // содержит. Возвращаем комнату в грязное состояние — ровно то, что
        // делает `markDirty` в ядре, — и политика записи отсчитает паузу
        // заново от этой правки.
        room.dirty = true
        room.dirtySince = room.lastChangeAt
      }

      this.#retry.delete(boardId)
      this.#touched.add(boardId)
      this.#measure(boardId, room)
      log.debug({ board: boardId, seq, bytes }, 'документ записан')
    } catch (error) {
      // `dirty` остаётся: по osn§8 комната с несохранёнными правками не
      // выселяется, и потерять их таймаутом нельзя.
      markFlushFailed(room)

      const attempts = (this.#retry.get(boardId)?.attempts ?? 0) + 1
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS)
      this.#retry.set(boardId, { attempts, nextAt: this.#now() + delay })

      log.error({ board: boardId, seq, attempts, retryInMs: delay, err: error }, 'запись документа не удалась')
    }
  }

  #evict(boardId: BoardId): void {
    if (!this.#rooms.delete(boardId)) return

    this.#retry.delete(boardId)
    this.#weights.delete(boardId)
    roomsGauge.set(this.#rooms.size)
    this.#publish()
    log.info({ board: boardId, rooms: this.#rooms.size }, 'комната выселена')

    // Отметка активности — на закрытии комнаты, а не на каждой записи: списку
    // кабинета хватает точности «доску сегодня открывали», а UPDATE раз в пять
    // секунд на доску база бы заметила.
    void this.#touch(boardId)
  }

  async #touch(boardId: BoardId): Promise<void> {
    if (!this.#touched.delete(boardId)) return
    if (!this.#storage) return

    try {
      await this.#storage.touch(boardId)
    } catch (error) {
      // Порядок досок в списке — не та потеря, ради которой стоит что-то
      // повторять: следующее занятие на этой доске отметку поправит.
      log.warn({ board: boardId, err: error }, 'updated_at доски не обновлён')
    }
  }

  #measure(boardId: BoardId, room: Room): void {
    this.#weights.set(boardId, { doc: docBytes(room.doc), tombstone: tombstoneBytes(room.doc) })
    this.#publish()
  }

  /**
   * Метрики размеров — сумма по комнатам. Считается по карте чисел, а не
   * обходом документов: обход всех элементов всех комнат на каждой записи стоил
   * бы дороже самой записи.
   */
  #publish(): void {
    let doc = 0
    let tombstone = 0

    for (const weight of this.#weights.values()) {
      doc += weight.doc
      tombstone += weight.tombstone
    }

    docBytesGauge.set(doc)
    tombstoneBytesGauge.set(tombstone)
  }
}
