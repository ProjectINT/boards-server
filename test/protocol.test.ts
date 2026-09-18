// Главный тест проекта (§6 плана репозитория, osn§13).
//
// Два фиктивных клиента, между ними и комнатой — модель доставки с потерями,
// дублями и переупорядочиванием: 500 случайных правок, случайные разрывы,
// реконнекты с вектором и outbox. Инвариант один: в конце сцены обоих клиентов
// и документ комнаты совпадают поэлементно.
//
// Сервера здесь нет: «сервер» — это вызов `step` в цикле. Случайность — свой
// детерминированный генератор с явным seed, чтобы упавший прогон повторялся
// командой, а не «иногда». `npm test` гоняет фиксированный seed, `npm run
// test:seeds` — двести подряд (в CI по расписанию).
//
// Клиенты сливают правки настоящим `reconcileElements` из `src/shared`, тем
// самым, что стоит на сайте: если правила слияния на клиенте и на сервере
// разъедутся, это увидят здесь, а не доски пользователей.

import { describe, expect, it } from 'vitest'

import { emptyDoc } from '../src/core/doc.js'
import { createRoom, markFlushed, step } from '../src/core/room.js'
import type { Effect, Event, Room } from '../src/core/room.js'
import { pickChanged, reconcileElements } from '../src/shared/boardSync.js'
import type {
  ClientDeltaFrame,
  Claims,
  ConnId,
  FileRef,
  StateVector,
  SyncElement,
} from '../src/core/types.js'

const BOARD = '11111111-1111-1111-1111-111111111111'
const BASE_SEED = 20_260_916
const SEED_RUNS = Number(process.env.PROTOCOL_SEEDS ?? 1)
const EDITS = 500

const LOSS = 0.12
const DUPLICATE = 0.08

/**
 * mulberry32 — четыре строки, никаких зависимостей и одинаковое поведение на
 * любой машине: тест, который ловит редкие расхождения, сам обязан быть
 * воспроизводимым до последнего шага.
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0

  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Frame = Record<string, unknown>

/** Кадр клиенту: адресован конкретному сокету, а не человеку. */
interface ToClient {
  kind: 'frame'
  client: string
  conn: ConnId
  frame: Buffer
}

interface ToServer {
  kind: 'event'
  event: Event
}

type Packet = ToClient | ToServer

class FakeClient {
  conn: ConnId | null = null
  scene: SyncElement[] = []
  files = new Map<string, FileRef>()
  /** Что уже ушло в комнату: id → version (тот же реестр, что у сайта). */
  sent = new Map<string, number>()
  /** Неподтверждённое: дельты, на которые не пришёл `ack`. */
  outbox: ClientDeltaFrame[] = []
  pendingFiles: FileRef[] = []
  cseq = 0
  private generation = 0
  private created = 0

  constructor(
    readonly id: string,
    readonly sub: string
  ) {}

  get claims(): Claims {
    return { sub: this.sub, board: BOARD, role: 'edit', name: `имя-${this.id}`, exp: 2_000_000_000 }
  }

  /** Вектор состояния с нонсами: по одной версии победу при равной не видно. */
  vector(): StateVector {
    const vector: StateVector = {}
    for (const el of this.scene) vector[el.id] = [el.version, el.versionNonce]

    return vector
  }

  hello(): Event {
    this.generation += 1
    this.conn = `${this.id}#${this.generation}`

    return {
      t: 'join',
      conn: this.conn,
      claims: this.claims,
      vector: this.vector(),
      files: [...this.files.keys()],
      outbox: this.outbox.map((delta) => ({ ...delta })),
    }
  }

  alive(): SyncElement[] {
    return this.scene.filter((el) => el.isDeleted !== true)
  }

  /** Одна правка: новый элемент, изменение существующего или удаление. */
  edit(rng: () => number): void {
    const alive = this.alive()
    const roll = rng()

    if (alive.length === 0 || roll < 0.35) {
      this.created += 1
      const el: SyncElement = {
        id: `${this.id}-${this.created}`,
        type: 'rectangle',
        x: Math.floor(rng() * 1000),
        y: Math.floor(rng() * 1000),
        text: `${this.id}-${this.created}-0`,
        version: 1,
        versionNonce: Math.floor(rng() * 2 ** 31),
      }
      this.scene = [...this.scene, el]

      // Картинка вместе с элементом — редко, как в жизни.
      if (rng() < 0.05) {
        const fileRef: FileRef = {
          id: `f-${this.id}-${this.created}`,
          mimeType: 'image/png',
          dataURL: 'data:image/png;base64,iVBORw0KGgo=',
        }
        this.files.set(fileRef.id, fileRef)
        this.pendingFiles.push(fileRef)
      }
      return
    }

    const target = alive[Math.floor(rng() * alive.length)]!
    const deleting = roll > 0.85
    // Новый объект, а не правка на месте: старый уже лежит в outbox, и
    // мутация подменила бы отправленное задним числом.
    const next: SyncElement = {
      ...target,
      version: target.version + 1,
      versionNonce: Math.floor(rng() * 2 ** 31),
      ...(deleting ? { isDeleted: true } : { text: `${this.id}-${target.id}-${target.version + 1}` }),
    }
    this.scene = this.scene.map((el) => (el.id === next.id ? next : el))
  }

