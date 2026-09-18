// Хранилище (Ф5): четыре запроса к Supabase, импорт наследия и политика записи
// в реестре комнат. Сети здесь нет — `fetch` подставлен, и каждый тест видит,
// куда, чем и с какими заголовками сервис пошёл бы на самом деле.

import { gunzipSync, gzipSync } from 'node:zlib'

import { beforeEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { docBytes, emptyDoc } from '../src/core/doc.js'
import { createRoom } from '../src/core/room.js'
import type { BoardScene, Claims, FileRef, SyncElement } from '../src/core/types.js'
import { RETRY_BASE_MS, Rooms } from '../src/rooms.js'
import { SupabaseError, createStorage } from '../src/storage/index.js'
import { INLINE_MAX_BYTES, decodeScene, hexToBytes } from '../src/storage/legacy.js'
import { memoryStorage } from './fixtures/storage.js'
import { HEAVY_BOARD, HEAVY_FILE, heavyScene } from './fixtures/heavy.js'
import legacyScene from './fixtures/legacy-scene.json' with { type: 'json' }

const BOARD = '11111111-1111-1111-1111-111111111111'

/** Дать очереди микрозадач доработать: запись в хранилище асинхронная. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))
const URL_BASE = 'https://supabase.test'
const KEY = 'service-role-ключ'

function config(env: Record<string, string> = {}) {
  return loadConfig({
    BOARD_SERVER_SECRET: 'kH3v9Qb2sX7dP0nL8xW4vT6hJ3cL9gZ0aE5uF1iO7pR=',
    SUPABASE_URL: URL_BASE,
    SUPABASE_SERVICE_ROLE_KEY: KEY,
    ALLOWED_ORIGINS: 'https://egesto.ru',
    ...env,
  })
}

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: Buffer | null
}

type Reply = { status: number; body?: Buffer | string; headers?: Record<string, string> }
type Handler = (call: Call) => Reply

/** `fetch`, который записывает запросы и отвечает тем, что дал тест. */
function recorder(handler: Handler) {
  const calls: Call[] = []

  const fetchImpl = (async (input: unknown, init: Record<string, unknown> = {}) => {
    const headers = Object.fromEntries(
      Object.entries((init.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])
    )
    const rawBody = init.body
    const call: Call = {
      url: String(input),
      method: String(init.method ?? 'GET'),
      headers,
      body: rawBody === undefined ? null : Buffer.from(rawBody as Uint8Array),
    }
    calls.push(call)

    const reply = handler(call)
    const body = typeof reply.body === 'string' ? Buffer.from(reply.body, 'utf8') : (reply.body ?? Buffer.alloc(0))

    // 204 и 304 тела не несут — `Response` с телом их не принимает.
    const empty = reply.status === 204 || reply.status === 304

    return new Response(empty ? null : body, { status: reply.status, headers: reply.headers })
  }) as typeof globalThis.fetch

  return { calls, fetchImpl }
}

/** Ответ storage-api на пропавший объект: 400 с телом `not_found`. */
const MISSING: Reply = {
  status: 400,
  body: '{"statusCode":"404","error":"not_found","message":"Object not found"}',
}

function snapshotRow(scene: BoardScene): Reply {
  const hex = '\\x' + Buffer.from(JSON.stringify(scene), 'utf8').toString('hex')

  return {
    status: 200,
    body: JSON.stringify([{ doc: hex, format: 'excalidraw-json' }]),
    headers: { 'content-type': 'application/json' },
  }
}

function scene(elements: SyncElement[], files: Record<string, FileRef> = {}): BoardScene {
  return {
    elements,
    appState: { theme: 'dark', viewBackgroundColor: '#121212', currentItemFontFamily: 6 },
    files,
  }
}

function element(id: string, version = 1, extra: Record<string, unknown> = {}): SyncElement {
  return { id, type: 'rectangle', x: 1, y: 2, version, versionNonce: version * 7, ...extra }
}

describe('objects: документ в Storage', () => {
  it('пишет gzip сцены по адресу board-docs/<id>/doc.json.gz', async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200, body: '{"Key":"board-docs/…"}' }))
    const storage = createStorage(config(), fetchImpl)

    const doc = emptyDoc(0)
    const room = createRoom(BOARD, doc, 0)
    room.doc.elements.set('a', { version: 1, versionNonce: 7, deleted: false, bytes: Buffer.from('{"id":"a"}') })

    const written = await storage.save(BOARD, room.doc)

    const call = calls[0]!
    expect(call.url).toBe(`${URL_BASE}/storage/v1/object/board-docs/${BOARD}/doc.json.gz`)
    expect(call.method).toBe('POST')
    expect(call.headers).toMatchObject({
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'x-upsert': 'true',
      'content-type': 'application/gzip',
    })
    expect(written).toBe(call.body!.length)
    // Именно gzip, а не голый JSON: 1f 8b — его сигнатура.
    expect(call.body!.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(JSON.parse(gunzipSync(call.body!).toString('utf8'))).toMatchObject({ elements: [{ id: 'a' }] })
  })

  it('round-trip: записанное читается обратно тем же документом', async () => {
    let stored: Buffer | null = null
    const { fetchImpl } = recorder((call) => {
      if (call.method === 'POST') {
        stored = call.body
        return { status: 200 }
      }

      return stored ? { status: 200, body: stored } : MISSING
    })
    const storage = createStorage(config(), fetchImpl)

    const source = docFrom(scene([element('a', 3), element('b', 5, { isDeleted: true })]))
    await storage.save(BOARD, source)
    const { doc: back, imported } = await storage.load(BOARD, 100)

    expect(imported).toBe(false)

    expect([...back.elements.keys()].sort()).toEqual(['a', 'b'])
    expect(back.elements.get('b')!.deleted).toBe(true)
    expect(back.appState.theme).toBe('dark')
    expect(back.appState.viewBackgroundColor).toBe('#121212')
  })

  it('If-Match на записи не шлётся: storage-api его игнорирует (вердикт Ф0)', async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 200 }))
    await createStorage(config(), fetchImpl).save(BOARD, emptyDoc(0))

    expect(Object.keys(calls[0]!.headers)).not.toContain('if-match')
  })

  it('чужая ошибка Storage не выдаётся за пустую доску', async () => {
    const { fetchImpl } = recorder(() => ({ status: 500, body: 'upstream connect error' }))
    const storage = createStorage(config(), fetchImpl)

    await expect(storage.load(BOARD, 0)).rejects.toBeInstanceOf(SupabaseError)
  })

  it('битый объект — тоже ошибка, а не пустая доска', async () => {
    const { fetchImpl } = recorder(() => ({ status: 200, body: Buffer.from('не gzip') }))

    await expect(createStorage(config(), fetchImpl).load(BOARD, 0)).rejects.toBeTruthy()
  })
})

