// Сценарии протокола поимённо (osn§6.3) и отказы, которые воспроизводятся без
// сети (osn§10). Случайные прогоны — в `protocol.test.ts`; здесь каждый
// сценарий назван и проверен отдельно, чтобы по красному тесту было видно, что
// именно сломалось.

import { describe, expect, it } from 'vitest'

import { emptyDoc } from '../src/core/doc.js'
import { DEFAULT_LIMITS, createRoom, markFlushed, step } from '../src/core/room.js'
import type { Effect, Event, Room } from '../src/core/room.js'
import type { BoardRole, Claims, ConnId, FileRef, SyncElement } from '../src/core/types.js'

const BOARD = '11111111-1111-1111-1111-111111111111'

function claims(sub: string, role: BoardRole = 'edit'): Claims {
  return { sub, board: BOARD, role, name: `имя-${sub}`, exp: 2_000_000_000 }
}

function element(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): SyncElement {
  return { id, type: 'rectangle', x: 0, y: 0, version, versionNonce, ...extra }
}

function file(id: string, bytes = 16): FileRef {
  return { id, mimeType: 'image/png', dataURL: `data:image/png;base64,${'A'.repeat(bytes)}` }
}

type Frame = Record<string, unknown>

function parse(frame: Buffer): Frame {
  return JSON.parse(frame.toString('utf8')) as Frame
}

/** Кадры, ушедшие лично этому соединению. */
function sentTo(effects: readonly Effect[], to: ConnId): Frame[] {
  return effects.filter((e) => e.t === 'send' && e.to === to).map((e) => parse((e as { frame: Buffer }).frame))
}

/** Кадры, ушедшие в рассылку (всем, кроме указанного). */
function broadcast(effects: readonly Effect[]): Frame[] {
  return effects.filter((e) => e.t === 'broadcast').map((e) => parse((e as { frame: Buffer }).frame))
}

function join(
  room: Room,
  conn: ConnId,
  sub: string,
  now: number,
  extra: Partial<Extract<Event, { t: 'join' }>> = {}
): Effect[] {
  return step(
    room,
    { t: 'join', conn, claims: claims(sub, extra.claims?.role ?? 'edit'), vector: {}, files: [], outbox: [], ...extra },
    now
  ).effects
}

function delta(
  room: Room,
  conn: ConnId,
  cseq: number,
  elements: SyncElement[],
  now: number,
  files: FileRef[] = []
): Effect[] {
  return step(room, { t: 'delta', conn, cseq, elements, files }, now).effects
}

describe('вход', () => {
  it('пустой вектор отдаёт всю сцену', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 1, 10), element('b', 1, 11)], 20)

    const welcome = sentTo(join(room, 'c2', 'student', 30), 'c2')[0]!

    expect(welcome.t).toBe('welcome')
    expect(welcome.seq).toBe(1)
    expect(welcome.role).toBe('edit')
    expect((welcome.elements as SyncElement[]).map((el) => el.id).sort()).toEqual(['a', 'b'])
    expect(welcome.members).toEqual([
      { userId: 'tutor', name: 'имя-tutor', role: 'edit' },
      { userId: 'student', name: 'имя-student', role: 'edit' },
    ])
  })

  it('реконнект с частичным вектором отдаёт только разницу', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 5, 10), element('b', 2, 11), element('c', 1, 12)], 20)

    // Клиент знает `a` устаревшей версии, `b` — текущей, про `c` не знает вовсе.
    const welcome = sentTo(join(room, 'c2', 'student', 30, { vector: { a: 4, b: 2 } }), 'c2')[0]!

    expect((welcome.elements as SyncElement[]).map((el) => el.id).sort()).toEqual(['a', 'c'])
  })

  it('удалённый элемент доезжает до опоздавшего надгробием', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 1, 10)], 20)
    delta(room, 'c1', 2, [element('a', 2, 11, { isDeleted: true })], 30)

    const welcome = sentTo(join(room, 'c2', 'student', 40, { vector: { a: 1 } }), 'c2')[0]!
    const [tombstone] = welcome.elements as SyncElement[]

    expect(tombstone).toMatchObject({ id: 'a', version: 2, isDeleted: true })
  })

  it('файлы отдаются только те, которых у клиента нет', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 1, 10)], 20, [file('f1'), file('f2')])

    const welcome = sentTo(join(room, 'c2', 'student', 30, { files: ['f1'] }), 'c2')[0]!

    expect((welcome.files as FileRef[]).map((f) => f.id)).toEqual(['f2'])
  })

  it('outbox из hello сливается, рассылается соседу и подтверждается', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)

    const effects = join(room, 'c2', 'student', 20, {
      outbox: [{ t: 'delta', cseq: 7, elements: [element('a', 3, 10)] }],
    })

    expect(broadcast(effects).map((f) => f.t)).toEqual(['delta', 'presence'])
    expect(sentTo(effects, 'c2').map((f) => f.t)).toEqual(['ack', 'welcome'])
    expect(sentTo(effects, 'c2')[0]).toEqual({ t: 'ack', cseq: 7, seq: 1 })
    expect(room.doc.elements.has('a')).toBe(true)
  })

  it('повторный вход с тем же outbox ничего не меняет второй раз', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    const outbox = [{ t: 'delta' as const, cseq: 7, elements: [element('a', 3, 10)] }]

    join(room, 'c1', 'tutor', 10, { outbox })
    const seqAfterFirst = room.seq
    const effects = join(room, 'c2', 'tutor', 20, { outbox })

    expect(room.seq).toBe(seqAfterFirst)
    expect(broadcast(effects).map((f) => f.t)).toEqual(['presence'])
  })

  it('чужая версия протокола — reject и закрытие, участника в комнате нет', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)

    const effects = join(room, 'c1', 'tutor', 10, { v: 2 })

    expect(sentTo(effects, 'c1')).toEqual([{ t: 'reject', cseq: 0, reason: 'bad-version' }])
    expect(effects.at(-1)).toEqual({ t: 'close', to: 'c1', code: 1002, reason: 'bad-version' })
    expect(room.members.size).toBe(0)
  })

  it('две вкладки одного человека — один участник в presence', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    const effects = join(room, 'c2', 'tutor', 20)

    expect(room.members.size).toBe(2)
    expect(broadcast(effects)[0]!.members).toEqual([{ userId: 'tutor', name: 'имя-tutor', role: 'edit' }])
  })
})

