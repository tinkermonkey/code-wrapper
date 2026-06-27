import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/__tests__/live/**/*.live.test.ts'],
    pool: 'forks',
    testTimeout: 120_000,
    maxConcurrency: 1,
    retry: 0,
    passWithNoTests: true,
  },
});
