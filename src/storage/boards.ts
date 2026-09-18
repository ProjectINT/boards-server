// Отметка активности доски: `PATCH /rest/v1/boards?id=eq.<id>` (§8 плана
// репозитория).
//
// По этому полю список кабинета сортирует доски, «недавние сверху». Раньше его
// обновлял клиент после каждого сохранения; теперь снимок пишет сервер, и
// обновлять поле стало некому.
//
// Значение в теле роли не играет: триггер `trg_boards_updated_at` перепишет
// `updated_at` через `update_updated_at_column()`. Важен сам факт UPDATE,
// поэтому и отдельного RPC не нужно. Строка `"now"` выбрана как самое короткое,
// что Postgres примет за timestamptz.

import type { BoardId } from '../core/types.js'
import { request } from './http.js'
import type { Supabase } from './http.js'

export async function touchBoard(api: Supabase, boardId: BoardId): Promise<void> {
  await request(api, 'board-patch', `/rest/v1/boards?id=eq.${encodeURIComponent(boardId)}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      // Ответ не нужен: без этого PostgREST вернул бы обновлённую строку доски.
      prefer: 'return=minimal',
    },
    body: JSON.stringify({ updated_at: 'now' }),
  })
}
