// Проверка токена доски (§7, шаг 5 порядка проверок). Сети здесь нет: на вход
// строка и ключ, на выход claims или типизированный отказ.

import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'

import { CLOCK_TOLERANCE_S, boardTokenKey, verifyBoardToken } from '../src/auth.js'
import { tokenExpiryDelayMs } from '../src/transport.js'

const BOARD = '11111111-1111-1111-1111-111111111111'
const OTHER_BOARD = '22222222-2222-2222-2222-222222222222'
const SECRET = 'r7Yb0Qm1s5dP2nK8xW4vT6hJ3cL9gZ0aE5uF1iO7pR8='
const key = boardTokenKey(SECRET)

const NOW_S = 1_800_000_000

interface TokenOptions {
  board?: string
  role?: string
  name?: string
  sub?: string
  exp?: number | null
  secret?: string
  alg?: string
}

async function token(options: TokenOptions = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    board: options.board ?? BOARD,
    role: options.role ?? 'edit',
    name: options.name ?? 'Мария Петровна',
  }

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: options.alg ?? 'HS256' })
    .setSubject(options.sub ?? 'd0f1e2a3-0000-0000-0000-000000000001')
    .setIssuedAt(NOW_S)

  // `exp: null` — намеренно бессрочный токен: `jose` такой пропускает, и
  // отсутствие срока должно ловиться нами.
  if (options.exp !== null) jwt = jwt.setExpirationTime(options.exp ?? NOW_S + 7200)

  return jwt.sign(boardTokenKey(options.secret ?? SECRET))
}

function at(offsetS: number): Date {
  return new Date((NOW_S + offsetS) * 1000)
}

describe('verifyBoardToken', () => {
  it('принимает свой токен и отдаёт claims', async () => {
    const result = await verifyBoardToken(await token(), key, BOARD, at(0))

    expect(result).toEqual({
      ok: true,
      claims: {
        sub: 'd0f1e2a3-0000-0000-0000-000000000001',
        board: BOARD,
        role: 'edit',
        name: 'Мария Петровна',
        exp: NOW_S + 7200,
        iat: NOW_S,
      },
    })
  })

  it('роль view доезжает как есть', async () => {
    const result = await verifyBoardToken(await token({ role: 'view' }), key, BOARD, at(0))

    expect(result.ok && result.claims.role).toBe('view')
  })

  it('гостевой sub не разбирается, а переносится строкой', async () => {
    const guest = 'guest:8c7b6a55-4433-2211-0099-887766554433'
    const result = await verifyBoardToken(await token({ sub: guest }), key, BOARD, at(0))

    expect(result.ok && result.claims.sub).toBe(guest)
  })

  it('протухший токен отличается от прочих отказов', async () => {
    const raw = await token({ exp: NOW_S + 60 })
    const result = await verifyBoardToken(raw, key, BOARD, at(3600))

    expect(result).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('расхождение часов в допуске протухшим не считается', async () => {
    const raw = await token({ exp: NOW_S })

    // Сайт подписал токен по своим часам, сервис живёт по своим: минута
    // разницы не должна выбрасывать участника из комнаты.
    expect(await verifyBoardToken(raw, key, BOARD, at(CLOCK_TOLERANCE_S - 1))).toMatchObject({ ok: true })
    expect(await verifyBoardToken(raw, key, BOARD, at(CLOCK_TOLERANCE_S + 2))).toMatchObject({
      ok: false,
      reason: 'expired',
    })
  })

  it('токен на чужую доску не пускает', async () => {
    const raw = await token({ board: OTHER_BOARD })
    const result = await verifyBoardToken(raw, key, BOARD, at(0))

    expect(result).toMatchObject({ ok: false, reason: 'wrong-board' })
  })

  it('соединение, не назвавшее доску, не пускает', async () => {
    const result = await verifyBoardToken(await token(), key, null, at(0))

    expect(result).toMatchObject({ ok: false, reason: 'wrong-board' })
  })

  it('чужая подпись не проходит', async () => {
    const raw = await token({ secret: 'совсем другой секрет' })
    const result = await verifyBoardToken(raw, key, BOARD, at(0))

    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' })
  })

  it('испорченный токен не роняет проверку', async () => {
    const raw = `${await token()}щ`

    expect(await verifyBoardToken(raw, key, BOARD, at(0))).toMatchObject({ ok: false, reason: 'bad-signature' })
    expect(await verifyBoardToken('не токен вовсе', key, BOARD, at(0))).toMatchObject({ ok: false })
    expect(await verifyBoardToken(undefined, key, BOARD, at(0))).toMatchObject({ ok: false, reason: 'bad-claims' })
    expect(await verifyBoardToken(42, key, BOARD, at(0))).toMatchObject({ ok: false, reason: 'bad-claims' })
  })

  it('алгоритм только HS256', async () => {
    // Классическая подделка: заголовок `alg: none` и пустая подпись.
    const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: 'x', board: BOARD, role: 'edit', name: 'x', exp: NOW_S + 7200 })
    ).toString('base64url')
    const result = await verifyBoardToken(`${header}.${payload}.`, key, BOARD, at(0))

    expect(result).toMatchObject({ ok: false, reason: 'bad-signature' })
  })

  it('бессрочный токен не принимается', async () => {
    const result = await verifyBoardToken(await token({ exp: null }), key, BOARD, at(0))

    expect(result).toMatchObject({ ok: false, reason: 'bad-claims' })
  })

  it('неизвестная роль не принимается', async () => {
    const result = await verifyBoardToken(await token({ role: 'admin' }), key, BOARD, at(0))

    expect(result).toMatchObject({ ok: false, reason: 'bad-claims' })
  })
})

describe('срок соединения', () => {
  it('считается от exp с тем же допуском, что и проверка', () => {
    const exp = NOW_S + 7200
    const grace = CLOCK_TOLERANCE_S * 1000

    expect(tokenExpiryDelayMs(exp, NOW_S * 1000, grace)).toBe(7200_000 + grace)
    // Токен, принятый по допуску: закрывать надо не «в прошлом», а сейчас.
    expect(tokenExpiryDelayMs(NOW_S, (NOW_S + 3600) * 1000, grace)).toBe(0)
  })
})
