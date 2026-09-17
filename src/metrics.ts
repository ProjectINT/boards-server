import { Registry } from 'prom-client'

// Реестр пока пуст: счётчики соединений, кадров, задержки и board_tombstone_bytes
// заводит фаза Ф4 вместе с транспортом. Эндпоинт /metrics существует с самого
// начала, чтобы dockhost и Prometheus настраивались один раз.
//
// Метрики процесса (collectDefaultMetrics) сознательно не включены: их набор —
// часть работы Ф4, где будет видно, что именно снимать.
export const metrics = new Registry()
