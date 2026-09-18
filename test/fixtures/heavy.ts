// Тяжёлый снимок: доска, у которой вся сцена — одна картинка в base64.
//
// Такая доска в проде есть ровно одна (`board_snapshots`, 1 326 654 байт, пять
// версий подряд, июль 2026): один элемент `image`, один файл `image/png` на
// 1,3 МБ внутри сцены. Её и разбирает Ф5.
//
// **Почему настоящей фикстуры здесь нет.** Картинкой в той доске оказалась
// фотография лица человека — биометрические персональные данные, которым не
// место в git. Поэтому фикстура собирается: форма — та же, что у настоящего
// снимка (имена и порядок полей элемента сняты с него дословно, включая
// `isDeleted: true` и `status: "saved"`), а вместо фотографии — детерминированный
// шум, который так же не жмётся и даёт тот же порядок размера. На импорте
// разницы нет: сервер в картинку не заглядывает, ему важны только длина
// `dataURL` и то, что это base64.
//
// Настоящая доска проверена руками на боевом Supabase, результат — в журнале Ф5.

import { deflateSync } from 'node:zlib'

import type { BoardScene } from '../../src/core/types.js'

export const HEAVY_BOARD = '6fc5c63e-855e-4c4d-ac18-ca8bd3a010ae'
export const HEAVY_FILE = '130f9159-cbc0-4e48-97e9-b790bee679af'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }

  return table
})()

function crc32(bytes: Buffer): number {
  let c = -1
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)

  return (c ^ -1) >>> 0
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))

  return Buffer.concat([head, typed, crc])
}

/**
 * PNG из псевдослучайного шума. Шум выбран намеренно: сжатая картинка весила бы
 * килобайты, а нужен файл, который не пролезает в кадр протокола.
 */
export function noisePng(side = 500, seed = 0x5eed1234): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8 // бит на канал
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = side * 4
  const raw = Buffer.alloc((stride + 1) * side)
  let state = seed
  for (let y = 0; y < side; y++) {
    const line = y * (stride + 1)
    raw[line] = 0 // фильтр «нет»
    for (let x = 0; x < stride; x++) {
      // xorshift32: детерминированно и без зависимостей.
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      raw[line + 1 + x] = state & 0xff
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 1 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Сцена той самой доски: один элемент-картинка и один файл на 1,3 МБ. */
export function heavyScene(): BoardScene {
  const png = noisePng()

  return {
    elements: [
      {
        id: '10ef29d4-5d34-4a6c-8ed7-202103ee3061',
        type: 'image',
        x: 385.2576904296875,
        y: -11.486526489257812,
        width: 360,
        height: 480,
        angle: 0,
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 1,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 938897263,
        version: 3,
        versionNonce: 18538720,
        isDeleted: true,
        boundElements: null,
        updated: 1785497823675,
        link: null,
        locked: false,
        status: 'saved',
        fileId: HEAVY_FILE,
        scale: [1, 1],
        index: 'a0',
      },
    ],
    appState: { viewBackgroundColor: '#ffffff', theme: 'light', currentItemFontFamily: 8 },
    files: {
      [HEAVY_FILE]: {
        id: HEAVY_FILE,
        mimeType: 'image/png',
        dataURL: `data:image/png;base64,${png.toString('base64')}`,
        created: 1785497807920,
      },
    },
  }
}
