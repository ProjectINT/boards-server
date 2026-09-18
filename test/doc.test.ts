import { describe, expect, it } from 'vitest'

import {
  appStatePatch,
  applyAppState,
  applyElements,
  applyFiles,
  deltaFrame,
  diff,
  docBytes,
  docFromScene,
  emptyDoc,
  sceneBytes,
  tombstoneBytes,
  welcomeFrame,
} from '../src/core/doc.js'
import type { BoardDoc, FileRef, SyncElement } from '../src/core/types.js'

function element(id: string, version: number, versionNonce: number, extra: Record<string, unknown> = {}): SyncElement {
  return { id, type: 'rectangle', x: 0, y: 0, version, versionNonce, ...extra }
}

function file(id: string): FileRef {
  return { id, mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 }
}

/** Элементы документа разобранными — только в тестах: в сервере их нет. */
function parsedElements(doc: BoardDoc): SyncElement[] {
  return [...doc.elements.values()].map((stored) => JSON.parse(stored.bytes.toString('utf8')) as SyncElement)
}

function parseFrame(frame: Buffer): Record<string, unknown> {
  return JSON.parse(frame.toString('utf8')) as Record<string, unknown>
}

describe('слияние элементов', () => {
  it('побеждает больший version', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 1, 500, { text: 'старое' })], 10)

    const { changed } = applyElements(doc, [element('a', 2, 1, { text: 'новое' })], 20)

    expect(changed).toHaveLength(1)
    expect(parsedElements(doc)[0]).toMatchObject({ version: 2, text: 'новое' })
    expect(doc.updatedAt).toBe(20)
  })

  it('при равном version побеждает больший versionNonce', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 3, 100, { text: 'меньший nonce' })], 10)

    const { changed } = applyElements(doc, [element('a', 3, 101, { text: 'больший nonce' })], 20)

    expect(changed).toHaveLength(1)
    expect(parsedElements(doc)[0]).toMatchObject({ versionNonce: 101, text: 'больший nonce' })
  })

  it('проигравший не меняет документ и не попадает в дельту', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 3, 100, { text: 'текущее' })], 10)

    const older = applyElements(doc, [element('a', 2, 999, { text: 'опоздавшее' })], 20)
    const sameVersion = applyElements(doc, [element('a', 3, 99, { text: 'меньший nonce' })], 21)

    expect(older.changed).toHaveLength(0)
    expect(sameVersion.changed).toHaveLength(0)
    expect(parsedElements(doc)[0]).toMatchObject({ version: 3, versionNonce: 100, text: 'текущее' })
    // Ничего не изменилось — время документа тоже не двигалось.
    expect(doc.updatedAt).toBe(10)
  })

  it('порядок доставки не влияет на результат', () => {
    const forward = emptyDoc(0)
    applyElements(forward, [element('a', 1, 5), element('a', 4, 2), element('a', 4, 7)], 1)

    const backward = emptyDoc(0)
    applyElements(backward, [element('a', 4, 7), element('a', 4, 2), element('a', 1, 5)], 1)

    expect(sceneBytes(forward).toString('utf8')).toBe(sceneBytes(backward).toString('utf8'))
  })

  it('элемент без пары (version, versionNonce) не попадает в документ', () => {
    const doc = emptyDoc(0)

    const { changed } = applyElements(doc, [{ id: 'a' } as unknown as SyncElement], 10)

    expect(changed).toHaveLength(0)
    expect(doc.elements.size).toBe(0)
  })
})

describe('diff по вектору состояния', () => {
  const filled = (): BoardDoc => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 2, 1), element('b', 5, 1)], 10)
    applyFiles(doc, [file('f1'), file('f2')], 10)

    return doc
  }

  it('пустой вектор — весь документ', () => {
    const { elements, files } = diff(filled(), {}, [])

    expect(elements).toHaveLength(2)
    expect(files.map((f) => f.id)).toEqual(['f1', 'f2'])
  })

  it('частичный вектор — ровно недостающее', () => {
    const { elements, files } = diff(filled(), { a: 2 }, ['f1'])

    expect(elements).toHaveLength(1)
    expect(JSON.parse(elements[0]!.bytes.toString('utf8'))).toMatchObject({ id: 'b' })
    expect(files.map((f) => f.id)).toEqual(['f2'])
  })

  it('устаревшая версия в векторе — элемент едет заново', () => {
    const { elements } = diff(filled(), { a: 1, b: 5 }, ['f1', 'f2'])

    expect(elements).toHaveLength(1)
    expect(JSON.parse(elements[0]!.bytes.toString('utf8'))).toMatchObject({ id: 'a' })
  })

  it('полный вектор — пусто', () => {
    const { elements, files } = diff(filled(), { a: 2, b: 5 }, ['f1', 'f2'])

    expect(elements).toHaveLength(0)
    expect(files).toHaveLength(0)
  })

  it('удалённый элемент доезжает до опоздавшего', () => {
    const doc = filled()
    applyElements(doc, [element('a', 3, 1, { isDeleted: true })], 20)

    const { elements } = diff(doc, { a: 2, b: 5 }, ['f1', 'f2'])

    expect(elements).toHaveLength(1)
    expect(elements[0]!.deleted).toBe(true)
    expect(JSON.parse(elements[0]!.bytes.toString('utf8'))).toMatchObject({ id: 'a', isDeleted: true })
  })
})

