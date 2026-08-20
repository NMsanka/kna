import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/*.test.ts', '**/fixtures/**'],
      thresholds: { lines: 60, functions: 60, branches: 55, statements: 60 },
    },
  },
});
