#!/usr/bin/env node
// Нагрузочный прогон: 100 комнат × 2 клиента × 8 дельт/с × 2 мин (§10 плана
// репозитория, шаг 6 фазы Ф9).
//
// Смысл прогона не в «выдержит ли» — 1600 дельт в секунду сервис переварит и
// на ноутбуке, — а в трёх числах, которых иначе неоткуда взять до пилота:
// сколько стоит слияние под нагрузкой (`board_delta_broadcast_seconds`),
// сколько сервис просит памяти на сотню живых комнат (RSS) и не теряется ли
// хоть один `ack`. Поэтому скрипт считает свои цифры сам, а под конец снимает
// `/metrics` сервиса и печатает обе колонки рядом.
//
//   node --env-file=.env.load scripts/load.mjs
//   node scripts/load.mjs --rooms 100 --clients 2 --rate 8 --seconds 120
//
// Нужны `BOARD_SERVER_SECRET` (тем же секретом подписан сервис) и адрес
// сервиса: `--url ws://localhost:8080`. Доски берутся выдуманные — это UUID
// вида `load-0000…`, ни в какой базе их нет; на боевом сервисе прогон создаст
// сотню объектов в бакете `board-docs`, поэтому по плану он идёт против
// локального сервиса, а на бой выносится отдельно и в нерабочее время (Ф10).

import { hrtime } from 'node:process'

import { SignJWT } from 'jose'
import WebSocket from 'ws'

const USAGE = `использование: node scripts/load.mjs [--url ws://localhost:8080] [--rooms 100] [--clients 2] [--rate 8] [--seconds 120] [--origin https://egesto.ru]`

function die(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const named = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) die(`${arg}: лишний аргумент\n${USAGE}`)

    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) die(`${arg}: нет значения\n${USAGE}`)
    named[arg.slice(2)] = value
    i += 1
  }

  return named
}

function integer(named, name, fallback) {
  const raw = named[name]
  if (raw === undefined) return fallback

  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) die(`--${name} ${raw}: ожидалось целое положительное число`)

  return value
}

const named = parseArgs(process.argv.slice(2))
const base = (named.url ?? 'ws://localhost:8080').replace(/\/+$/, '')
const origin = named.origin ?? 'https://egesto.ru'
const rooms = integer(named, 'rooms', 100)
const clientsPerRoom = integer(named, 'clients', 2)
const rate = integer(named, 'rate', 8)
const seconds = integer(named, 'seconds', 120)
/**
 * Сколько разных элементов рисует клиент. По умолчанию каждая дельта — новый
 * элемент: это верхняя граница, доска растёт всю дорогу. С `--elements N`
 * клиент ходит по кругу и переписывает те же N штрихов — так выглядит живое
 * рисование, где правят и стирают уже нарисованное, и документ перестаёт расти.
 */
const elements = named.elements === undefined ? 0 : integer(named, 'elements', 0)

const secret = process.env.BOARD_SERVER_SECRET?.trim()
if (!secret) die('нет BOARD_SERVER_SECRET в окружении: тот же секрет, что у сервиса')

const key = new TextEncoder().encode(secret)

/**
 * Доска прогона. Форма — UUID, чтобы адрес и логи выглядели как в бою, но
 * префикс `1oad` (с цифрой) не встречается у настоящих досок: если такой объект
 * всё же окажется в бакете, по нему сразу видно, откуда он взялся.
 */
function boardId(index) {
  return `1oad${String(index).padStart(4, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`
}