describe('файлы', () => {
  it('повторная вставка файла не меняет документ', () => {
    const doc = emptyDoc(0)
    applyFiles(doc, [file('f1')], 10)
    const before = sceneBytes(doc).toString('utf8')

    const { added } = applyFiles(doc, [{ ...file('f1'), dataURL: 'data:image/png;base64,ZZZZ' }], 20)

    expect(added).toHaveLength(0)
    expect(doc.files.size).toBe(1)
    expect(sceneBytes(doc).toString('utf8')).toBe(before)
    expect(doc.updatedAt).toBe(10)
  })
})

describe('appState', () => {
  it('сходится независимо от порядка двух патчей', () => {
    const early = { theme: 'light', viewBackgroundColor: '#ffffff', currentItemFontFamily: 1 }
    const late = { theme: 'dark', viewBackgroundColor: '#121212', currentItemFontFamily: 2 }

    const forward = emptyDoc(0)
    applyAppState(forward, early, 100)
    applyAppState(forward, late, 200)

    const backward = emptyDoc(0)
    applyAppState(backward, late, 200)
    const applied = applyAppState(backward, early, 100)

    expect(applied).toBe(false)
    expect(forward.appState).toEqual({ ...late, updatedAt: 200 })
    expect(backward.appState).toEqual(forward.appState)
  })

  it('совпадение времени разводится значением, а не порядком', () => {
    const one = { theme: 'dark', viewBackgroundColor: '#121212', currentItemFontFamily: 1 }
    const two = { theme: 'light', viewBackgroundColor: '#ffffff', currentItemFontFamily: 2 }

    const forward = emptyDoc(0)
    applyAppState(forward, one, 100)
    applyAppState(forward, two, 100)

    const backward = emptyDoc(0)
    applyAppState(backward, two, 100)
    applyAppState(backward, one, 100)

    expect(backward.appState).toEqual(forward.appState)
  })

  it('кадр клиента переводится в термины сцены', () => {
    expect(appStatePatch({ t: 'appState', theme: 'dark', font: 5, background: '#121212' })).toEqual({
      theme: 'dark',
      currentItemFontFamily: 5,
      viewBackgroundColor: '#121212',
    })
  })
})

describe('сборка кадров', () => {
  it('welcome — валидный JSON и равен ожидаемой сцене', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 1, 10, { text: 'кавычка " и \\ слэш' }), element('b', 2, 20)], 10)
    applyFiles(doc, [file('f1')], 10)
    applyAppState(doc, { theme: 'dark', viewBackgroundColor: '#121212', currentItemFontFamily: 2 }, 15)

    const { elements, files } = diff(doc, {}, [])
    const frame = welcomeFrame({
      seq: 7,
      role: 'edit',
      elements,
      files,
      appState: doc.appState,
      members: [{ userId: 'guest:1', name: 'Гость', role: 'view' }],
    })

    expect(parseFrame(frame)).toEqual({
      t: 'welcome',
      seq: 7,
      role: 'edit',
      elements: [
        { id: 'a', type: 'rectangle', x: 0, y: 0, version: 1, versionNonce: 10, text: 'кавычка " и \\ слэш' },
        { id: 'b', type: 'rectangle', x: 0, y: 0, version: 2, versionNonce: 20 },
      ],
      files: [file('f1')],
      appState: { theme: 'dark', viewBackgroundColor: '#121212', currentItemFontFamily: 2, updatedAt: 15 },
      members: [{ userId: 'guest:1', name: 'Гость', role: 'view' }],
    })
  })

  it('welcome пустого документа — валидный JSON', () => {
    const doc = emptyDoc(0)
    const { elements, files } = diff(doc, {}, [])

    expect(parseFrame(welcomeFrame({ seq: 0, role: 'view', elements, files, appState: doc.appState, members: [] }))).toEqual({
      t: 'welcome',
      seq: 0,
      role: 'view',
      elements: [],
      files: [],
      appState: { updatedAt: 0 },
      members: [],
    })
  })

  it('delta экранирует чужой sub в поле from', () => {
    const doc = emptyDoc(0)
    const { changed } = applyElements(doc, [element('a', 1, 10)], 10)

    const frame = deltaFrame({ seq: 3, from: 'guest:"}{', elements: changed, files: [] })

    expect(parseFrame(frame)).toEqual({
      t: 'delta',
      seq: 3,
      from: 'guest:"}{',
      elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, version: 1, versionNonce: 10 }],
      files: [],
    })
  })
})