  /** Собрать дельту из накопившегося. Возвращает событие, если есть что слать. */
  flush(): ClientDeltaFrame | null {
    const elements = pickChanged(this.scene, this.sent)
    const files = this.pendingFiles
    if (elements.length === 0 && files.length === 0) return null

    this.pendingFiles = []
    this.cseq += 1
    const delta: ClientDeltaFrame = { t: 'delta', cseq: this.cseq, elements, files }
    this.outbox.push(delta)

    return delta
  }

  receive(raw: Buffer): void {
    const frame = JSON.parse(raw.toString('utf8')) as Frame

    switch (frame.t) {
      case 'welcome':
      case 'delta': {
        this.apply((frame.elements ?? []) as SyncElement[], (frame.files ?? []) as FileRef[])
        break
      }
      case 'ack': {
        this.outbox = this.outbox.filter((delta) => delta.cseq !== frame.cseq)
        break
      }
      case 'reject': {
        throw new Error(`неожиданный reject: ${String(frame.reason)}`)
      }
      default:
        break
    }
  }

  private apply(elements: readonly SyncElement[], files: readonly FileRef[]): void {
    const { elements: next } = reconcileElements(this.scene, elements)
    this.scene = next

    const byId = new Map(next.map((el) => [el.id, el]))
    for (const el of elements) {
      const current = byId.get(el.id)
      // Победившее чужое отправлять обратно незачем; проигравшее — наоборот,
      // должно остаться неотправленным, иначе своя правка не доедет никогда.
      if (current && current.version === el.version && current.versionNonce === el.versionNonce) {
        this.sent.set(el.id, el.version)
      }
    }

    for (const file of files) {
      if (!this.files.has(file.id)) this.files.set(file.id, file)
    }
  }
}

class Sim {
  readonly room: Room
  readonly clients: FakeClient[]
  private wire: Packet[] = []
  private now = 0
  readonly counts = { lost: 0, duplicated: 0, delivered: 0, reconnects: 0, flushes: 0 }

  constructor(private readonly rng: () => number) {
    this.room = createRoom(BOARD, emptyDoc(0), 0)
    this.clients = [new FakeClient('A', 'tutor'), new FakeClient('B', 'guest:1')]
  }

  private int(bound: number): number {
    return Math.floor(this.rng() * bound)
  }

  private byConn(conn: ConnId): FakeClient | undefined {
    return this.clients.find((client) => conn.startsWith(`${client.id}#`))
  }

  private run(event: Event): void {
    const { effects } = step(this.room, event, this.now)
    for (const effect of effects) this.dispatch(effect)
  }

  private dispatch(effect: Effect): void {
    switch (effect.t) {
      case 'send': {
        const client = this.byConn(effect.to)
        if (client) this.wire.push({ kind: 'frame', client: client.id, conn: effect.to, frame: effect.frame })
        break
      }
      case 'broadcast': {
        for (const client of this.clients) {
          if (client.conn === null || client.conn === effect.except) continue
          this.wire.push({ kind: 'frame', client: client.id, conn: client.conn, frame: effect.frame })
        }
        break
      }
      case 'close': {
        throw new Error(`неожиданное закрытие: ${effect.reason}`)
      }
      case 'flush': {
        // Storage в этой фазе нет: считаем, что запись удалась мгновенно.
        this.counts.flushes += 1
        markFlushed(this.room, this.now)
        break
      }
      case 'evict':
        break
    }
  }

  private send(client: FakeClient, delta: ClientDeltaFrame): void {
    if (client.conn === null) return
    this.wire.push({
      kind: 'event',
      event: { t: 'delta', conn: client.conn, cseq: delta.cseq, elements: delta.elements, files: delta.files },
    })
  }

  private deliver(packet: Packet): void {
    this.counts.delivered += 1

    if (packet.kind === 'event') {
      this.run(packet.event)
      return
    }

    const client = this.clients.find((c) => c.id === packet.client)
    // Кадр адресован сокету, которого уже нет: клиент его не увидит никогда.
    if (!client || client.conn !== packet.conn) return
    client.receive(packet.frame)
  }

  /** Один пакет из сети: случайный (переупорядочивание), с потерей и дублем. */
  private deliverOne(reliable: boolean): void {
    if (this.wire.length === 0) return

    const [packet] = this.wire.splice(this.int(this.wire.length), 1) as [Packet]

    if (!reliable && this.rng() < LOSS) {
      this.counts.lost += 1
      return
    }
    if (!reliable && this.rng() < DUPLICATE) {
      this.counts.duplicated += 1
      this.wire.push(packet)
    }

    this.deliver(packet)
  }

  private drain(): void {
    let guard = 0
    while (this.wire.length > 0) {
      this.deliverOne(true)
      if (++guard > 100_000) throw new Error('сеть не опустела')
    }
  }

