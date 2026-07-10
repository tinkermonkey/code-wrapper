import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/__tests__/live/**', 'src/__tests__/e2e/**'],
    pool: 'forks',      // isolate process.env changes per test file
    testTimeout: 15_000, // 15 s covers SIGKILL escalation tests
  },
});
