// Сборка сервиса: конфигурация → http → сокеты → сигналы.
//
// Здесь нет ни одного решения — только порядок, в котором части соединяются, и
// порядок, в котором они останавливаются. Второй важнее первого: по §7
// остановка обязана сначала снять готовность, потом дописать грязные комнаты и
// только потом закрыть сокеты, иначе балансировщик успеет привести на
// умирающий инстанс нового клиента.

import type { Server } from 'node:http'
import { pathToFileURL } from 'node:url'

import { ConfigError, loadConfig } from './config.js'
import type { Config } from './config.js'
import { createHttpServer, setReady } from './http.js'
import { log } from './log.js'
import { Rooms, limitsFrom } from './rooms.js'
import { createStorage } from './storage/index.js'
import type { BoardStorage } from './storage/index.js'
import { Transport } from './transport.js'

/**
 * Общий бюджет остановки (§7). `stopTimeout` контейнера на dockhost должен
 * быть больше — иначе платформа убьёт процесс посреди записи.
 */
export const SHUTDOWN_TIMEOUT_MS = 20_000

export interface Service {
  server: Server
  rooms: Rooms
  transport: Transport
  /** Идемпотентно: второй SIGTERM подряд не должен запускать остановку заново. */
  shutdown(reason: string): Promise<void>
}

/**
 * Настройки, которые в бою всегда взяты по умолчанию, а в тесте задаются:
 * ждать в тесте двадцать пять секунд до первого ping или два часа до конца
 * токена нельзя, а проверить оба поведения нужно.
 */
export interface ServiceOverrides {
  tokenGraceMs?: number
  pingIntervalMs?: number
  tickIntervalMs?: number
  /**
   * Хранилище вместо настоящего Supabase. Нужно тестам транспорта: у них в
   * `SUPABASE_URL` заведомо недостижимый адрес, а комнату они поднимают
   * настоящую.
   */
  storage?: BoardStorage
}

export function createService(config: Config, overrides: ServiceOverrides = {}): Service {
  const rooms = new Rooms({
    limits: limitsFrom(config),
    storage: overrides.storage ?? createStorage(config),
    ...(overrides.tickIntervalMs === undefined ? {} : { tickIntervalMs: overrides.tickIntervalMs }),
  })
  const transport = new Transport({
    config,
    rooms,
    ...(overrides.tokenGraceMs === undefined ? {} : { tokenGraceMs: overrides.tokenGraceMs }),
    ...(overrides.pingIntervalMs === undefined ? {} : { pingIntervalMs: overrides.pingIntervalMs }),
  })
  const server = createHttpServer()

  // Готовность — флаг в модуле `http.ts`: в бою сервис в процессе один, и
  // отдельного носителя ему не нужно. Но остановка снимает флаг навсегда,
  // поэтому новый сервис его поднимает обратно — иначе второй сервис в одном
  // процессе (так устроен интеграционный тест) родился бы неготовым.
  setReady(true)

  transport.attach(server)
  rooms.start()

  let stopping: Promise<void> | null = null

  const shutdown = (reason: string): Promise<void> => {
    if (stopping) return stopping

    stopping = (async () => {
      const started = Date.now()
      log.info({ reason, connections: transport.connections, rooms: rooms.size }, 'остановка')

      // 1. Готовность вниз и никаких новых сокетов: клиент, пришедший сейчас,
      //    должен попасть на живой инстанс, а не на этот.
      setReady(false)
      transport.stopAccepting()

      // 2. Дописать всё несохранённое — до закрытия сокетов, чтобы правка,
      //    приехавшая последней, успела попасть в запись. Общего таймаута у
      //    шага нет: его держит `stopTimeout` контейнера, а обрывать запись на
      //    половине незачем — она идёт параллельно по всем комнатам.
      await rooms.flushAll()

      // 3. Закрыть сокеты кодом 1012: клиенты переподключаются сразу.
      const left = SHUTDOWN_TIMEOUT_MS - (Date.now() - started)
      await transport.shutdown(Math.max(0, left))

      rooms.stop()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // Держащиеся keep-alive соединения иначе не дали бы `close` сработать.
        server.closeAllConnections()
      })

      log.info({ reason, ms: Date.now() - started }, 'остановлен')
    })()

    return stopping
  }

  return { server, rooms, transport, shutdown }
}

function start(): void {
  let config: Config
  try {
    config = loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      // Падаем на старте и перечисляем всё недостающее сразу: иначе каждая
      // забытая переменная стоила бы отдельного перезапуска контейнера.
      log.fatal({ problems: error.problems }, 'сервис не поднят: окружение неполное')
      process.exit(1)
    }
    throw error
  }

  const service = createService(config)

  service.server.listen(config.port, () => {
    log.info(
      {
        port: config.port,
        bucket: config.boardDocsBucket,
        imports: config.boardImportsBucket,
        allowedOrigins: config.allowedOrigins,
      },
      'boards-server слушает'
    )
  })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void service.shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          log.error({ err: error }, 'остановка не удалась')
          process.exit(1)
        }
      )
    })
  }
}

// Запуск — только когда файл вызван как программа. При импорте (тест поднимает
// сервис на случайном порту) стартовать не нужно.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start()
