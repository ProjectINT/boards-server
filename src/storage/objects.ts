// Документ доски в Supabase Storage: `board-docs/<boardId>/doc.json.gz`
// (§8 плана репозитория, osn§8).
//
// Формат — та же сцена Excalidraw, что лежала в `board_snapshots`, только
// сжатая gzip: JSON доски жмётся в 5–10 раз, и объект получается на несколько
// килобайт вместо десятков. Сцену собирает `sceneBytes` конкатенацией сырых
// тел элементов — `JSON.stringify` документа здесь не вызывается ни разу, ради
// этого Ф2 и хранила элементы буферами.
//
// **`If-Match` на записи не работает.** Ф0 проверила на боевой установке
// (storage-api 1.22.7): заголовок молча игнорируется и `POST`, и `PUT`,
// чужой ETag не даёт 412 — см. журнал Ф0 в
// docs/PLAN_BOARD_SERVER_PHASES_2026-09-16.md, раздел «Вердикт по If-Match».
// Значит, защита от двух инстансов, открывших одну комнату, остаётся **только
// маршрутизацией**: комната живёт на одном узле, и второй узел с той же доской
// перезапишет чужую запись целиком. Условное чтение (`If-None-Match` → 304)
// storage-api поддерживает, из него можно собрать детектор чужой записи, но не
// защиту, — если инстансов станет больше одного, это отдельная задача.

import { promisify } from 'node:util'
import { gunzip, gzip } from 'node:zlib'

import { docFromScene, sceneBytes } from '../core/doc.js'
import type { BoardDoc, BoardId, BoardScene } from '../core/types.js'
import { storageErrorsTotal } from '../metrics.js'
import { SupabaseError, request } from './http.js'
import type { Supabase } from './http.js'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

/**
 * Пропавший объект storage-api отдаёт **400**, а не 404: тело при этом
 * `{"statusCode":"404","error":"not_found","message":"Object not found"}`
 * (проверено в Ф5 запросом к боевой установке). Поэтому «нет объекта» ищется в
 * теле, а не по номеру ответа: принять любой 400 за пустую доску нельзя — это
 * ровно тот случай, когда комната поднялась бы пустой и первой же записью
 * затёрла настоящий документ.
 */
function isMissing(status: number, body: string): boolean {
  if (status === 404) return true
  if (status !== 400) return false

  return body.includes('"not_found"') || body.includes('Object not found')
}

export class BoardObjects {
  readonly #api: Supabase
  readonly #bucket: string

  constructor(api: Supabase, bucket: string) {
    this.#api = api
    this.#bucket = bucket
  }

  #path(boardId: BoardId): string {
    return `/storage/v1/object/${this.#bucket}/${encodeURIComponent(boardId)}/doc.json.gz`
  }

  /** Документ доски; `null` — объекта ещё нет, дальше пробуется наследие. */
  async load(boardId: BoardId, now: number): Promise<BoardDoc | null> {
    const response = await request(this.#api, 'object-get', this.#path(boardId), {
      allow: [400, 404],
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      if (isMissing(response.status, body)) return null

      storageErrorsTotal.inc({ op: 'object-get' })
      throw new SupabaseError('object-get', response.status, body.slice(0, 500))
    }

    // Битый объект — это исключение, а не пустая доска: пустой документ
    // отсюда означал бы, что следующая запись затрёт всё, что не прочиталось.
    const scene = JSON.parse((await gunzipAsync(Buffer.from(await response.arrayBuffer()))).toString('utf8')) as BoardScene

    return docFromScene(scene, now)
  }

  /** Возвращает размер записанного объекта — он же в логе и в отчёте. */
  async save(boardId: BoardId, doc: BoardDoc): Promise<number> {
    // `sceneBytes` снимает состояние документа синхронно, до первого await:
    // всё, что приедет в комнату во время запроса, в этот объект уже не
    // попадёт, и `rooms.ts` оставляет комнату грязной именно по этому признаку.
    const body = await gzipAsync(sceneBytes(doc))

    await request(this.#api, 'object-put', this.#path(boardId), {
      method: 'POST',
      headers: {
        'x-upsert': 'true',
        'content-type': 'application/gzip',
        // Объект перезаписывается каждые несколько секунд; закешированная
        // копия за шлюзом означала бы, что перезапуск поднимает вчерашнюю доску.
        'cache-control': 'no-cache',
      },
      body,
    })

    return body.length
  }
}
