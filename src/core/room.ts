// Комната как чистая функция (§6 плана репозитория, osn§6, osn§9).
//
// Весь протокол живёт здесь, и здесь его можно проверить целиком: `step`
// получает событие и время параметром, возвращает новое состояние и список
// эффектов — и больше ничего. Ни `Date.now()`, ни `setTimeout`, ни `ws`, ни
// `Math.random()`: всё, что снаружи, — тонкая прослойка (Ф4), которая держит
// `Map<ConnId, WebSocket>`, крутит таймеры и исполняет эффекты.
//
// Ради этого всё и затевалось: отказы, из-за которых проект начали (потерянная
// правка, реконнект, дубль, переупорядочивание), воспроизводятся в тесте
// детерминированно, без сети и без таймингов — см. `test/protocol.test.ts`.
//
// «Чистая» здесь означает «без скрытых входов»: одно и то же состояние плюс
// одно и то же событие и `now` дают один и тот же результат. Состояние при
// этом меняется на месте, и возвращается тот же объект `room`: документ лежит
// в буферах (Ф2) именно для того, чтобы его не копировать, и копия комнаты на
// каждую дельту свела бы всю экономию памяти на нет.

import {
  applyAppState,
  applyElements,
  applyFiles,
  deltaFrame,
  diff,
  docBytes,
  emptyDoc,
  welcomeFrame,
} from './doc.js'
import { PROTOCOL_VERSION } from './types.js'
import type {
  AppStatePatch,
  BoardDoc,
  BoardId,
  BoardRole,
  ClientDeltaFrame,
  Claims,
  ConnId,
  FileId,
  FileRef,
  MemberInfo,
  RejectReason,
  StoredElement,
  ServerFrame,
  StateVector,
  SyncElement,
} from './types.js'

/**
 * Пределы, которые считаются в ядре. Кадр > 1 МБ и число соединений на `sub` —
 * не здесь: их видит транспорт (Ф4), ядро о размере кадра не знает.
 */
export interface RoomLimits {
  /** osn§6.4: сцена ≤ 10 МБ в JSON — тот же предел, что был у CHECK в базе. */
  sceneMaxBytes: number
  /** osn§6.4: inline-файл ≤ 128 КБ dataURL. */
  fileMaxBytes: number
  /** osn§6.4: курсор не чаще 30 мс на отправителя. */
  pointerMinIntervalMs: number
  /** osn§9: выселение пустой комнаты. */
  roomIdleMs: number
  /** osn§8: запись через 5 с тишины… */
  flushQuietMs: number
  /** …и не реже раза в 30 с при непрерывном рисовании. */
  flushMaxMs: number
}

export const DEFAULT_LIMITS: RoomLimits = {
  sceneMaxBytes: 10 * 1024 * 1024,
  fileMaxBytes: 128 * 1024,
  pointerMinIntervalMs: 30,
  roomIdleMs: 300_000,
  flushQuietMs: 5_000,
  flushMaxMs: 30_000,
}

/** Одно соединение. Несколько вкладок одного человека — несколько участников. */
export interface Member {
  conn: ConnId
  /** `claims.sub`: UUID пользователя либо `guest:<uuid>`; сервер не разбирает. */
  sub: string
  name: string
  role: BoardRole
  /** Когда последний курсор этого соединения ушёл в эфир (прореживание). */
  lastPointerAt: number
}

export interface Room {
  boardId: BoardId
  doc: BoardDoc
  /** Растёт на каждую дельту, которая что-то изменила. */
  seq: number
  members: Map<ConnId, Member>
  /** Есть правки, которых нет в Storage. Снимает `markFlushed` (Ф5). */
  dirty: boolean
  /** Эффект `flush` уже отдан и ответа на него ещё не было. */
  flushing: boolean
  /** `now` первой правки после последней записи — от неё считается потолок. */
  dirtySince: number
  /** `now` последней правки — от неё считается тишина. */
  lastChangeAt: number
  /** `now`, когда вышел последний участник; `null` — комната не пуста. */
  emptySince: number | null
  limits: RoomLimits
}

// ——— §6: события и эффекты ———

