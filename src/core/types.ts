// Типы ядра: состояние доски и кадры протокола (osn§5, osn§6.1–6.2, §5 плана
// репозитория).
//
// Главное здесь — StoredElement: сервер не разбирает содержимое элемента
// Excalidraw и не зависит от его версии. Для слияния хватает четырёх полей, а
// тело живёт сырым JSON в Buffer — вне кучи V8. Из-за этого исходящие кадры
// собираются конкатенацией, а не сериализацией документа (см. doc.ts).

import type { SyncElement } from '../shared/boardSync.js'

/** Элемент правил слияния: `(version, versionNonce)` + `isDeleted`. */
export type { SyncElement }

/** Идентификатор соединения; выдаётся транспортом (Ф4), один на сокет. */
export type ConnId = string
export type ElementId = string
export type FileId = string
export type BoardId = string

/**
 * Роль в доске. Считается в egeapp тем же кодом, что и страница комнаты
 * (`roomRoleFor` + `canDraw`), и приезжает сюда claim'ом токена: сервер прав не
 * пересчитывает и в Postgres не ходит.
 */
export type BoardRole = 'edit' | 'view'

/** Claims токена доски (HS256, TTL 2 часа, секрет `BOARD_SERVER_SECRET`). */
export interface Claims {
  /**
   * `actor.id` из egeapp: либо UUID пользователя, либо строка `guest:<uuid>`.
   * Сервер её не разбирает — только сравнивает как строку (лимит соединений,
   * поле `from` в дельтах).
   */
  sub: string
  board: BoardId
  role: BoardRole
  name: string
  /** Unix-секунды, как в JWT. */
  exp: number
  iat?: number
}

/**
 * Что у клиента уже есть: id элемента → его version. Файлы едут отдельным
 * списком id — они неизменяемы, версия им не нужна.
 */
export type StateVector = Record<ElementId, number>

/** Файл сцены: `dataURL` для inline (≤ 128 КБ) либо `url` для внешнего. */
export interface FileRef {
  id: FileId
  mimeType: string
  dataURL?: string
  url?: string
  created?: number
  [key: string]: unknown
}

/** Элемент в долгоживущем состоянии: метаданные слияния + сырое тело. */
export interface StoredElement {
  version: number
  versionNonce: number
  deleted: boolean
  /** JSON элемента целиком, включая `id`, `version`, `versionNonce`. */
  bytes: Buffer
}

/** Файл в долгоживущем состоянии: `id` — ключ карты, тело — сырой JSON. */
export interface StoredFile {
  id: FileId
  bytes: Buffer
}

/**
 * Настройки доски. Один `updatedAt` на всю тройку — так задано в osn§5, и из
 * этого следует, что патч применяется целиком (подробности в `applyAppState`).
 */
export interface DocAppState {
  theme?: string
  viewBackgroundColor?: string
  currentItemFontFamily?: number
  updatedAt: number
}

/** Патч настроек в терминах сцены Excalidraw (кадр `appState` — в терминах UI). */
export interface AppStatePatch {
  theme?: string
  viewBackgroundColor?: string
  currentItemFontFamily?: number
}

export interface BoardDoc {
  /** Включая надгробия: удаление должно доехать до опоздавшего. */
  elements: Map<ElementId, StoredElement>
  files: Map<FileId, Buffer>
  appState: DocAppState
  updatedAt: number
}

/**
 * Сцена Excalidraw в том виде, в каком она лежит в Storage и в наследном
 * `board_snapshots`. Форма совпадает с `BoardScene` из egeapp
 * (`lib/boardSnapshot.ts`); это не общий код, а граница формата — поэтому
 * копией через `sync:shared` не ходит.
 */
export interface BoardScene {
  elements: unknown[]
  appState: {
    theme?: string
    viewBackgroundColor?: string
    currentItemFontFamily?: number
    [key: string]: unknown
  }
  files?: Record<string, unknown>
}

/** Участник комнаты в кадрах `welcome` и `presence`. */
export interface MemberInfo {
  userId: string
  name: string
  role: BoardRole
}

// ——— osn§6.1: кадры клиента ———

/** Версия протокола в `hello`. Несовпадение — `reject`/`error` в Ф4. */
export const PROTOCOL_VERSION = 1

export interface HelloFrame {
  t: 'hello'
  v?: number
  token: string
  /** Пуст при первом входе; при реконнекте — то, что у клиента есть. */
  vector: StateVector
  files: FileId[]
  /** Неподтверждённое: дельты, на которые не пришёл `ack`. */
  outbox?: ClientDeltaFrame[]
}

export interface ClientDeltaFrame {
  t: 'delta'
  /** Номер клиента, растёт монотонно; по нему приходит `ack`. */
  cseq: number
  elements: SyncElement[]
  files?: FileRef[]
}

export interface ClientPointerFrame {
  t: 'pointer'
  x: number
  y: number
}

/** Кадр в терминах UI; в термины сцены его переводит `appStatePatch()`. */
export interface ClientAppStateFrame {
  t: 'appState'
  theme?: string
  font?: number
  background?: string
}

export interface PingFrame {
  t: 'ping'
}

export type ClientFrame =
  | HelloFrame
  | ClientDeltaFrame
  | ClientPointerFrame
  | ClientAppStateFrame
  | PingFrame

// ——— osn§6.2: кадры сервера ———

/**
 * Ответ на `hello`: разница относительно присланного вектора, при пустом
 * векторе — вся сцена. После `welcome` клиент считается догнавшим `seq`.
 *
 * Тип описывает кадр для клиента и тестов; на проводе он собирается
 * конкатенацией в `welcomeFrame()`, а не `JSON.stringify` этого объекта.
 */
export interface WelcomeFrame {
  t: 'welcome'
  seq: number
  role: BoardRole
  elements: SyncElement[]
  files: FileRef[]
  appState: DocAppState
  members: MemberInfo[]
}

/** Чужая правка, уже слитая в `doc`. Клиент применяет `reconcileElements`. */
export interface ServerDeltaFrame {
  t: 'delta'
  seq: number
  /** `sub` автора правки. */
  from: string
  elements: SyncElement[]
  files: FileRef[]
}

export interface AckFrame {
  t: 'ack'
  cseq: number
  seq: number
}

export type RejectReason = 'view-only' | 'too-large' | 'bad-file' | 'bad-version'

export interface RejectFrame {
  t: 'reject'
  cseq: number
  reason: RejectReason
}

export interface ServerPointerFrame {
  t: 'pointer'
  userId: string
  name: string
  x: number
  y: number
}

export interface PresenceFrame {
  t: 'presence'
  members: MemberInfo[]
}

export type ErrorCode = 'token-expired' | 'forbidden' | 'room-closing'

/** После `error` сервер закрывает сокет соответствующим кодом. */
export interface ErrorFrame {
  t: 'error'
  code: ErrorCode
  message: string
}

export interface PongFrame {
  t: 'pong'
}

export type ServerFrame =
  | WelcomeFrame
  | ServerDeltaFrame
  | AckFrame
  | RejectFrame
  | ServerPointerFrame
  | PresenceFrame
  | ErrorFrame
  | PongFrame
