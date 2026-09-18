// Хранилище целиком: что зовёт `rooms.ts` (§8 плана репозитория, osn§8).
//
// Снаружи у хранилища три действия — прочитать документ, записать документ,
// отметить доску активной, — и ровно на них рассчитан реестр комнат. Всё, что
// сложнее, спрятано здесь: цепочка «объект в Storage → наследный снимок →
// пустая доска» и переупаковка тяжёлых картинок.
//
// Интерфейс существует не ради абстракции вообще, а ради двух подстановок: в
// тестах вместо Supabase подставляется карта в памяти, а замена Storage на
// S3/MinIO (osn§8, «если Storage начнёт мешать») остаётся локальной правкой
// трёх файлов рядом.

import { emptyDoc } from '../core/doc.js'
import type { BoardDoc, BoardId } from '../core/types.js'
import type { Config } from '../config.js'
import { log } from '../log.js'
import { touchBoard } from './boards.js'
import type { FetchLike, Supabase } from './http.js'
import { LegacySnapshots } from './legacy.js'
import { BoardObjects } from './objects.js'

export { SupabaseError } from './http.js'
export type { FetchLike, Supabase } from './http.js'

export interface Loaded {
  doc: BoardDoc
  /**
   * Документ собран из наследного снимка, и в Storage его ещё нет. Реестр по
   * этому признаку помечает комнату грязной: пока импорт не записан, доска
   * читается из PostgREST при каждом открытии, а тяжёлые картинки при каждом
   * открытии выгружаются заново.
   */
  imported: boolean
}

export interface BoardStorage {
  /**
   * Документ доски. Ошибка означает «сейчас неизвестно, что на доске», и
   * подниматься с пустым документом на ней нельзя: первая же запись затёрла бы
   * настоящий. Поэтому исключение отсюда доходит до транспорта и закрывает
   * соединение — клиент вернётся.
   */
  load(boardId: BoardId, now: number): Promise<Loaded>
  /** Размер записанного объекта в байтах. */
  save(boardId: BoardId, doc: BoardDoc): Promise<number>
  touch(boardId: BoardId): Promise<void>
}

export function createStorage(config: Config, fetchImpl: FetchLike = fetch): BoardStorage {
  const api: Supabase = {
    url: config.supabaseUrl,
    serviceRoleKey: config.supabaseServiceRoleKey,
    fetch: fetchImpl,
  }

  const objects = new BoardObjects(api, config.boardDocsBucket)
  const legacy = new LegacySnapshots(api, config.boardImportsBucket)

  return {
    async load(boardId, now) {
      const stored = await objects.load(boardId, now)
      if (stored) return { doc: stored, imported: false }

      const imported = await legacy.load(boardId, now)
      if (imported) {
        log.info(
          { board: boardId, elements: imported.elements.size, files: imported.files.size },
          'доска импортирована из board_snapshots'
        )

        return { doc: imported, imported: true }
      }

      log.info({ board: boardId }, 'доска поднята пустой: ни объекта, ни снимка')

      // Пустая доска — не импорт: записывать в Storage нечего, пока на ней не
      // нарисуют. Иначе каждое открытие пустой доски стоило бы записи объекта.
      return { doc: emptyDoc(now), imported: false }
    },

    save: (boardId, doc) => objects.save(boardId, doc),
    touch: (boardId) => touchBoard(api, boardId),
  }
}
