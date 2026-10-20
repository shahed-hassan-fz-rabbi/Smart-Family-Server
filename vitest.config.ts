import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    // The integration suite boots an in-memory MongoDB; on a fresh machine the
    // MongoDB binary is downloaded once into node_modules/.cache, which takes minutes.
    hookTimeout: 600_000,
    testTimeout: 30_000,
  },
});