async function token(board, sub) {
  const now = Math.floor(Date.now() / 1000)

  return new SignJWT({ board, role: 'edit', name: sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key)
}

/**
 * Элемент, похожий на настоящий: штрих `freedraw` из сорока точек — это то,
 * что рисует человек, и ровно на нём Ф2 мерила вес документа (~950 Б на
 * элемент). Замер, сделанный на пустых прямоугольниках, не сказал бы ничего.
 */
function stroke(id, version) {
  const points = []
  for (let i = 0; i < 40; i += 1) points.push([Math.round(Math.random() * 800), Math.round(Math.random() * 600)])

  return {
    id,
    type: 'freedraw',
    x: Math.round(Math.random() * 800),
    y: Math.round(Math.random() * 600),
    width: 120,
    height: 80,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    roughness: 1,
    opacity: 100,
    seed: Math.round(Math.random() * 2 ** 31),
    version,
    versionNonce: Math.round(Math.random() * 2 ** 31),
    isDeleted: false,
    points,
    pressures: [],
    simulatePressure: true,
  }
}

const stats = {
  sent: 0,
  acked: 0,
  rejected: 0,
  received: 0,
  connectErrors: 0,
  closes: new Map(),
  /** Задержки `delta → ack` в миллисекундах; из них считаются квантили. */
  acks: [],
}

function note(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
}

/** Один клиент: входит, рисует `rate` штрихов в секунду, считает свои ответы. */
class Peer {
  #socket
  #pending = new Map()
  #cseq = 0
  #version = 0
  #timer = null
  #stopped = false

  constructor(board, sub) {
    this.board = board
    this.sub = sub
  }

  async start() {
    const raw = await token(this.board, this.sub)
    this.#socket = new WebSocket(`${base}/board-ws?board=${this.board}`, { origin })

    await new Promise((resolve, reject) => {
      this.#socket.once('open', resolve)
      this.#socket.once('error', reject)
    })

    this.#socket.on('message', (data) => this.#onFrame(data))
    this.#socket.on('close', (code) => note(stats.closes, code))
    this.#socket.on('error', () => undefined)

    this.#socket.send(
      JSON.stringify({ t: 'hello', v: 1, token: raw, vector: {}, files: [], outbox: [] })
    )
  }

  #onFrame(data) {
    let frame
    try {
      frame = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }

    switch (frame.t) {
      case 'welcome':
        // Рисовать начинаем только после `welcome`: до него сервис ещё читает
        // документ из Storage, и дельта легла бы в очередь, испортив замер.
        this.#draw()
        break
      case 'ack': {
        const startedAt = this.#pending.get(frame.cseq)
        if (startedAt !== undefined) {
          this.#pending.delete(frame.cseq)
          stats.acks.push(Number(hrtime.bigint() - startedAt) / 1e6)
        }
        stats.acked += 1
        break
      }
      case 'reject':
        this.#pending.delete(frame.cseq)
        stats.rejected += 1
        break
      case 'delta':
        stats.received += 1
        break
      case 'error':
        note(stats.closes, `error:${frame.code}`)
        break
      default:
        break
    }
  }

  #draw() {
    if (this.#stopped) return

    // Своя пауза у каждого клиента, а не общий тик: одновременный залп со ста
    // комнат мерил бы поведение планировщика, а не сервиса.
    this.#timer = setTimeout(() => {
      this.#send()
      this.#draw()
    }, (1000 / rate) * (0.75 + Math.random() * 0.5))
    this.#timer.unref()
  }

  #send() {
    if (this.#socket.readyState !== WebSocket.OPEN) return

    this.#cseq += 1
    this.#version += 1
    const id = elements > 0 ? `${this.sub}-${this.#cseq % elements}` : `${this.sub}-${this.#cseq}`
    this.#pending.set(this.#cseq, hrtime.bigint())
    this.#socket.send(
      JSON.stringify({
        t: 'delta',
        cseq: this.#cseq,
        elements: [stroke(id, this.#version)],
        files: [],
      })
    )
    stats.sent += 1
  }

  /** Перестать рисовать, не закрывая сокет: хвост `ack` ещё едет. */
  pause() {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
  }

  stop() {
    this.#socket?.close(1000, 'load done')
  }
}

/** Значение метрики из текста `/metrics`; для гистограммы — сумма и число. */
function metric(text, name) {
  const found = []
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue

    const parts = line.trim().split(/\s+/)
    found.push([parts[0], Number(parts[parts.length - 1])])
  }

  return found
}

async function snapshot() {
  const http = base.replace(/^ws/, 'http')
  try {
    const response = await fetch(`${http}/metrics`)
    if (!response.ok) return null

    return await response.text()
  } catch {
    return null
  }
}

