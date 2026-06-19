import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    pool: 'forks',      // isolate process.env changes per test file
    testTimeout: 15_000, // 15 s covers SIGKILL escalation tests
  },
});
