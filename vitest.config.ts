import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@dmxsim/show-model': fileURLToPath(new URL('./packages/show-model/src/index.ts', import.meta.url)),
      '@dmxsim/fixtures': fileURLToPath(new URL('./packages/fixtures/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/src/**/*.test.ts'],
    environment: 'node',
  },
});