describe('legacy: импорт из board_snapshots', () => {
  it('hex из PostgREST разбирается в сцену', () => {
    const hex = '\\x' + Buffer.from('{"elements":[],"appState":{}}', 'utf8').toString('hex')

    expect(hexToBytes(hex)).toEqual(new Uint8Array(Buffer.from('{"elements":[],"appState":{}}')))
    expect(decodeScene(hex, 'excalidraw-json')).toMatchObject({ elements: [] })
    // Колонка `format` заведена ради будущих форматов: чужой — не падение.
    expect(decodeScene(hex, 'yjs')).toBeNull()
  })

  it('настоящий снимок из прода открывается документом', async () => {
    const { calls, fetchImpl } = recorder((call) =>
      call.url.includes('/rest/v1/') ? snapshotRow(legacyScene as BoardScene) : MISSING
    )

    const { doc, imported } = await createStorage(config(), fetchImpl).load('3b184f44-2c3b-425e-8a92-999edd0cdd91', 42)

    expect(imported).toBe(true)

    expect(doc.elements.size).toBe(40)
    expect(doc.files.size).toBe(1)
    expect(doc.appState.currentItemFontFamily).toBe(6)

    const rest = calls[1]!
    expect(rest.url).toBe(
      `${URL_BASE}/rest/v1/board_snapshots?board_id=eq.3b184f44-2c3b-425e-8a92-999edd0cdd91` +
        '&select=doc,format&order=version.desc&limit=1'
    )
    expect(rest.headers).toMatchObject({ apikey: KEY, authorization: `Bearer ${KEY}` })
    // Картинка в этом снимке уже ссылкой — выгружать нечего.
    expect(calls).toHaveLength(2)
  })

  it('картинка на 1,3 МБ уезжает в egesto-public, в сцене остаётся ссылка', async () => {
    const source = heavyScene()
    const inlineBytes = Buffer.byteLength((source.files![HEAVY_FILE] as FileRef).dataURL!)
    expect(inlineBytes).toBeGreaterThan(INLINE_MAX_BYTES)

    const { calls, fetchImpl } = recorder((call) =>
      call.url.includes('/rest/v1/') ? snapshotRow(source) : call.method === 'POST' ? { status: 200 } : MISSING
    )

    const { doc } = await createStorage(config(), fetchImpl).load(HEAVY_BOARD, 0)

    const upload = calls.find((call) => call.url.includes('/egesto-public/'))!
    expect(upload.url).toBe(`${URL_BASE}/storage/v1/object/egesto-public/board-imports/${HEAVY_BOARD}/${HEAVY_FILE}`)
    expect(upload.method).toBe('POST')
    expect(upload.headers).toMatchObject({ 'x-upsert': 'true', 'content-type': 'image/png' })
    // В бакет уехали байты картинки, а не base64-строка.
    expect(upload.body!.subarray(1, 4).toString('ascii')).toBe('PNG')

    const file = JSON.parse(doc.files.get(HEAVY_FILE)!.toString('utf8')) as FileRef
    expect(file.dataURL).toBe(
      `${URL_BASE}/storage/v1/object/public/egesto-public/board-imports/${HEAVY_BOARD}/${HEAVY_FILE}`
    )
    expect(docBytes(doc)).toBeLessThan(2000)
    expect(docBytes(doc)).toBeLessThan(inlineBytes / 100)
  })

  it('неудачная выгрузка не срывает импорт: картинка остаётся в сцене', async () => {
    const source = heavyScene()
    const { fetchImpl } = recorder((call) =>
      call.url.includes('/rest/v1/')
        ? snapshotRow(source)
        : call.url.includes('/egesto-public/')
          ? { status: 503, body: 'bucket unavailable' }
          : MISSING
    )

    const { doc } = await createStorage(config(), fetchImpl).load(HEAVY_BOARD, 0)
    const file = JSON.parse(doc.files.get(HEAVY_FILE)!.toString('utf8')) as FileRef

    expect(file.dataURL!.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('доски нет ни в Storage, ни в снимках — комната поднимается пустой', async () => {
    const { fetchImpl } = recorder((call) =>
      call.url.includes('/rest/v1/') ? { status: 200, body: '[]' } : MISSING
    )

    const { doc, imported } = await createStorage(config(), fetchImpl).load(BOARD, 7)

    expect(doc.elements.size).toBe(0)
    expect(doc.updatedAt).toBe(7)
    // Пустую доску записывать нечем: объект появится с первой правкой.
    expect(imported).toBe(false)
  })

  it('после первой записи в Storage база по этой доске не читается', async () => {
    let stored: Buffer | null = null
    const { calls, fetchImpl } = recorder((call) => {
      if (call.url.includes('/rest/v1/')) return snapshotRow(scene([element('a')]))
      if (call.method === 'POST') {
        stored = call.body
        return { status: 200 }
      }

      return stored ? { status: 200, body: stored } : MISSING
    })
    const storage = createStorage(config(), fetchImpl)

    const first = await storage.load(BOARD, 0)
    expect(first.doc.elements.size).toBe(1)
    expect(first.imported).toBe(true)
    await storage.save(BOARD, first.doc)
    calls.length = 0

    const second = await storage.load(BOARD, 0)

    expect(second.doc.elements.size).toBe(1)
    expect(second.imported).toBe(false)
    expect(calls.map((call) => call.url)).toEqual([`${URL_BASE}/storage/v1/object/board-docs/${BOARD}/doc.json.gz`])
  })

  it('gzip пережил бы и чужой сжатый объект', async () => {
    const body = gzipSync(Buffer.from(JSON.stringify(scene([element('z', 9)]))))
    const { fetchImpl } = recorder(() => ({ status: 200, body }))

    const { doc } = await createStorage(config(), fetchImpl).load(BOARD, 0)

    expect(doc.elements.get('z')!.version).toBe(9)
  })
})

describe('boards: отметка активности', () => {
  it('PATCH boards с телом updated_at', async () => {
    const { calls, fetchImpl } = recorder(() => ({ status: 204 }))

    await createStorage(config(), fetchImpl).touch(BOARD)

    const call = calls[0]!
    expect(call.url).toBe(`${URL_BASE}/rest/v1/boards?id=eq.${BOARD}`)
    expect(call.method).toBe('PATCH')
    expect(call.headers).toMatchObject({
      apikey: KEY,
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    })
    expect(JSON.parse(call.body!.toString('utf8'))).toEqual({ updated_at: 'now' })
  })
})

describe('комната и хранилище', () => {
  const claims = (sub: string): Claims => ({ sub, board: BOARD, role: 'edit', name: sub, exp: 2_000_000_000 })

  let clock = 0
  const now = () => clock

  beforeEach(() => {
    clock = 0
  })

  function draw(rooms: Rooms, id = 'a', version = 1): void {
    rooms.dispatch(BOARD, { t: 'delta', conn: 'c1', cseq: version, elements: [element(id, version)], files: [] })
  }

  async function opened(storage = memoryStorage()) {
    const rooms = new Rooms({ now, storage, limits: { ...limits } })
    await rooms.open(BOARD)
    rooms.dispatch(BOARD, { t: 'join', conn: 'c1', claims: claims('tutor'), vector: {}, files: [], outbox: [] })

    return { rooms, storage }
  }

  const limits = {
    sceneMaxBytes: 10 * 1024 * 1024,
    fileMaxBytes: INLINE_MAX_BYTES,
    pointerMinIntervalMs: 30,
    roomIdleMs: 300_000,
    flushQuietMs: 5_000,
    flushMaxMs: 30_000,
  }

  it('комната поднимается документом из хранилища', async () => {
    const storage = memoryStorage({ [BOARD]: scene([element('a'), element('b')]) })
    const { rooms } = await opened(storage)

    expect(rooms.peek(BOARD)!.doc.elements.size).toBe(2)
    expect(storage.loads).toEqual([BOARD])
  })

  it('ошибка чтения не поднимает комнату пустой', async () => {
    const storage = memoryStorage()
    storage.failLoads = new Error('Storage недоступен')
    const rooms = new Rooms({ now, storage })

    await expect(rooms.open(BOARD)).rejects.toThrow('Storage недоступен')
    expect(rooms.has(BOARD)).toBe(false)
  })

  it('два входа подряд читают документ один раз', async () => {
    const storage = memoryStorage()
    const rooms = new Rooms({ now, storage })

    await Promise.all([rooms.open(BOARD), rooms.open(BOARD)])
    await rooms.open(BOARD)

    expect(storage.loads).toEqual([BOARD])
  })

  it('пять секунд тишины — и документ записан', async () => {
    const { rooms, storage } = await opened()
    draw(rooms)

    clock += limits.flushQuietMs - 1
    rooms.tick()
    expect(storage.saves).toEqual([])

    clock += 1
    rooms.tick()
    await settle()
    expect(storage.saves).toEqual([BOARD])
    expect(rooms.peek(BOARD)!.dirty).toBe(false)
  })

  it('ошибка записи оставляет dirty и откладывает повтор', async () => {
    const { rooms, storage } = await opened()
    storage.failSaves = new Error('502 Bad Gateway')
    draw(rooms)

    clock += limits.flushQuietMs
    rooms.tick()
    await settle()

    const room = rooms.peek(BOARD)!
    expect(storage.saves).toHaveLength(1)
    expect(room.dirty).toBe(true)
    expect(room.flushing).toBe(false)

    // Пока идёт задержка, повторов нет — иначе по лежащему Storage били бы раз
    // в секунду.
    clock += RETRY_BASE_MS - 1
    rooms.tick()
    await settle()
    expect(storage.saves).toHaveLength(1)

    clock += 1
    storage.failSaves = null
    rooms.tick()
    await settle()
    expect(storage.saves).toHaveLength(2)
    expect(room.dirty).toBe(false)
  })

  it('задержка повтора удваивается', async () => {
    const { rooms, storage } = await opened()
    storage.failSaves = new Error('502')
    draw(rooms)

    clock += limits.flushQuietMs
    rooms.tick()
    await settle()
    clock += RETRY_BASE_MS
    rooms.tick()
    await settle()
    expect(storage.saves).toHaveLength(2)

    // Вторая неудача — вторая пауза вдвое длиннее первой.
    clock += RETRY_BASE_MS
    rooms.tick()
    await settle()
    expect(storage.saves).toHaveLength(2)

    clock += RETRY_BASE_MS
    rooms.tick()
    await settle()
    expect(storage.saves).toHaveLength(3)
  })

  it('грязная комната не выселяется', async () => {
    const { rooms, storage } = await opened()
    storage.failSaves = new Error('502')
    draw(rooms)
    rooms.dispatch(BOARD, { t: 'leave', conn: 'c1' })
    await settle()

    clock += limits.roomIdleMs + 1
    rooms.tick()
    await settle()

    expect(rooms.has(BOARD)).toBe(true)

    storage.failSaves = null
    clock += 300_000
    rooms.tick()
    await settle()
    rooms.tick()

    expect(rooms.has(BOARD)).toBe(false)
  })

  it('правка во время записи оставляет комнату грязной', async () => {
    const storage = memoryStorage()
    let release: (() => void) | null = null
    const slow = {
      ...storage,
      save: (boardId: string, doc: Parameters<typeof storage.save>[1]) =>
        new Promise<number>((resolve) => {
          release = () => void storage.save(boardId, doc).then(resolve)
        }),
    }
    const rooms = new Rooms({ now, storage: slow, limits })
    await rooms.open(BOARD)
    rooms.dispatch(BOARD, { t: 'join', conn: 'c1', claims: claims('tutor'), vector: {}, files: [], outbox: [] })

    draw(rooms, 'a', 1)
    clock += limits.flushQuietMs
    rooms.tick()

    // Запись ушла и ещё не вернулась — а на доске уже новый элемент.
    clock += 1
    draw(rooms, 'b', 2)
    release!()
    await settle()

    const room = rooms.peek(BOARD)!
    expect(room.dirty).toBe(true)
    expect(room.flushing).toBe(false)
  })

  it('опустевшая комната пишется сразу, а updated_at ставится при выселении', async () => {
    const { rooms, storage } = await opened()
    draw(rooms)
    rooms.dispatch(BOARD, { t: 'leave', conn: 'c1' })
    await settle()

    expect(storage.saves).toEqual([BOARD])
    expect(storage.touched).toEqual([])

    clock += limits.roomIdleMs + 1
    rooms.tick()
    await settle()

    expect(rooms.has(BOARD)).toBe(false)
    expect(storage.touched).toEqual([BOARD])
  })

  it('импортированная доска записывается в Storage без единой правки', async () => {
    const storage = memoryStorage({ [BOARD]: scene([element('a')]) })
    storage.importAll = true
    const { rooms } = await opened(storage)

    expect(rooms.peek(BOARD)!.dirty).toBe(true)

    clock += limits.flushQuietMs
    rooms.tick()
    await settle()

    expect(storage.saves).toEqual([BOARD])
    expect(rooms.peek(BOARD)!.dirty).toBe(false)
  })

  it('flushAll дописывает грязные комнаты и отмечает доски', async () => {
    const { rooms, storage } = await opened()
    draw(rooms)

    await rooms.flushAll()

    expect(storage.saves).toEqual([BOARD])
    expect(storage.touched).toEqual([BOARD])
    expect(rooms.peek(BOARD)!.dirty).toBe(false)
  })
})

/** Документ из сцены — короткая обёртка, чтобы тесты читались. */
function docFrom(source: BoardScene) {
  const doc = emptyDoc(0)
  for (const el of source.elements as SyncElement[]) {
    doc.elements.set(el.id, {
      version: el.version,
      versionNonce: el.versionNonce,
      deleted: el.isDeleted === true,
      bytes: Buffer.from(JSON.stringify(el)),
    })
  }
  doc.appState = {
    theme: source.appState.theme as string,
    viewBackgroundColor: source.appState.viewBackgroundColor as string,
    currentItemFontFamily: source.appState.currentItemFontFamily as number,
    updatedAt: 0,
  }

  return doc
}
