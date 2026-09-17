import { pickChanged, reconcileElements, winsOver, type SyncElement } from '../boardSync'

const el = (
  id: string,
  version: number,
  versionNonce = 1,
  extra: Record<string, unknown> = {}
): SyncElement => ({ id, version, versionNonce, ...extra })

describe('winsOver', () => {
  it('побеждает больший version', () => {
    expect(winsOver(el('a', 5), el('a', 4))).toBe(true)
    expect(winsOver(el('a', 3), el('a', 4))).toBe(false)
  })

  it('при равном version решает versionNonce', () => {
    expect(winsOver(el('a', 4, 900), el('a', 4, 100))).toBe(true)
    expect(winsOver(el('a', 4, 100), el('a', 4, 900))).toBe(false)
  })

  it('одинаковые правки не считаются победой — иначе сцена дёргалась бы вечно', () => {
    expect(winsOver(el('a', 4, 100), el('a', 4, 100))).toBe(false)
  })
})

describe('reconcileElements', () => {
  it('добавляет незнакомые элементы в конец', () => {
    const { elements, changed } = reconcileElements([el('a', 1)], [el('b', 1)])

    expect(elements.map((e) => e.id)).toEqual(['a', 'b'])
    expect(changed).toBe(true)
  })

  it('заменяет элемент более свежей версией', () => {
    const { elements, changed } = reconcileElements(
      [el('a', 1, 1, { x: 0 })],
      [el('a', 2, 1, { x: 50 })]
    )

    expect(elements[0].x).toBe(50)
    expect(changed).toBe(true)
  })

  it('игнорирует устаревшую версию', () => {
    const { elements, changed } = reconcileElements(
      [el('a', 5, 1, { x: 99 })],
      [el('a', 2, 1, { x: 0 })]
    )

    expect(elements[0].x).toBe(99)
    expect(changed).toBe(false)
  })

  it('сохраняет порядок локальных элементов — он задаёт z-index', () => {
    const { elements } = reconcileElements(
      [el('a', 1), el('b', 1), el('c', 1)],
      [el('b', 2), el('d', 1)]
    )

    expect(elements.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('переносит удаление как обычную правку', () => {
    const { elements } = reconcileElements(
      [el('a', 1)],
      [el('a', 2, 1, { isDeleted: true })]
    )

    expect(elements[0].isDeleted).toBe(true)
  })

  it('сходится независимо от порядка доставки', () => {
    const first = el('a', 4, 100, { x: 1 })
    const second = el('a', 4, 900, { x: 2 })

    const forward = reconcileElements([first], [second]).elements[0]
    const backward = reconcileElements([second], [first]).elements[0]

    expect(forward.x).toBe(backward.x)
    expect(forward.x).toBe(2)
  })
})

describe('pickChanged', () => {
  it('отдаёт только изменившееся с прошлой отправки', () => {
    const sent = new Map<string, number>()

    expect(pickChanged([el('a', 1), el('b', 1)], sent).map((e) => e.id)).toEqual(['a', 'b'])
    expect(pickChanged([el('a', 1), el('b', 1)], sent)).toEqual([])
    expect(pickChanged([el('a', 2), el('b', 1)], sent).map((e) => e.id)).toEqual(['a'])
  })
})
