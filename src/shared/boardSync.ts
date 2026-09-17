// Слияние правок двух участников доски.
//
// Excalidraw версионирует каждый элемент парой (version, versionNonce): version
// растёт при каждом изменении, versionNonce — случайное число, которое разводит
// одновременные правки. Тот же принцип использует официальный excalidraw-room,
// поэтому здесь не CRDT-библиотека, а эти же правила: побеждает больший version,
// при равенстве — больший versionNonce. Так два участника, изменившие один
// элемент, сходятся к одному состоянию независимо от порядка доставки.
//
// ⚠ У этого файла есть побайтовая копия на стороне сервера досок:
// boards-server/src/shared/boardSync.ts (репозиторий ProjectINT/boards-server,
// локально — ~/egeapp/boards-server). Правишь здесь — переноси туда тем же
// заходом: `npm run sync:shared` в boards-server. Расхождение ловит job
// `shared` в его CI, но ловит уже после того, как правка уехала в main, а
// разъехавшиеся winsOver на клиенте и сервере — это доски, которые перестают
// сходиться молча и навсегда. То же касается lib/__tests__/boardSync.test.ts.

export interface SyncElement {
  id: string
  version: number
  versionNonce: number
  isDeleted?: boolean
  [key: string]: unknown
}

// Побеждает ли претендент над текущей версией элемента.
export function winsOver(candidate: SyncElement, current: SyncElement): boolean {
  if (candidate.version !== current.version) {
    return candidate.version > current.version
  }

  // Одинаковый version у разных правок — разводим versionNonce. Сравнение должно
  // быть детерминированным на всех участниках, иначе они разойдутся навсегда.
  return candidate.versionNonce > current.versionNonce
}

// Сливает пришедшие элементы в локальную сцену. Порядок локальных элементов
// сохраняется (в Excalidraw он задаёт z-index), новые добавляются в конец.
export function reconcileElements(
  local: readonly SyncElement[],
  incoming: readonly SyncElement[]
): { elements: SyncElement[]; changed: boolean } {
  const byId = new Map<string, SyncElement>()
  for (const el of local) byId.set(el.id, el)

  let changed = false
  const appended: SyncElement[] = []

  for (const el of incoming) {
    const current = byId.get(el.id)
    if (!current) {
      byId.set(el.id, el)
      appended.push(el)
      changed = true
      continue
    }

    if (winsOver(el, current)) {
      byId.set(el.id, el)
      changed = true
    }
  }

  const elements = local.map((el) => byId.get(el.id) as SyncElement).concat(appended)

  return { elements, changed }
}

// Отбирает элементы, изменившиеся с прошлой отправки, и обновляет переданный
// реестр версий. Рассылать сцену целиком на каждый штрих слишком дорого: доска
// на сотню объектов весит сотни килобайт.
export function pickChanged(
  elements: readonly SyncElement[],
  sentVersions: Map<string, number>
): SyncElement[] {
  const changed: SyncElement[] = []

  for (const el of elements) {
    if (sentVersions.get(el.id) !== el.version) {
      changed.push(el)
      sentVersions.set(el.id, el.version)
    }
  }

  return changed
}
