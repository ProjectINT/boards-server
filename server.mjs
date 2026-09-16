// Временный эхо-сервер для фазы Ф0 плана board-server: проверяем, проходит ли
// WebSocket-апгрейд через маршрут dockhost по пути. Каталог удаляется после
// фазы, в приложении не используется.
import { createServer } from 'node:http'

import { WebSocketServer } from 'ws'

const port = Number(process.env.PORT ?? 8080)

const http = createServer((req, res) => {
  if (req.url === '/healthz' || req.url === '/board-ws/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ server: http })

wss.on('connection', (socket, req) => {
  console.log('upgrade ok', req.url, req.headers.host, req.headers['x-forwarded-for'] ?? '-')
  socket.send(`hello ${req.url}`)
  socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
})

http.listen(port, () => console.log(`board-ws-probe on :${port}`))