function report(text) {
  const lines = []
  const sorted = stats.acks.slice().sort((a, b) => a - b)

  lines.push('')
  lines.push(`комнат ${rooms} × клиентов ${clientsPerRoom} × ${rate} дельт/с × ${seconds} с`)
  lines.push(`элементов на клиента ${elements > 0 ? elements : 'без повторов: каждая дельта — новый'}`)
  lines.push(`адрес  ${base}`)
  lines.push('')
  lines.push(`отправлено дельт   ${stats.sent}`)
  lines.push(`подтверждено       ${stats.acked}${stats.acked === stats.sent ? '' : `  (не хватает ${stats.sent - stats.acked})`}`)
  lines.push(`отклонено          ${stats.rejected}`)
  lines.push(`принято чужих      ${stats.received}`)
  lines.push(`ошибок входа       ${stats.connectErrors}`)
  lines.push(`фактическая скорость ${(stats.sent / seconds).toFixed(1)} дельт/с`)
  lines.push('')
  lines.push('задержка delta → ack, мс (это сеть + очередь + слияние):')
  lines.push(
    `  p50 ${quantile(sorted, 0.5).toFixed(1)}   p95 ${quantile(sorted, 0.95).toFixed(1)}   ` +
      `p99 ${quantile(sorted, 0.99).toFixed(1)}   max ${(sorted[sorted.length - 1] ?? 0).toFixed(1)}`
  )

  if (stats.closes.size > 0) {
    lines.push('')
    lines.push('закрытия и ошибки:')
    for (const [code, count] of stats.closes) lines.push(`  ${code}: ${count}`)
  }

  if (text) {
    lines.push('')
    lines.push('со стороны сервиса (/metrics):')
    for (const name of [
      'board_rooms',
      'board_connections',
      'board_deltas_total',
      'board_storage_errors_total',
      'board_doc_bytes',
      'board_tombstone_bytes',
      'board_pointers_dropped_total',
      'board_connection_closes_total',
    ]) {
      for (const [series, value] of metric(text, name)) lines.push(`  ${series} ${value}`)
    }

    const sum = metric(text, 'board_delta_broadcast_seconds_sum')[0]?.[1] ?? 0
    const count = metric(text, 'board_delta_broadcast_seconds_count')[0]?.[1] ?? 0
    if (count > 0) {
      lines.push(`  среднее delta → broadcast: ${((sum / count) * 1000).toFixed(3)} мс на ${count} дельт`)
    }
    for (const [series, value] of metric(text, 'board_delta_broadcast_seconds_bucket')) {
      lines.push(`  ${series} ${value}`)
    }
  } else {
    lines.push('')
    lines.push('/metrics не ответил: цифры только со стороны клиентов')
  }

  return lines.join('\n')
}

const peers = []
const started = Date.now()

console.error(`поднимаю ${rooms * clientsPerRoom} соединений…`)

for (let room = 0; room < rooms; room += 1) {
  const board = boardId(room)
  const batch = []
  for (let index = 0; index < clientsPerRoom; index += 1) {
    const peer = new Peer(board, `load-${room}-${index}`)
    peers.push(peer)
    batch.push(
      peer.start().catch((error) => {
        stats.connectErrors += 1
        note(stats.closes, `connect:${error?.message ?? 'ошибка'}`)
      })
    )
  }
  // Комнаты поднимаются пачками по одной: сотня одновременных апгрейдов
  // упёрлась бы в accept-очередь и смазала бы начало замера.
  await Promise.all(batch)
}

console.error(`подняты за ${((Date.now() - started) / 1000).toFixed(1)} с, рисуем ${seconds} с…`)

await new Promise((resolve) => setTimeout(resolve, seconds * 1000))

for (const peer of peers) peer.pause()
// Секунда на хвост подтверждений — иначе последние дельты считались бы
// потерянными, хотя их `ack` просто ещё в пути.
await new Promise((resolve) => setTimeout(resolve, 1000))

// Метрики снимаются до закрытия сокетов: после закрытия комнаты пустеют, и
// `board_connections` показал бы ноль.
const text = await snapshot()
for (const peer of peers) peer.stop()

console.log(report(text))
console.error('\nсокеты закрыты; записанные документы остаются в бакете сервиса')
process.exit(stats.sent === stats.acked && stats.connectErrors === 0 ? 0 : 1)