export type Event =
  | {
      t: 'join'
      conn: ConnId
      claims: Claims
      /**
       * Версия протокола из `hello`. Её нет в §6, но проверка версии по §15
       * должна жить в ядре: это защита от расхождения двух репозиториев, и
       * хочется, чтобы она была в том же тесте, что и остальной протокол.
       * Отсутствие поля считаем текущей версией — старый клиент его не слал.
       */
      v?: number
      vector: StateVector
      files: FileId[]
      outbox: ClientDeltaFrame[]
    }
  | { t: 'delta'; conn: ConnId; cseq: number; elements: SyncElement[]; files?: FileRef[] }
  | { t: 'pointer'; conn: ConnId; x: number; y: number }
  | { t: 'appState'; conn: ConnId; patch: AppStatePatch }
  | { t: 'leave'; conn: ConnId }
  | { t: 'tick' }

export type Effect =
  | { t: 'send'; to: ConnId; frame: Buffer }
  | { t: 'broadcast'; except: ConnId | null; frame: Buffer }
  | { t: 'close'; to: ConnId; code: number; reason: string }
  | { t: 'flush' }
  | { t: 'evict' }

/** Несовпадение версии протокола — ошибка протокола, а не политики. */
const CLOSE_BAD_VERSION = 1002

/**
 * `cseq` в `reject` на кадр, у которого своего номера нет (`hello`,
 * `appState`). Ноль клиент не спутает с дельтой: свои `cseq` он нумерует с 1.
 */
const NO_CSEQ = 0

/** `from` в кадре, который сочинила сама комната, а не участник. */
export const SERVER_AUTHOR = ''

export function createRoom(
  boardId: BoardId,
  doc: BoardDoc = emptyDoc(),
  now = 0,
  limits: RoomLimits = DEFAULT_LIMITS
): Room {
  return {
    boardId,
    doc,
    seq: 0,
    members: new Map(),
    dirty: false,
    flushing: false,
    dirtySince: now,
    lastChangeAt: now,
    // Комната рождается пустой, и если в неё никто не войдёт, её надо выселить
    // как любую другую опустевшую — отсюда отметка времени сразу.
    emptySince: now,
    limits,
  }
}

/** Мелкий кадр целиком: тел элементов в нём нет, `JSON.stringify` уместен. */
function frame(value: ServerFrame): Buffer {
  return Buffer.from(JSON.stringify(value))
}

/**
 * Список участников для `welcome` и `presence`. Соединения одного `sub`
 * схлопываются: две вкладки — это один человек, и показывать его в списке
 * дважды значит показывать неправду.
 */
function memberList(room: Room): MemberInfo[] {
  const seen = new Set<string>()
  const list: MemberInfo[] = []

  for (const member of room.members.values()) {
    if (seen.has(member.sub)) continue
    seen.add(member.sub)
    list.push({ userId: member.sub, name: member.name, role: member.role })
  }

  return list
}

function reject(to: ConnId, cseq: number, reason: RejectReason): Effect {
  return { t: 'send', to, frame: frame({ t: 'reject', cseq, reason }) }
}

function ack(to: ConnId, cseq: number, seq: number): Effect {
  return { t: 'send', to, frame: frame({ t: 'ack', cseq, seq }) }
}

/**
 * Поправка автору: текущие версии тех элементов, чьи правки проиграли. Уходит
 * обычным кадром `delta`, который клиент и так умеет применять; `from` пуст,
 * потому что кто поставил победившую версию, комната не помнит, да это и не
 * чужая правка, а ответ на свою.
 */
function pushCorrection(room: Room, member: Member, losers: readonly StoredElement[], effects: Effect[]): void {
  if (losers.length === 0) return

  effects.push({
    t: 'send',
    to: member.conn,
    frame: deltaFrame({ seq: room.seq, from: SERVER_AUTHOR, elements: losers, files: [] }),
  })
}

function markDirty(room: Room, now: number): void {
  if (!room.dirty) {
    room.dirty = true
    room.dirtySince = now
  }
  room.lastChangeAt = now
}

/**
 * Запись в Storage удалась (зовёт `rooms.ts` в Ф5). Это не событие `step`:
 * список событий зафиксирован в §6 как то, что приходит из сокета, а ответ
 * Storage приходит совсем с другой стороны.
 */
export function markFlushed(room: Room, now: number): Room {
  room.dirty = false
  room.flushing = false
  room.dirtySince = now

  return room
}

/**
 * Запись не удалась. `dirty` остаётся: по osn§8 комната с `dirty` не
 * выселяется до успешной записи, а повтор с задержкой заводит `rooms.ts`.
 */
export function markFlushFailed(room: Room): Room {
  room.flushing = false

  return room
}

