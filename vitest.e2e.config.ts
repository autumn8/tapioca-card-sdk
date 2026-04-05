import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    maxWorkers: 1, // Ensure tests run sequentially to avoid concurrent card access issues
  },
});
