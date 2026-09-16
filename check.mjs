// Внешняя проверка апгрейда: node check.mjs wss://egesto.ru/board-ws
// Успех — строка «АПГРЕЙД ПРОШЁЛ» и эхо отправленного кадра.
import WebSocket from 'ws'

const url = process.argv[2] ?? 'wss://egesto.ru/board-ws'
const payload = `probe ${new Date().toISOString()}`
const ws = new WebSocket(url)

const fail = (why) => { console.error(`АПГРЕЙД НЕ ПРОШЁЛ: ${why}`); process.exit(1) }
const timer = setTimeout(() => fail('таймаут 10 с без ответа'), 10_000)

ws.on('upgrade', (res) => console.log('HTTP', res.statusCode, JSON.stringify(res.headers)))
ws.on('open', () => { console.log('АПГРЕЙД ПРОШЁЛ, шлём кадр'); ws.send(payload) })
ws.on('unexpected-response', (_req, res) => fail(`HTTP ${res.statusCode}`))
ws.on('error', (e) => fail(e.message))
ws.on('message', (data) => {
  const text = data.toString()
  console.log('получено:', text)
  if (text === payload) { clearTimeout(timer); console.log('ЭХО СОВПАЛО'); ws.close(); process.exit(0) }
})