/**
 * Элементы, которые пришли, но проиграли по LWW: комната знает их в другой
 * версии. Их нужно вернуть автору — `ack` говорит «комната на таком-то seq», а
 * не «твоё победило», и без поправки автор остался бы со своим телом навсегда.
 * Рассылать поправку остальным незачем: у них уже победитель.
 */
function losersOf(doc: BoardDoc, elements: readonly SyncElement[]): StoredElement[] {
  const losers: StoredElement[] = []
  const seen = new Set<string>()

  for (const el of elements) {
    if (typeof el?.id !== 'string' || seen.has(el.id)) continue

    const stored = doc.elements.get(el.id)
    if (!stored) continue
    if (stored.version === el.version && stored.versionNonce === el.versionNonce) continue

    seen.add(el.id)
    losers.push(stored)
  }

  return losers
}

/**
 * Дельта клиента — общий путь для кадра `delta` и для каждой дельты из
 * `outbox` в `hello`: на реконнекте досылается ровно то же, что не доехало, и
 * обрабатываться оно должно ровно так же.
 */
function applyClientDelta(
  room: Room,
  member: Member,
  cseq: number,
  elements: readonly SyncElement[],
  files: readonly FileRef[],
  now: number,
  effects: Effect[]
): void {
  // Право задаёт токен, а не интерфейс (osn§6.4): документ не трогаем, сокет
  // не закрываем — зритель остаётся в комнате и продолжает видеть чужие правки.
  if (member.role !== 'edit') {
    effects.push(reject(member.conn, cseq, 'view-only'))
    return
  }

  // Отдельной проверки на дубль здесь нет и не нужно: повторная дельта несёт те
  // же (version, versionNonce), по LWW не побеждает, `changed` выходит пустым —
  // и `seq` не двигается. Проверка по `cseq` была бы не только лишней, но и
  // вредной: она отбросила бы содержимое дельты, которая приехала позже своей
  // соседки, а не дубль.

  for (const file of files) {
    if (typeof file?.dataURL === 'string' && Buffer.byteLength(file.dataURL) > room.limits.fileMaxBytes) {
      effects.push(reject(member.conn, cseq, 'bad-file'))
      return
    }
  }

  // Оценка сверху: замена существующего элемента считается добавлением, потому
  // что размер старого тела здесь неизвестен. Промах — единицы килобайт на
  // пределе в 10 МБ, а считать точно значило бы искать каждый элемент в карте
  // до слияния. `docBytes` — проход по карте; если на тысячах элементов это
  // станет заметно, в комнате заводится счётчик, который ведёт `applyElements`.
  const incoming = Buffer.byteLength(JSON.stringify(elements))
  if (docBytes(room.doc) + incoming > room.limits.sceneMaxBytes) {
    effects.push(reject(member.conn, cseq, 'too-large'))
    return
  }

  const { changed } = applyElements(room.doc, elements, now)
  const { added } = applyFiles(room.doc, files, now)

  const losers = losersOf(room.doc, elements)

  // Дельта доехала, но всё в ней проиграло по LWW: `seq` — номер изменения
  // комнаты, а изменения не было. Автору уезжает поправка и подтверждение.
  if (changed.length === 0 && added.length === 0) {
    pushCorrection(room, member, losers, effects)
    effects.push(ack(member.conn, cseq, room.seq))
    return
  }

  room.seq += 1
  markDirty(room, now)

  effects.push({
    t: 'broadcast',
    except: member.conn,
    frame: deltaFrame({ seq: room.seq, from: member.sub, elements: changed, files: added }),
  })
  pushCorrection(room, member, losers, effects)
  effects.push(ack(member.conn, cseq, room.seq))
}

