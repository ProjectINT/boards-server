import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Обязательно: src/shared/__tests__/boardSync.test.ts — побайтовая копия
    // теста из egeapp, написанного для jest. Он рассчитывает на глобальные
    // describe/it/expect, и править его здесь запрещено (§2 плана репозитория).
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
})
