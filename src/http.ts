import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { log } from './log.js'
import { metrics } from './metrics.js'

// Маршрут dockhost отдаёт путь контейнеру как есть, префикс не срезая: в логе
// пробника Ф0 видно `upgrade ok /board-ws`. Поэтому снаружи сервис живёт по
// `/board-ws/healthz`, а изнутри (HEALTHCHECK контейнера, локальный запуск) —
// по `/healthz`. Принимаем оба, срезая префикс сами.
export const PUBLIC_PATH_PREFIX = '/board-ws'

// Готовность держится флагом в модуле: на SIGTERM его снимет фаза Ф4, чтобы
// балансировщик перестал слать новые соединения раньше, чем сервис дописывает
// грязные комнаты.
let ready = true

export function isReady(): boolean {
  return ready
}

export function setReady(value: boolean): void {
  ready = value
}

/** Путь запроса без строки запроса и без внешнего префикса маршрута. */
export function routeOf(url: string | undefined): string {
  const path = (url ?? '/').split('?')[0] ?? '/'
  if (path === PUBLIC_PATH_PREFIX) return '/'
  if (path.startsWith(`${PUBLIC_PATH_PREFIX}/`)) return path.slice(PUBLIC_PATH_PREFIX.length)
  return path
}

function send(res: ServerResponse, status: number, body: string, contentType = 'text/plain'): void {
  // prom-client отдаёт свой content-type уже с charset — второй раз его
  // дописывать нельзя, заголовок получится некорректным.
  const type = contentType.includes('charset=') ? contentType : `${contentType}; charset=utf-8`

  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const route = routeOf(req.url)

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'method not allowed')
    return
  }

  switch (route) {
    case '/healthz':
      send(res, 200, 'ok')
      return

    case '/readyz':
      // 503, а не 200 с телом «не готов»: платформа читает код, а не текст.
      if (ready) send(res, 200, 'ready')
      else send(res, 503, 'shutting down')
      return

    case '/metrics':
      send(res, 200, await metrics.metrics(), metrics.contentType)
      return

    default:
      send(res, 404, 'not found')
  }
}

export function createHttpServer(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log.error({ err: error, url: req.url }, 'обработчик http упал')
      if (!res.headersSent) send(res, 500, 'internal error')
      else res.end()
    })
  })
}
