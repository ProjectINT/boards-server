// Импорт наследия: последняя строка `board_snapshots` (§8 плана репозитория,
// osn§8).
//
// До board-server доску сохранял сам клиент — строкой в `board_snapshots`, где
// сцена лежит в колонке `doc` типа bytea. PostgREST отдаёт bytea hex-строкой
// `\x…`, поэтому путь тот же, каким доска читалась на странице комнаты:
// hex → UTF-8 → `JSON.parse` → `BoardScene`. `hexToBytes` и `decodeScene`
// **переехали** сюда из `~/egeapp/lib/boardSnapshot.ts` (§16, вопрос 7: копия
// живёт только у `boardSync.ts`, у остального дублировать нечего — на сайте
// они останутся до уборки в Ф11).
//
// Читается снимок ровно один раз за жизнь доски: после первой успешной записи
// в Storage объект `doc.json.gz` есть, и до PostgREST дело больше не доходит.
// Таблица остаётся read-only архивом (osn§8, решение по osn§15).

import { docFromScene } from '../core/doc.js'
import { DEFAULT_LIMITS } from '../core/room.js'
import type { BoardDoc, BoardId, BoardScene, FileRef } from '../core/types.js'
import { log } from '../log.js'
import { request } from './http.js'
import type { Supabase } from './http.js'

const HEX_PREFIX = '\\x'

/**
 * Порог выгрузки inline-файла. Тот же, что `fileMaxBytes` у комнаты: файл
 * крупнее клиент прислать уже не может (osn§6.4), и импортированная доска не
 * должна оказаться тяжелее того, что комната согласна принять.
 */
export const INLINE_MAX_BYTES = DEFAULT_LIMITS.fileMaxBytes

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith(HEX_PREFIX) ? hex.slice(HEX_PREFIX.length) : hex
  const out = new Uint8Array(body.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16)
  }

  return out
}

/**
 * Снимок в сцену. `null`, если формат не читается: доска тогда откроется
 * пустой, но сервис не упадёт — колонка `format` заведена ровно ради этого.
 */
export function decodeScene(doc: string, format: string): BoardScene | null {
  if (format !== 'excalidraw-json') return null

  try {
    const parsed = JSON.parse(new TextDecoder().decode(hexToBytes(doc))) as BoardScene

    return Array.isArray(parsed?.elements) ? parsed : null
  } catch {
    return null
  }
}

interface DataUrl {
  mimeType: string
  bytes: Buffer
}

/** `data:image/png;base64,iVBOR…` → тип и байты. `null` — не base64-dataURL. */
function decodeDataUrl(value: string): DataUrl | null {
  const comma = value.indexOf(',')
  if (comma < 0) return null

  const head = value.slice(0, comma)
  // Процентное кодирование (dataURL без `;base64`) тут не встречается: картинки
  // в сцену кладёт Excalidraw, и он пишет только base64.
  if (!head.endsWith(';base64')) return null

  const mimeType = head.slice('data:'.length, -';base64'.length) || 'application/octet-stream'
  const bytes = Buffer.from(value.slice(comma + 1), 'base64')

  return bytes.length === 0 ? null : { mimeType, bytes }
}

interface SnapshotRow {
  doc?: unknown
  format?: unknown
}

export class LegacySnapshots {
  readonly #api: Supabase
  readonly #publicBucket: string

  constructor(api: Supabase, publicBucket: string) {
    this.#api = api
    this.#publicBucket = publicBucket
  }

  /** Документ из последнего снимка; `null` — снимков нет или формат чужой. */
  async load(boardId: BoardId, now: number): Promise<BoardDoc | null> {
    const path =
      `/rest/v1/board_snapshots?board_id=eq.${encodeURIComponent(boardId)}` +
      '&select=doc,format&order=version.desc&limit=1'

    const response = await request(this.#api, 'snapshot-get', path, {
      headers: { accept: 'application/json' },
    })

    const rows = (await response.json()) as SnapshotRow[]
    const row = Array.isArray(rows) ? rows[0] : undefined
    if (!row || typeof row.doc !== 'string' || typeof row.format !== 'string') return null

    const scene = decodeScene(row.doc, row.format)
    if (!scene) {
      log.warn({ board: boardId, format: row.format }, 'снимок не разобран, доска открыта пустой')
      return null
    }

    await this.#repack(boardId, scene)

    return docFromScene(scene, now)
  }

  /**
   * Тяжёлые inline-картинки — в `egesto-public`, в сцене остаётся ссылка.
   *
   * Иначе такая доска не пролезет в кадр протокола: снимок на 1,3 МБ — это
   * одна фотография в base64, и Ф4 отклоняет такой файл на входе (osn§6.4).
   * Ссылка кладётся в поле `dataURL`, а не в `url`: именно так делает сегодня
   * `uploadImage` в `useBoardEngine.ts`, и Excalidraw показывает картинку по
   * обычному URL в этом поле. Отдельное поле `url` клиент бы не прочитал.
   *
   * Неудача выгрузки не срывает импорт: доска откроется с картинкой внутри
   * сцены, как открывалась до сих пор. Это записано в лог и в метрику — и
   * останется так навсегда, потому что снимок читается один раз.
   */
  async #repack(boardId: BoardId, scene: BoardScene): Promise<void> {
    for (const [fileId, value] of Object.entries(scene.files ?? {})) {
      const file = value as FileRef | null
      const dataURL = file?.dataURL
      if (typeof dataURL !== 'string' || !dataURL.startsWith('data:')) continue
      if (Buffer.byteLength(dataURL) <= INLINE_MAX_BYTES) continue

      const decoded = decodeDataUrl(dataURL)
      if (!decoded) continue

      const path = `board-imports/${boardId}/${fileId}`
      try {
        await request(this.#api, 'import-put', `/storage/v1/object/${this.#publicBucket}/${path}`, {
          method: 'POST',
          headers: {
            'x-upsert': 'true',
            'content-type': file?.mimeType && typeof file.mimeType === 'string' ? file.mimeType : decoded.mimeType,
          },
          body: decoded.bytes,
        })
      } catch (error) {
        log.warn(
          { board: boardId, file: fileId, bytes: decoded.bytes.length, err: error },
          'картинка не выгружена, остаётся в сцене'
        )
        continue
      }

      file!.dataURL = `${this.#api.url}/storage/v1/object/public/${this.#publicBucket}/${path}`
      log.info(
        { board: boardId, file: fileId, bytes: decoded.bytes.length, path },
        'картинка из снимка выгружена в бакет'
      )
    }
  }
}