describe('правка', () => {
  it('дельта двигает seq, уходит соседям и подтверждается автору', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    join(room, 'c2', 'student', 20)

    const effects = delta(room, 'c1', 1, [element('a', 1, 10)], 30)
    const out = effects.find((e) => e.t === 'broadcast') as { except: ConnId | null; frame: Buffer }

    expect(room.seq).toBe(1)
    expect(out.except).toBe('c1')
    expect(parse(out.frame)).toMatchObject({ t: 'delta', seq: 1, from: 'tutor' })
    expect(sentTo(effects, 'c1')).toEqual([{ t: 'ack', cseq: 1, seq: 1 }])
  })

  it('дубль дельты с тем же cseq не двигает seq дважды', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)

    delta(room, 'c1', 1, [element('a', 1, 10)], 20)
    const repeat = delta(room, 'c1', 1, [element('a', 1, 10)], 30)

    expect(room.seq).toBe(1)
    expect(broadcast(repeat)).toEqual([])
    // Дубль отсекается самим слиянием: те же (version, versionNonce) по LWW не
    // побеждают, менять нечего. `ack` при этом повторяется — пропасть мог
    // именно он, а клиент ждёт его, чтобы очистить outbox.
    expect(sentTo(repeat, 'c1')).toEqual([{ t: 'ack', cseq: 1, seq: 1 }])
  })

  it('переупорядочивание: опоздавшая старая правка не откатывает новую', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)

    delta(room, 'c1', 1, [element('a', 5, 10, { text: 'новое' })], 20)
    const late = delta(room, 'c1', 2, [element('a', 2, 99, { text: 'старое' })], 30)

    expect(room.seq).toBe(1)
    expect(broadcast(late)).toEqual([])
    expect(sentTo(late, 'c1').map((f) => f.t)).toEqual(['delta', 'ack'])
    expect(JSON.parse(room.doc.elements.get('a')!.bytes.toString('utf8'))).toMatchObject({ text: 'новое' })
  })

  it('проигравшему автору возвращается версия комнаты', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    join(room, 'c2', 'student', 20)

    // Оба правили один элемент от одной базы: версии равны, разводит нонс.
    delta(room, 'c2', 1, [element('a', 5, 900, { text: 'от ученика' })], 30)
    const effects = delta(room, 'c1', 1, [element('a', 5, 100, { text: 'от репетитора' })], 40)

    // Рассылать нечего: у соседа уже победитель.
    expect(broadcast(effects)).toEqual([])

    const [correction, confirmation] = sentTo(effects, 'c1')
    expect(correction).toMatchObject({ t: 'delta', seq: 1, from: '' })
    expect((correction!.elements as SyncElement[])[0]).toMatchObject({ versionNonce: 900, text: 'от ученика' })
    expect(confirmation).toEqual({ t: 'ack', cseq: 1, seq: 1 })
  })

  it('поправка уезжает и когда часть дельты прошла', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    join(room, 'c2', 'student', 20)
    delta(room, 'c2', 1, [element('a', 5, 900)], 30)

    const effects = delta(room, 'c1', 1, [element('a', 5, 100), element('b', 1, 7)], 40)

    expect(broadcast(effects).map((f) => (f.elements as SyncElement[]).map((el) => el.id))).toEqual([['b']])
    expect(sentTo(effects, 'c1').map((f) => f.t)).toEqual(['delta', 'ack'])
  })

  it('потерянная дельта доезжает до соседа на реконнекте автора', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    join(room, 'c2', 'student', 20)

    // Кадр до сервера не доехал — комната о правке не знает.
    step(room, { t: 'leave', conn: 'c1' }, 30)
    expect(room.doc.elements.size).toBe(0)

    const effects = join(room, 'c1-2', 'tutor', 40, {
      outbox: [{ t: 'delta', cseq: 1, elements: [element('a', 1, 10)] }],
    })
    const out = effects.find((e) => e.t === 'broadcast') as { except: ConnId | null; frame: Buffer }

    expect(parse(out.frame)).toMatchObject({ t: 'delta', from: 'tutor' })
    expect(room.doc.elements.has('a')).toBe(true)
  })

  it('роль view получает reject и остаётся подключённой', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'guest:1', 10, { claims: claims('guest:1', 'view') })

    const effects = delta(room, 'c1', 1, [element('a', 1, 10)], 20)

    expect(sentTo(effects, 'c1')).toEqual([{ t: 'reject', cseq: 1, reason: 'view-only' }])
    expect(effects.some((e) => e.t === 'close')).toBe(false)
    expect(room.members.has('c1')).toBe(true)
    expect(room.doc.elements.size).toBe(0)
    expect(room.dirty).toBe(false)
  })

  it('сцена больше 10 МБ — reject too-large, документ не меняется', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)

    const huge = element('a', 1, 10, { text: 'я'.repeat(DEFAULT_LIMITS.sceneMaxBytes) })
    const effects = delta(room, 'c1', 1, [huge], 20)

    expect(sentTo(effects, 'c1')).toEqual([{ t: 'reject', cseq: 1, reason: 'too-large' }])
    expect(room.doc.elements.size).toBe(0)
  })

  it('inline-файл больше 128 КБ — reject bad-file, элементы тоже не применяются', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)

    const effects = delta(room, 'c1', 1, [element('a', 1, 10)], 20, [
      file('f1', DEFAULT_LIMITS.fileMaxBytes + 1),
    ])

    expect(sentTo(effects, 'c1')).toEqual([{ t: 'reject', cseq: 1, reason: 'bad-file' }])
    expect(room.doc.elements.size).toBe(0)
    expect(room.doc.files.size).toBe(0)
  })

  it('кадр от неизвестного соединения молча игнорируется', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)

    expect(delta(room, 'c1', 1, [element('a', 1, 10)], 20)).toEqual([])
    expect(step(room, { t: 'pointer', conn: 'c1', x: 1, y: 2 }, 20).effects).toEqual([])
  })
})