export function step(room: Room, event: Event, now: number): { room: Room; effects: Effect[] } {
  const effects: Effect[] = []

  switch (event.t) {
    case 'join': {
      // §15: клиент и сервер лежат в разных репозиториях и обновляются порознь.
      // Разошедшийся протокол лучше увидеть на входе, чем ловить потом в виде
      // «доска иногда не сходится».
      if ((event.v ?? PROTOCOL_VERSION) !== PROTOCOL_VERSION) {
        effects.push(reject(event.conn, NO_CSEQ, 'bad-version'))
        effects.push({ t: 'close', to: event.conn, code: CLOSE_BAD_VERSION, reason: 'bad-version' })
        break
      }

      const member: Member = {
        conn: event.conn,
        sub: event.claims.sub,
        name: event.claims.name,
        role: event.claims.role,
        lastPointerAt: Number.NEGATIVE_INFINITY,
      }

      room.members.set(event.conn, member)
      // Вход отменяет выселение: «обновил страницу» — обычная ситуация (osn§6.3).
      room.emptySince = null

      // Сначала outbox, потом welcome: иначе разница считалась бы по документу,
      // в котором ещё нет правок самого вошедшего, и он получил бы их обратно
      // устаревшими. Слияние идемпотентно (LWW), поэтому повторный вход с тем
      // же outbox ничего не портит.
      for (const delta of event.outbox ?? []) {
        applyClientDelta(room, member, delta.cseq, delta.elements ?? [], delta.files ?? [], now, effects)
      }

      const { elements, files } = diff(room.doc, event.vector ?? {}, event.files ?? [])

      effects.push({
        t: 'send',
        to: event.conn,
        frame: welcomeFrame({
          seq: room.seq,
          role: member.role,
          elements,
          files,
          appState: room.doc.appState,
          members: memberList(room),
        }),
      })
      effects.push({
        t: 'broadcast',
        except: event.conn,
        frame: frame({ t: 'presence', members: memberList(room) }),
      })
      break
    }

    case 'delta': {
      const member = room.members.get(event.conn)
      // Кадр от соединения, которого в комнате нет: первый кадр обязан быть
      // `hello`, за этим следит транспорт (Ф4). Здесь — просто молчим.
      if (!member) break

      applyClientDelta(room, member, event.cseq, event.elements ?? [], event.files ?? [], now, effects)
      break
    }

    case 'pointer': {
      const member = room.members.get(event.conn)
      if (!member) break

      // Прореживание считается от `now`, переданного снаружи: клиент может
      // врать про частоту, а ядро не имеет права смотреть на часы само.
      // Лишнее отбрасывается молча — курсор не подтверждают.
      if (now - member.lastPointerAt < room.limits.pointerMinIntervalMs) break

      member.lastPointerAt = now
      effects.push({
        t: 'broadcast',
        except: event.conn,
        frame: frame({ t: 'pointer', userId: member.sub, name: member.name, x: event.x, y: event.y }),
      })
      break
    }

    case 'appState': {
      const member = room.members.get(event.conn)
      if (!member) break

      // Настройки — часть общего документа, а не вид у себя в браузере:
      // зритель меняет их всем, и по той же причине, что и дельты, ему нельзя.
      // Своего `cseq` у кадра нет, поэтому в `reject` уезжает ноль.
      if (member.role !== 'edit') {
        effects.push(reject(event.conn, NO_CSEQ, 'view-only'))
        break
      }

      // Опоздавший патч проигрывает по LWW и не рассылается.
      if (!applyAppState(room.doc, event.patch, now)) break

      markDirty(room, now)
      // `seq` не двигаем: он нумерует поток элементов, по нему считается
      // разница на входе, а настроек в векторе состояния нет.
      effects.push({
        t: 'broadcast',
        except: event.conn,
        frame: frame({ t: 'appState', appState: room.doc.appState }),
      })
      break
    }

    case 'leave': {
      if (!room.members.delete(event.conn)) break

      effects.push({ t: 'broadcast', except: null, frame: frame({ t: 'presence', members: memberList(room) }) })

      if (room.members.size === 0) {
        room.emptySince = now
        // osn§8: запись обязательна при опустевшей комнате — ждать пяти секунд
        // тишины тут нечего, писать всё равно придётся перед выселением.
        if (room.dirty && !room.flushing) {
          room.flushing = true
          effects.push({ t: 'flush' })
        }
      }
      break
    }

    case 'tick': {
      // Политика записи osn§8: 5 с тишины либо потолок в 30 с, если рисуют не
      // переставая. Пока предыдущая запись не ответила, второй `flush` не
      // отдаём — иначе при медленном Storage их набежала бы очередь.
      if (room.dirty && !room.flushing) {
        const quiet = now - room.lastChangeAt >= room.limits.flushQuietMs
        const ceiling = now - room.dirtySince >= room.limits.flushMaxMs

        if (quiet || ceiling) {
          room.flushing = true
          effects.push({ t: 'flush' })
        }
      }

      // Выселение — только чистой комнаты: потерять несохранённое из-за
      // таймаута нельзя (osn§8, «комната с dirty не выселяется»).
      if (
        room.members.size === 0 &&
        room.emptySince !== null &&
        !room.dirty &&
        !room.flushing &&
        now - room.emptySince >= room.limits.roomIdleMs
      ) {
        effects.push({ t: 'evict' })
      }
      break
    }
  }

  return { room, effects }
}
