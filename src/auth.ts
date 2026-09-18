// Проверка токена доски (osn§7, §7 плана репозитория, шаг 5 порядка проверок).
//
// Токен подписывает сайт тем же секретом `BOARD_SERVER_SECRET`; сервис только
// проверяет подпись и claims и в Postgres не ходит. Права при этом считаются
// на стороне сайта тем же кодом, что и страница комнаты (`resolveRoomActor` +
// `roomRoleFor` + `canDraw`), — сюда приезжает уже готовая роль.
//
// Модуль намеренно не знает ни про сокеты, ни про конфигурацию: на вход —
// строка и ключ, на выход — разобранные claims либо типизированный отказ.
// Поэтому его тест (`test/auth.test.ts`) обходится без сети.

import { jwtVerify } from 'jose'

import type { BoardId, BoardRole, Claims } from './core/types.js'

/**
 * Допуск на расхождение часов сайта и сервиса (§7). Секунды: столько же
 * понимает `clockTolerance` у `jose`.
 */
export const CLOCK_TOLERANCE_S = 60

/** Единственный допустимый алгоритм. Список закрыт: иначе токен с `alg: none` или
 * подписанный чужим ключом по RS256 прошёл бы проверку подписи «успешно». */
const ALGORITHMS = ['HS256']

const ROLES: readonly string[] = ['edit', 'view'] satisfies readonly BoardRole[]

/**
 * Почему токен не принят. `expired` отличается от остальных: клиенту на него
 * отвечают `error token-expired`, и он идёт за новым токеном (osn§10), а на
 * прочие — `error forbidden`, после которого идти некуда.
 */
export type AuthFailure = 'expired' | 'bad-signature' | 'bad-claims' | 'wrong-board'

export type AuthResult =
  | { ok: true; claims: Claims }
  | { ok: false; reason: AuthFailure; detail: string }

/**
 * Ключ подписи из секрета окружения. Секрет берётся как строка в UTF-8 — ровно
 * так его понимает `jsonwebtoken` на стороне сайта, когда ему отдают строковый
 * секрет. Декодировать base64 нельзя: сайт этого не делает, и ключи разъехались
 * бы на первом же токене.
 */
export function boardTokenKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

/** Токен протух — по тексту ошибки `jose` его не отличить надёжно, по классу — да. */
function isExpired(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ERR_JWT_EXPIRED'
}

/**
 * @param raw     значение поля `token` кадра `hello`, каким оно пришло с провода
 * @param key     результат `boardTokenKey`
 * @param board   доска, запрошенная соединением (из строки запроса сокета);
 *                `null` означает «клиент доску не назвал» и отклоняется: без
 *                неё проверка «токен от этой доски» выродилась бы в тавтологию
 * @param now     точка отсчёта для `exp`; параметр — ради теста, в бою `undefined`
 */
export async function verifyBoardToken(
  raw: unknown,
  key: Uint8Array,
  board: BoardId | null,
  now?: Date
): Promise<AuthResult> {
  if (typeof raw !== 'string' || raw === '') {
    return { ok: false, reason: 'bad-claims', detail: 'в hello нет токена' }
  }
  if (board === null || board === '') {
    return { ok: false, reason: 'wrong-board', detail: 'соединение не назвало доску' }
  }

  let payload: Record<string, unknown>
  try {
    const verified = await jwtVerify(raw, key, {
      algorithms: ALGORITHMS,
      clockTolerance: CLOCK_TOLERANCE_S,
      ...(now ? { currentDate: now } : {}),
    })
    payload = verified.payload as Record<string, unknown>
  } catch (error) {
    if (isExpired(error)) return { ok: false, reason: 'expired', detail: 'срок токена истёк' }
    return {
      ok: false,
      reason: 'bad-signature',
      detail: error instanceof Error ? error.message : 'подпись не проверена',
    }
  }

  const { sub, board: claimBoard, role, name, exp, iat } = payload

  // `exp` проверен выше, но только если он есть: без него `jose` пропускает
  // токен как бессрочный, а бессрочный пропуск к доске — это не пропуск.
  if (typeof exp !== 'number') {
    return { ok: false, reason: 'bad-claims', detail: 'в токене нет exp' }
  }
  if (typeof sub !== 'string' || sub === '') {
    return { ok: false, reason: 'bad-claims', detail: 'в токене нет sub' }
  }
  if (typeof claimBoard !== 'string' || claimBoard === '') {
    return { ok: false, reason: 'bad-claims', detail: 'в токене нет board' }
  }
  if (typeof role !== 'string' || !ROLES.includes(role)) {
    return { ok: false, reason: 'bad-claims', detail: `роль ${String(role)} неизвестна` }
  }
  if (typeof name !== 'string') {
    return { ok: false, reason: 'bad-claims', detail: 'в токене нет name' }
  }

  // Токен от соседней доски — рабочий токен: подпись верна, срок не вышел.
  // Без этой проверки участник одного урока открыл бы сокет на чужую доску.
  if (claimBoard !== board) {
    return { ok: false, reason: 'wrong-board', detail: `токен на доску ${claimBoard}` }
  }

  return {
    ok: true,
    claims: {
      sub,
      board: claimBoard,
      role: role as BoardRole,
      name,
      exp,
      ...(typeof iat === 'number' ? { iat } : {}),
    },
  }
}