describe('курсор', () => {
  it('прореживается до 30 мс на отправителя', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 0)

    const first = step(room, { t: 'pointer', conn: 'c1', x: 1, y: 1 }, 100).effects
    const tooSoon = step(room, { t: 'pointer', conn: 'c1', x: 2, y: 2 }, 120).effects
    const later = step(room, { t: 'pointer', conn: 'c1', x: 3, y: 3 }, 130).effects

    expect(parse((first[0] as { frame: Buffer }).frame)).toEqual({
      t: 'pointer',
      userId: 'tutor',
      name: 'имя-tutor',
      x: 1,
      y: 1,
    })
    expect(tooSoon).toEqual([])
    expect(later).toHaveLength(1)
  })

  it('курсор не делает комнату грязной', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 0)
    step(room, { t: 'pointer', conn: 'c1', x: 1, y: 1 }, 100)

    expect(room.dirty).toBe(false)
  })
})

describe('настройки доски', () => {
  it('патч применяется, рассылается остальным и не двигает seq', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)

    const effects = step(room, { t: 'appState', conn: 'c1', patch: { theme: 'dark' } }, 20).effects

    expect(room.seq).toBe(0)
    expect(room.dirty).toBe(true)
    expect(broadcast(effects)).toEqual([{ t: 'appState', appState: { theme: 'dark', updatedAt: 20 } }])
  })

  it('опоздавший патч проигрывает по LWW и не рассылается', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    step(room, { t: 'appState', conn: 'c1', patch: { theme: 'dark' } }, 30)

    const late = step(room, { t: 'appState', conn: 'c1', patch: { theme: 'light' } }, 20).effects

    expect(late).toEqual([])
    expect(room.doc.appState.theme).toBe('dark')
  })

  it('роль view настройки менять не может', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'guest:1', 10, { claims: claims('guest:1', 'view') })

    const effects = step(room, { t: 'appState', conn: 'c1', patch: { theme: 'dark' } }, 20).effects

    expect(effects).toEqual([{ t: 'send', to: 'c1', frame: expect.any(Buffer) }])
    expect(sentTo(effects, 'c1')).toEqual([{ t: 'reject', cseq: 0, reason: 'view-only' }])
    expect(room.doc.appState.theme).toBeUndefined()
  })
})