describe('сцена для Storage', () => {
  it('сцена — валидный JSON с файлами объектом по id', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 1, 10), element('b', 2, 20, { isDeleted: true })], 10)
    applyFiles(doc, [file('f1')], 10)

    const scene = JSON.parse(sceneBytes(doc).toString('utf8')) as Record<string, unknown>

    expect(scene['elements']).toHaveLength(2)
    expect(scene['files']).toEqual({ f1: file('f1') })
  })

  it('docFromScene и sceneBytes сходятся друг с другом', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 1, 10), element('b', 2, 20, { isDeleted: true })], 10)
    applyFiles(doc, [file('f1')], 10)
    applyAppState(doc, { theme: 'dark', viewBackgroundColor: '#121212', currentItemFontFamily: 2 }, 15)

    const roundtrip = docFromScene(JSON.parse(sceneBytes(doc).toString('utf8')), 99)

    expect(sceneBytes(roundtrip).toString('utf8')).toBe(sceneBytes(doc).toString('utf8'))
    expect(roundtrip.appState.updatedAt).toBe(15)
    // Надгробие пережило запись и чтение: иначе после перезапуска сервера
    // удаление перестало бы доезжать до опоздавших.
    expect(roundtrip.elements.get('b')?.deleted).toBe(true)
  })

  it('у наследного снимка без updatedAt настройки считаются древними', () => {
    const doc = docFromScene({ elements: [], appState: { theme: 'light' } }, 500)

    expect(doc.appState.updatedAt).toBe(0)
    expect(applyAppState(doc, { theme: 'dark' }, 1)).toBe(true)
  })
})

describe('размеры документа', () => {
  it('tombstoneBytes считает только удалённых', () => {
    const doc = emptyDoc(0)
    applyElements(doc, [element('a', 1, 10), element('b', 1, 10, { isDeleted: true })], 10)

    const alive = doc.elements.get('a')!.bytes.length
    const dead = doc.elements.get('b')!.bytes.length

    expect(tombstoneBytes(doc)).toBe(dead)
    expect(docBytes(doc)).toBe(alive + dead)
  })

  // Замер для журнала фазы Ф2: с ним сверимся после пилота. Штрих — самый
  // тяжёлый элемент доски, поэтому берём именно его.
  it('доска из 300 штрихов укладывается в разумный размер', () => {
    const doc = emptyDoc(0)
    const elements: SyncElement[] = []

    for (let i = 0; i < 300; i++) {
      const points: [number, number][] = []
      for (let p = 0; p < 40; p++) points.push([Math.round(p * 3.5 * 100) / 100, Math.round(p * 1.7 * 100) / 100])

      elements.push({
        id: `stroke-${i}-a1b2c3d4e5f6`,
        type: 'freedraw',
        x: 100 + i,
        y: 200 + i,
        width: 137.5,
        height: 66.3,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1234567890 + i,
        version: 12 + i,
        versionNonce: 987654321 - i,
        isDeleted: false,
        boundElements: null,
        updated: 1758000000000 + i,
        link: null,
        locked: false,
        points,
        pressures: [],
        simulatePressure: true,
        lastCommittedPoint: points[points.length - 1] ?? null,
      })
    }

    applyElements(doc, elements, 1)

    const bytes = docBytes(doc)
    const scene = sceneBytes(doc).length
    console.log(`300 штрихов по 40 точек: документ ${bytes} Б, сцена ${scene} Б`)

    expect(doc.elements.size).toBe(300)
    expect(bytes).toBeLessThan(1_000_000)
  })
})
