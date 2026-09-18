// Хранилище в памяти: подстановка вместо Supabase для тестов, которым нужна
// живая комната, но не нужен Storage (Ф4) или нужен управляемый отказ (Ф5).

import { emptyDoc, docFromScene, sceneBytes } from '../../src/core/doc.js'
import type { BoardDoc, BoardId, BoardScene } from '../../src/core/types.js'
import type { BoardStorage, Loaded } from '../../src/storage/index.js'

export interface MemoryStorage extends BoardStorage {
  /** Записанные документы, как их видел бы Storage: сериализованная сцена. */
  readonly objects: Map<BoardId, Buffer>
  readonly touched: BoardId[]
  readonly loads: BoardId[]
  readonly saves: BoardId[]
  /** Следующие записи падают, пока не снимут. */
  failSaves: Error | null
  failLoads: Error | null
  /** Считать прочитанное импортом из `board_snapshots`. */
  importAll: boolean
}

export function memoryStorage(seed: Record<BoardId, BoardScene> = {}): MemoryStorage {
  const objects = new Map<BoardId, Buffer>()
  for (const [boardId, scene] of Object.entries(seed)) {
    objects.set(boardId, Buffer.from(JSON.stringify(scene)))
  }

  const storage: MemoryStorage = {
    objects,
    touched: [],
    loads: [],
    saves: [],
    failSaves: null,
    failLoads: null,
    importAll: false,

    load(boardId: BoardId, now: number): Promise<Loaded> {
      storage.loads.push(boardId)
      if (storage.failLoads) return Promise.reject(storage.failLoads)

      const stored = objects.get(boardId)
      if (!stored) return Promise.resolve({ doc: emptyDoc(now), imported: false })

      return Promise.resolve({
        doc: docFromScene(JSON.parse(stored.toString('utf8')) as BoardScene, now),
        imported: storage.importAll,
      })
    },

    save(boardId: BoardId, doc: BoardDoc): Promise<number> {
      storage.saves.push(boardId)
      if (storage.failSaves) return Promise.reject(storage.failSaves)

      const bytes = sceneBytes(doc)
      objects.set(boardId, bytes)

      return Promise.resolve(bytes.length)
    },

    touch(boardId: BoardId): Promise<void> {
      storage.touched.push(boardId)

      return Promise.resolve()
    },
  }

  return storage
}
