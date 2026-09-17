// Чтение и проверка окружения (§9 плана репозитория).
//
// Сервис без ключа Storage не должен подниматься и принимать правки, которые
// некуда сохранить, поэтому нехватка обязательной переменной — падение на
// старте с перечислением всех недостающих сразу, а не по одной за перезапуск.

export interface Config {
  /** Проверка подписи токенов доски; тот же секрет подписывает их в egeapp. */
  boardServerSecret: string
  supabaseUrl: string
  supabaseServiceRoleKey: string
  /** Источники, которым разрешён апгрейд сокета. Проверку делает Ф4. */
  allowedOrigins: string[]
  boardDocsBucket: string
  port: number
  logLevel: string
  /** Выселение пустой комнаты. */
  roomIdleMs: number
  /** Политика записи: тишина после последней правки и потолок задержки. */
  flushQuietMs: number
  flushMaxMs: number
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`окружение неполное:\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
  }
}

type Env = Record<string, string | undefined>

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = []

  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) {
      problems.push(`${name} не задана`)
      return ''
    }
    return value
  }

  const number = (name: string, fallback: number): number => {
    const raw = env[name]?.trim()
    if (!raw) return fallback

    const value = Number(raw)
    if (!Number.isInteger(value) || value <= 0) {
      problems.push(`${name}=${raw} — ожидалось целое положительное число`)
      return fallback
    }
    return value
  }

  const boardServerSecret = required('BOARD_SERVER_SECRET')
  const supabaseUrl = required('SUPABASE_URL')
  const supabaseServiceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY')

  // Через запятую: `https://egesto.ru,https://www.egesto.ru`. Пустая строка —
  // это «никому», а не «всем»: сокет, открытый с любого origin, отдаёт чужой
  // странице доступ к доске по токену из cookie пользователя.
  const allowedOrigins = required('ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
  if (allowedOrigins.length === 0 && !problems.includes('ALLOWED_ORIGINS не задана')) {
    problems.push('ALLOWED_ORIGINS пуста после разбора')
  }

  const logLevel = env.LOG_LEVEL?.trim() || 'info'
  if (!LOG_LEVELS.includes(logLevel)) {
    problems.push(`LOG_LEVEL=${logLevel} — ожидалось одно из: ${LOG_LEVELS.join(', ')}`)
  }

  const config: Config = {
    boardServerSecret,
    supabaseUrl: supabaseUrl.replace(/\/+$/, ''),
    supabaseServiceRoleKey,
    allowedOrigins,
    boardDocsBucket: env.BOARD_DOCS_BUCKET?.trim() || 'board-docs',
    port: number('PORT', 8080),
    logLevel,
    roomIdleMs: number('ROOM_IDLE_MS', 300_000),
    flushQuietMs: number('FLUSH_QUIET_MS', 5_000),
    flushMaxMs: number('FLUSH_MAX_MS', 30_000),
  }

  if (config.flushQuietMs > config.flushMaxMs) {
    problems.push(
      `FLUSH_QUIET_MS=${config.flushQuietMs} больше FLUSH_MAX_MS=${config.flushMaxMs} — ` +
        'потолок задержки записи оказался бы меньше паузы, после которой она начинается'
    )
  }

  if (problems.length > 0) throw new ConfigError(problems)

  return config
}
