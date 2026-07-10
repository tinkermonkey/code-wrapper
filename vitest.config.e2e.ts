import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/e2e/**/*.e2e.test.ts'],
    pool: 'forks',
    testTimeout: 180_000,
    maxConcurrency: 1,
    retry: 0,
    passWithNoTests: true,
  },
});