describe('выход и жизненный цикл', () => {
  it('выход рассылает presence оставшимся', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    join(room, 'c2', 'student', 20)

    const effects = step(room, { t: 'leave', conn: 'c2' }, 30).effects

    expect(effects).toHaveLength(1)
    expect(broadcast(effects)).toEqual([
      { t: 'presence', members: [{ userId: 'tutor', name: 'имя-tutor', role: 'edit' }] },
    ])
  })

  it('уход последнего с несохранённым — сразу flush', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 1, 10)], 20)

    const effects = step(room, { t: 'leave', conn: 'c1' }, 30).effects

    expect(effects.some((e) => e.t === 'flush')).toBe(true)
    expect(room.emptySince).toBe(30)
  })

  it('пустая и чистая комната выселяется через ROOM_IDLE_MS', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    step(room, { t: 'leave', conn: 'c1' }, 20)

    const early = step(room, { t: 'tick' }, 20 + DEFAULT_LIMITS.roomIdleMs - 1).effects
    const late = step(room, { t: 'tick' }, 20 + DEFAULT_LIMITS.roomIdleMs).effects

    expect(early).toEqual([])
    expect(late).toEqual([{ t: 'evict' }])
  })

  it('грязная комната не выселяется, пока запись не подтвердили', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 1, 10)], 20)
    step(room, { t: 'leave', conn: 'c1' }, 30)

    const idle = 30 + DEFAULT_LIMITS.roomIdleMs
    expect(step(room, { t: 'tick' }, idle).effects).toEqual([])

    markFlushed(room, idle)
    expect(step(room, { t: 'tick' }, idle).effects).toEqual([{ t: 'evict' }])
  })

  it('вход отменяет выселение', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    step(room, { t: 'leave', conn: 'c1' }, 20)
    join(room, 'c2', 'student', 30)

    expect(room.emptySince).toBeNull()
    expect(step(room, { t: 'tick' }, 30 + DEFAULT_LIMITS.roomIdleMs).effects).toEqual([])
  })
})

describe('политика записи', () => {
  it('5 секунд тишины — flush', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 10)
    delta(room, 'c1', 1, [element('a', 1, 10)], 1_000)

    expect(step(room, { t: 'tick' }, 1_000 + DEFAULT_LIMITS.flushQuietMs - 1).effects).toEqual([])
    expect(step(room, { t: 'tick' }, 1_000 + DEFAULT_LIMITS.flushQuietMs).effects).toEqual([{ t: 'flush' }])
  })

  it('непрерывное рисование — flush по потолку в 30 секунд', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 0)

    let effects: Effect[] = []
    // Правка каждую секунду: тишина в 5 с не наступает ни разу.
    for (let i = 1; i <= 40; i++) {
      delta(room, 'c1', i, [element(`e${i}`, 1, i)], i * 1_000)
      effects = effects.concat(step(room, { t: 'tick' }, i * 1_000 + 1).effects)
    }

    expect(effects.filter((e) => e.t === 'flush')).toHaveLength(1)
    expect(room.dirtySince).toBe(1_000)
  })

  it('второй flush не отдаётся, пока не ответили на первый', () => {
    const room = createRoom(BOARD, emptyDoc(), 0)
    join(room, 'c1', 'tutor', 0)
    delta(room, 'c1', 1, [element('a', 1, 10)], 1_000)

    const at = 1_000 + DEFAULT_LIMITS.flushQuietMs
    expect(step(room, { t: 'tick' }, at).effects).toEqual([{ t: 'flush' }])
    expect(step(room, { t: 'tick' }, at + 1_000).effects).toEqual([])

    markFlushed(room, at + 1_000)
    delta(room, 'c1', 2, [element('b', 1, 11)], at + 2_000)

    expect(step(room, { t: 'tick' }, at + 2_000 + DEFAULT_LIMITS.flushQuietMs).effects).toEqual([{ t: 'flush' }])
  })
})