  private connect(client: FakeClient): void {
    this.counts.reconnects += 1
    // `hello` приходит по свежему сокету и обгонять ему нечего: кадры старого
    // соединения комната уже не примет.
    this.run(client.hello())
  }

  private disconnect(client: FakeClient): void {
    const conn = client.conn
    if (conn === null) return

    client.conn = null
    // `leave` едет через ту же сеть: транспорт узнаёт о разрыве не мгновенно,
    // а иногда не узнаёт вовсе — тогда участник висит в комнате до ping/pong.
    this.wire.push({ kind: 'event', event: { t: 'leave', conn } })
  }

  play(edits: number): void {
    for (const client of this.clients) this.connect(client)
    this.drain()

    for (let i = 0; i < edits; i++) {
      // Шаг времени примерно равен интервалу отправки клиента (120 мс, osn§6.3):
      // за 500 правок набегает около минуты, и политика записи успевает
      // сработать по потолку — иначе `flush` в этом тесте не проверялся бы вовсе.
      this.now += 20 + this.int(200)

      const client = this.clients[this.int(this.clients.length)]!
      client.edit(this.rng)

      if (this.rng() < 0.7) {
        const delta = client.flush()
        if (delta) this.send(client, delta)
      }

      if (this.rng() < 0.03) this.disconnect(this.clients[this.int(this.clients.length)]!)
      if (this.rng() < 0.2) {
        const offline = this.clients.filter((c) => c.conn === null)
        if (offline.length > 0) this.connect(offline[this.int(offline.length)]!)
      }
      if (this.rng() < 0.1) this.run({ t: 'tick' })

      const packets = this.int(4)
      for (let k = 0; k < packets; k++) this.deliverOne(false)
    }
  }

  /** Сеть чинится: все возвращаются, всё доезжает. */
  settle(): void {
    this.now += 1_000

    for (const client of this.clients) {
      if (client.conn === null) this.connect(client)
    }
    this.drain()

    for (const client of this.clients) {
      const delta = client.flush()
      if (delta) this.send(client, delta)
    }
    this.drain()

    // Последний реконнект каждого: `welcome` довозит то, что комната знает, а
    // клиент проспал. Именно этим протокол и должен чиниться после разрыва.
    for (const client of this.clients) {
      this.disconnect(client)
      this.connect(client)
      this.drain()
    }
  }

  serverScene(): Map<string, SyncElement> {
    const scene = new Map<string, SyncElement>()
    for (const [id, stored] of this.room.doc.elements) {
      scene.set(id, JSON.parse(stored.bytes.toString('utf8')) as SyncElement)
    }

    return scene
  }

  serverFiles(): Map<string, FileRef> {
    const files = new Map<string, FileRef>()
    for (const [id, bytes] of this.room.doc.files) {
      files.set(id, JSON.parse(bytes.toString('utf8')) as FileRef)
    }

    return files
  }
}

function sceneOf(client: FakeClient): Map<string, SyncElement> {
  return new Map(client.scene.map((el) => [el.id, el]))
}

function converged(seed: number): Sim {
  const sim = new Sim(makeRng(seed))
  sim.play(EDITS)
  sim.settle()

  const server = sim.serverScene()
  const serverFiles = sim.serverFiles()

  for (const client of sim.clients) {
    const scene = sceneOf(client)

    expect(`${client.id}: ${[...scene.keys()].sort().join(',')}`).toBe(
      `${client.id}: ${[...server.keys()].sort().join(',')}`
    )
    for (const [id, expected] of server) {
      expect(scene.get(id), `seed ${seed}, клиент ${client.id}, элемент ${id}`).toEqual(expected)
    }
    expect([...client.files.keys()].sort()).toEqual([...serverFiles.keys()].sort())
  }

  return sim
}

describe('протокол на двух фиктивных клиентах', () => {
  it(`сходится после ${EDITS} правок с потерями, дублями и разрывами (seed ${BASE_SEED})`, () => {
    const sim = converged(BASE_SEED)

    // Прогон обязан быть нагруженным: без потерь и реконнектов он проверял бы
    // не то, ради чего написан, и молча оставался бы зелёным.
    expect(sim.counts.lost).toBeGreaterThan(20)
    expect(sim.counts.duplicated).toBeGreaterThan(10)
    expect(sim.counts.reconnects).toBeGreaterThan(4)
    expect(sim.counts.flushes).toBeGreaterThan(0)
    expect(sim.room.doc.elements.size).toBeGreaterThan(50)
  })

  // `npm run test:seeds` ставит PROTOCOL_SEEDS=200 — двести подряд идущих
  // seed'ов. В обычном `npm test` прогон один: 200 штук дают минуты, а не
  // секунды, и их место — в CI по расписанию.
  const extra = Array.from({ length: Math.max(0, SEED_RUNS - 1) }, (_, i) => BASE_SEED + i + 1)

  for (const seed of extra) {
    it(`сходится на seed ${seed}`, () => {
      converged(seed)
    })
  }
})
