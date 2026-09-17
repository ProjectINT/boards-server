import { loadConfig, ConfigError } from './config.js'
import { createHttpServer } from './http.js'
import { log } from './log.js'

function start(): void {
  let config
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

  const server = createHttpServer()

  server.listen(config.port, () => {
    log.info(
      {
        port: config.port,
        bucket: config.boardDocsBucket,
        allowedOrigins: config.allowedOrigins,
      },
      'boards-server слушает'
    )
  })
}

start()
