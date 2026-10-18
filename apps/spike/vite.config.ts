import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@dmxsim/show-model': fileURLToPath(
        new URL('../../packages/show-model/src/index.ts', import.meta.url),
      ),
      '@dmxsim/fixtures': fileURLToPath(
        new URL('../../packages/fixtures/src/index.ts', import.meta.url),
      ),
    },
  },
  server: { port: 5173 },
  build: { target: 'esnext' },
});
