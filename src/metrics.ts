import { Counter, Gauge, Histogram, Registry, Summary } from '@prometheus-io/client'

// Реестр метрик (osn§11: комнаты, сокеты, дельты/с, ошибки Storage, размер
// outbox по p95; §7 плана репозитория — задержка рассылки).
//
// Эндпоинт /metrics существует с Ф1, чтобы dockhost и Prometheus настраивались
// один раз; наполняется он здесь.
//
// Метрики процесса (collectDefaultMetrics) сознательно не включены: heap, GC и
// дескрипторы дают полсотни рядов, которые в этом сервисе ничего не объясняют
// (документ лежит в буферах — вне кучи V8, и рост RSS по heap не виден).
// Что снимать про память, станет понятно после пилота.
export const metrics = new Registry()

// Размеры документа — Gauge, а не Counter: это «сколько сейчас», и значение
// умеет уменьшаться (комната выселилась, доску почистили). Без меток: метка
// board дала бы ряд на каждую доску, а их тысячи и они приходят и уходят.
// Обе метрики выставляет Ф5 при записи в Storage — там документ и так в руках.

/**
 * Сколько весят тела удалённых элементов во всех комнатах. По этому числу через
 * месяц пилота станет видно, нужно ли сжимать надгробия (osn§15, вопрос 5), —
 * вместо того чтобы гадать сейчас.
 */
export const tombstoneBytes = new Gauge({
  name: 'board_tombstone_bytes',
  help: 'Суммарный размер тел удалённых элементов (надгробий) во всех комнатах',
  registers: [metrics],
})

/** Сколько весят документы всех комнат: тела элементов и файлов. */
export const docBytes = new Gauge({
  name: 'board_doc_bytes',
  help: 'Суммарный размер документов комнат в памяти (тела элементов и файлов)',
  registers: [metrics],
})

/** Сколько комнат сейчас в памяти. Ведёт `rooms.ts`. */
export const roomsGauge = new Gauge({
  name: 'board_rooms',
  help: 'Комнаты, поднятые в памяти сервиса',
  registers: [metrics],
})

/**
 * Сколько сокетов сейчас открыто. Именно сокетов, а не людей: четыре вкладки
 * одного участника — четыре соединения и один `userId` в `presence`.
 */
export const connectionsGauge = new Gauge({
  name: 'board_connections',
  help: 'Открытые соединения с сервисом',
  registers: [metrics],
})

/**
 * Принятые дельты. «Дельты/с» из osn§11 — это `rate()` от счётчика: считать
 * скорость самим значило бы держать окно и врать на его границах.
 */
export const deltasTotal = new Counter({
  name: 'board_deltas_total',
  help: 'Кадры delta, принятые от клиентов',
  registers: [metrics],
})

/**
 * Задержка `delta → broadcast`: сколько прошло от разбора кадра до того, как
 * рассылка ушла в сокеты. Это стоимость слияния и сборки кадров внутри
 * сервиса, без сети, — то, чем сервис управляет. Бакеты в секундах, от
 * четверти миллисекунды: на пустой комнате слияние укладывается в неё, и
 * интересен как раз момент, когда перестаёт.
 */
export const deltaBroadcastSeconds = new Histogram({
  name: 'board_delta_broadcast_seconds',
  help: 'Задержка от приёма кадра delta до отправки рассылки',
  buckets: [0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
  registers: [metrics],
})

/**
 * Ошибки обращений к Storage. Счётчик заводится здесь, растить его начинает
 * Ф5: по osn§10 недоступность Storage пользователю не видна вовсе, и кроме
 * метрики о ней узнать неоткуда.
 */
export const storageErrorsTotal = new Counter({
  name: 'board_storage_errors_total',
  help: 'Неудачные обращения к Supabase Storage',
  labelNames: ['op'],
  registers: [metrics],
})

/**
 * Сколько дельт приезжает в `outbox` кадра `hello`, по квантилям (osn§11).
 * Это прямая мера того, ради чего затеян протокол: outbox не пуст ровно тогда,
 * когда клиент рисовал в разрыв. Растущий p95 — признак, что рвётся часто.
 */
export const outboxSize = new Summary({
  name: 'board_outbox_size',
  help: 'Число дельт в outbox кадра hello',
  percentiles: [0.5, 0.9, 0.95, 0.99],
  registers: [metrics],
})

/**
 * Закрытия соединений с причиной. По нему видно, закрывает ли сервис сокеты
 * сам и почему: 1008 пачкой — кто-то ломится с чужим токеном, 1013 — клиенты
 * не успевают читать, 1012 — прошёл деплой.
 */
export const closesTotal = new Counter({
  name: 'board_connection_closes_total',
  help: 'Соединения, закрытые сервисом, по причине',
  labelNames: ['reason'],
  registers: [metrics],
})

/**
 * Курсоры, выброшенные бэкпрешером (osn§6.4). Отдельно от прореживания в ядре:
 * там отбрасывается лишняя частота, здесь — медленный получатель.
 */
export const pointersDroppedTotal = new Counter({
  name: 'board_pointers_dropped_total',
  help: 'Кадры pointer, не отправленные из-за переполненного буфера получателя',
  registers: [metrics],
})
