#!/usr/bin/env node
// Обновляет копию правил слияния из репозитория сайта.
//
// Источник истины — egeapp; направление одно, в обратную сторону файлы не
// едут. Копируются ровно два файла, байт в байт (§2 плана репозитория):
// раскладка выбрана так, чтобы импорт `../boardSync` внутри теста резолвился
// без правок — иначе сверка «байт в байт» была бы невозможна.
//
//   node scripts/sync-shared.mjs [путь к egeapp]
//
// По умолчанию — `..`: этот чекаут лежит внутри рабочей копии сайта
// (~/egeapp/boards-server) и заигнорен её .gitignore. Путь можно задать
// аргументом или переменной EGEAPP_DIR.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SHARED_FILES = [
  { from: 'lib/boardSync.ts', to: 'src/shared/boardSync.ts' },
  { from: 'lib/__tests__/boardSync.test.ts', to: 'src/shared/__tests__/boardSync.test.ts' },
]

export const SOURCE_REPO = 'ProjectINT/egeapp'
export const SOURCE_REF = 'main'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function main() {
  const egeapp = resolve(repoRoot, process.argv[2] ?? process.env.EGEAPP_DIR ?? '..')

  const files = {}
  for (const file of SHARED_FILES) {
    const source = join(egeapp, file.from)
    let body
    try {
      body = readFileSync(source)
    } catch {
      console.error(`не найден файл ${source}`)
      console.error(`укажите путь к egeapp: node scripts/sync-shared.mjs <путь>`)
      process.exit(1)
    }

    const target = join(repoRoot, file.to)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, body)
    files[file.from] = sha256(body)
    console.log(`${file.from} → ${file.to}  ${files[file.from].slice(0, 12)}`)
  }

  let commit = null
  let dirty = false
  try {
    commit = execFileSync('git', ['-C', egeapp, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const status = execFileSync(
      'git',
      ['-C', egeapp, 'status', '--porcelain', '--', ...SHARED_FILES.map((f) => f.from)],
      { encoding: 'utf8' }
    ).trim()
    dirty = status.length > 0
  } catch {
    // egeapp может лежать не под git (например, распакованный архив) — тогда
    // коммит просто неизвестен, сверка в CI всё равно идёт по содержимому.
  }

  const lock = { source: SOURCE_REPO, ref: SOURCE_REF, commit, files }
  writeFileSync(join(repoRoot, 'shared.lock.json'), `${JSON.stringify(lock, null, 2)}\n`)
  console.log(`shared.lock.json обновлён (commit ${commit ?? 'неизвестен'})`)

  if (dirty) {
    console.warn(
      'внимание: в egeapp эти файлы изменены и не закоммичены — пока правка не уедет в ' +
        `${SOURCE_REPO}@${SOURCE_REF}, job shared будет красным`
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
