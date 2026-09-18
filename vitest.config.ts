import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Обязательно: src/shared/__tests__/boardSync.test.ts — побайтовая копия
    // теста из egeapp, написанного для jest. Он рассчитывает на глобальные
    // describe/it/expect, и править его здесь запрещено (§2 плана репозитория).
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Интеграционный тест поднимает настоящий сервис, и его лог в stdout
    // забивает вывод прогона: половина тестов там — отказы, каждый со своей
    // строкой. Уровень можно вернуть на время разбора: LOG_LEVEL=debug npm test.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
  },
})
