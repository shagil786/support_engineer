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
    },
  },
});
