// Обращения к Supabase: адрес, заголовки, ошибки, метрика (§8 плана
// репозитория).
//
// Три адреса на весь сервис — объект в Storage, строка в `board_snapshots`,
// отметка активности в `boards`, — и все три ходят с одним и тем же ключом
// service role. Общего здесь ровно столько: собрать заголовки, отличить
// «ответили не тем» от «не дозвонились» и в обоих случаях подвинуть
// `board_storage_errors_total`, потому что по osn§10 недоступность Storage
// пользователю не видна вовсе и узнать о ней больше неоткуда.
//
// Клиента Supabase здесь нет намеренно: `@supabase/supabase-js` тянет за собой
// realtime и postgrest ради четырёх запросов, которые целиком помещаются в
// `fetch`.

import { storageErrorsTotal } from '../metrics.js'

export type FetchLike = typeof globalThis.fetch

/** Тело запроса в терминах самого `fetch`: глобального `BodyInit` в lib нет. */
type Body = NonNullable<NonNullable<Parameters<FetchLike>[1]>['body']>

/** Куда и чем ходить. Один объект на сервис. */
export interface Supabase {
  /** Без хвостового слэша: `config.ts` его уже срезал. */
  url: string
  serviceRoleKey: string
  /** Параметр ради тестов: в бою — глобальный `fetch`. */
  fetch: FetchLike
}

/**
 * Неудачное обращение. `status === 0` — запрос не дошёл вовсе (DNS, разрыв,
 * таймаут); всё остальное — ответ, который нам не подходит.
 */
export class SupabaseError extends Error {
  constructor(
    readonly op: string,
    readonly status: number,
    readonly detail: string
  ) {
    super(`${op}: ${status === 0 ? 'запрос не дошёл' : `HTTP ${status}`} — ${detail}`)
    this.name = 'SupabaseError'
  }
}

export interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: Buffer | string
  /** Статусы, которые разбирает вызывающий: не ошибка и метрику не двигают. */
  allow?: readonly number[]
}

/** Имя операции в метрике и в логе. Метка `op` у `board_storage_errors_total`. */
export type Op = 'object-get' | 'object-put' | 'snapshot-get' | 'import-put' | 'board-patch'

export function authHeaders(api: Supabase): Record<string, string> {
  return {
    apikey: api.serviceRoleKey,
    authorization: `Bearer ${api.serviceRoleKey}`,
  }
}

export async function request(
  api: Supabase,
  op: Op,
  path: string,
  options: RequestOptions = {}
): Promise<Response> {
  let response: Response

  try {
    response = await api.fetch(`${api.url}${path}`, {
      method: options.method ?? 'GET',
      headers: { ...authHeaders(api), ...options.headers },
      ...(options.body === undefined ? {} : { body: options.body as Body }),
    })
  } catch (error) {
    storageErrorsTotal.inc({ op })
    throw new SupabaseError(op, 0, error instanceof Error ? error.message : String(error))
  }

  if (response.ok || options.allow?.includes(response.status)) return response

  // Тело читаем целиком и обрезаем: storage-api и PostgREST кладут туда причину
  // (`{"error":"not_found"}`, текст ошибки Postgres), а без неё в логе остаётся
  // голый номер, по которому ничего не найти. Ключей в теле не бывает.
  const detail = await response.text().catch(() => '')
  storageErrorsTotal.inc({ op })

  throw new SupabaseError(op, response.status, detail.slice(0, 500))
}
