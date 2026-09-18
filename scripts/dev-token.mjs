#!/usr/bin/env node
// Токен доски для ручных проверок (§10 плана репозитория).
//
// Подписывает те же claims, что будет подписывать роут `/api/board-token` в
// Ф6, тем же секретом `BOARD_SERVER_SECRET`, — и этого достаточно, чтобы
// гонять `wscat` и нагрузочный скрипт, не поднимая Next.js и не заводя
// пользователя в базе.
//
//   node scripts/dev-token.mjs <boardId> [edit|view] [--sub …] [--name …] [--ttl 2h]
//
// Секрет берётся из окружения; в репозиторий он не попадает. Удобно так:
//   node --env-file=../.env scripts/dev-token.mjs <boardId> edit

import { SignJWT } from 'jose'

const USAGE = `использование: node scripts/dev-token.mjs <boardId> [edit|view] [--sub <id>] [--name <имя>] [--ttl <2h>] [--url <ws://localhost:8080>]`

function die(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const positional = []
  const named = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) die(`${arg}: нет значения\n${USAGE}`)
      named[arg.slice(2)] = value
      i += 1
    } else {
      positional.push(arg)
    }
  }

  return { positional, named }
}

/** `2h`, `90m`, `45s` или голые секунды. */
function seconds(ttl) {
  const match = /^(\d+)([smhd]?)$/.exec(ttl)
  if (!match) die(`--ttl ${ttl}: ожидалось что-то вроде 2h, 90m, 3600`)

  const value = Number(match[1])
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[match[2]]

  return value * unit
}

const { positional, named } = parseArgs(process.argv.slice(2))
const [board, role = 'edit'] = positional

if (!board) die(USAGE)
if (role !== 'edit' && role !== 'view') die(`роль ${role} неизвестна: edit или view\n${USAGE}`)

const secret = process.env.BOARD_SERVER_SECRET?.trim()
if (!secret) die('нет BOARD_SERVER_SECRET в окружении: тот же секрет, что у сервиса и у сайта')

const ttl = seconds(named.ttl ?? '2h')
const now = Math.floor(Date.now() / 1000)
// `sub` — это `actor.id` из egeapp: UUID пользователя либо строка
// `guest:<uuid>`. Сервер её не разбирает, только сравнивает, поэтому для
// ручной проверки годится любая устойчивая строка.
const sub = named.sub ?? `dev:${role}`
const name = named.name ?? (role === 'edit' ? 'Дев-репетитор' : 'Дев-зритель')

const token = await new SignJWT({ board, role, name })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(sub)
  .setIssuedAt(now)
  .setExpirationTime(now + ttl)
  .sign(new TextEncoder().encode(secret))

const base = named.url ?? 'ws://localhost:8080'

console.log(token)
console.error(`
доска  ${board}
роль   ${role}   sub ${sub}   имя ${name}
живёт  ${ttl} с (до ${new Date((now + ttl) * 1000).toISOString()})

  wscat -c '${base}/board-ws?board=${board}'
  > {"t":"hello","v":1,"token":"${token}","vector":{},"files":[],"outbox":[]}
`)
