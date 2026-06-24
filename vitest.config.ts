import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'suncode',
    // Run both new vitest tests and migrated bun:test files
    include: ['test/**/*.test.ts', 'src/worker/tools/*.test.ts'],
    // Kimi Code style: no globals, explicit imports
    globals: false,
    // pi style: 30s timeout + node environment
    environment: 'node',
    testTimeout: 30_000,
    // Coverage: v8 provider, same pattern as Kimi Code
    coverage: {
      provider: 'v8',
      include: ['src/worker/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.spec.ts', 'dist/**'],
      reporter: ['text', 'html'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
});
