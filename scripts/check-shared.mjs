#!/usr/bin/env node
// Сверяет копию правил слияния с оригиналом в egeapp@main.
//
// Зачем: winsOver обязана вести себя одинаково у клиента и у сервера.
// Разойдутся — доски разъедутся навсегда и молча, потому что LWW без общего
// порядка сравнения перестаёт сходиться. Проверка идёт по содержимому, не по
// записи в shared.lock.json: испорченная руками копия должна ловиться даже
// тогда, когда lock не трогали.
//
// Нужен read-only PAT с правом `contents: read` в EGEAPP_READ_TOKEN — репозиторий
// сайта приватный. В CI это отдельный job, он же ходит по расписанию раз в
// сутки: правку сделают в egeapp, а сюда месяц не будет пушей.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SHARED_FILES, SOURCE_REF, SOURCE_REPO, repoRoot, sha256 } from './sync-shared.mjs'

const API = 'https://api.github.com'

async function fetchFromGitHub(path, token) {
  const url = `${API}/repos/${SOURCE_REPO}/contents/${path}?ref=${SOURCE_REF}`
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github.raw',
      authorization: `Bearer ${token}`,
      'user-agent': 'boards-server-check-shared',
      'x-github-api-version': '2022-11-28',
    },
  })

  if (!response.ok) {
    throw new Error(
      `GitHub ответил ${response.status} на ${SOURCE_REPO}/${path}@${SOURCE_REF}: ` +
        `${(await response.text()).slice(0, 200)}`
    )
  }

  return Buffer.from(await response.arrayBuffer())
}

const token = process.env.EGEAPP_READ_TOKEN
if (!token) {
  console.error('нет EGEAPP_READ_TOKEN: нужен read-only PAT с доступом к ' + SOURCE_REPO)
  process.exit(1)
}

const diverged = []

for (const file of SHARED_FILES) {
  const remote = sha256(await fetchFromGitHub(file.from, token))
  const local = sha256(readFileSync(join(repoRoot, file.to)))

  if (remote === local) {
    console.log(`ок  ${file.to}  ${local.slice(0, 12)}`)
    continue
  }

  diverged.push(file)
  console.error(`РАСХОЖДЕНИЕ  ${file.to}`)
  console.error(`  здесь:          ${local}`)
  console.error(`  ${SOURCE_REPO}@${SOURCE_REF}/${file.from}: ${remote}`)
}

if (diverged.length > 0) {
  console.error('')
  console.error('правила слияния разошлись: обнови src/shared/ через npm run sync:shared')
  process.exit(1)
}

console.log(`копия совпадает с ${SOURCE_REPO}@${SOURCE_REF}`)
