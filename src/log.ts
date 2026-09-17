import pino from 'pino'

// LOG_LEVEL читается здесь напрямую, а не из config.ts, намеренно: логгер нужен
// раньше конфигурации — именно он сообщает о том, что обязательных переменных не
// хватило и сервис не поднимется. config.ts ту же переменную проверяет на
// допустимое значение.
const level = process.env.LOG_LEVEL ?? 'info'

// JSON в stdout: его собирает dockhost, ничего дописывать не нужно.
export const log = pino({
  level: pino.levels.values[level] === undefined ? 'info' : level,
  base: { service: 'boards-server' },
})
