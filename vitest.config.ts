import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      // Report real source coverage (fixtures/demo scripts are not shipped behavior).
      include: ['src/**/*.ts'],
      exclude: ['src/fixtures/**'],
      reporter: ['text', 'html'],
      // Ratchet just under the 2026-09-14 baseline (89/81/89/92): a coverage
      // drop fails the run; raising the floor is the only way down.
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 88 },
    },
  },
});
