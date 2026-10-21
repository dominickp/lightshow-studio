import { defineConfig, type Plugin } from 'vite';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Dev-only endpoint that persists render benchmark runs so a later run can be
 * compared against an earlier one.
 *
 * - `POST /__bench` appends one JSON result to `docs/agent_docs/perf-runs.jsonl`
 * - `GET /__bench`  returns the history as a JSON array, oldest first
 *
 * The file is newline-delimited JSON on purpose: it diffs cleanly in git and an
 * agent can read the last few runs with `tail` instead of driving the browser.
 */
const historyPath = fileURLToPath(new URL('../../docs/agent_docs/perf-runs.jsonl', import.meta.url));
const MAX_RUNS = 200;
const MAX_BODY_BYTES = 64 * 1024;

const readHistory = (): string[] => {
  try {
    return readFileSync(historyPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
};

const writeHistory = (lines: string[]): void => {
  mkdirSync(dirname(historyPath), { recursive: true });
  writeFileSync(historyPath, `${lines.slice(-MAX_RUNS).join('\n')}\n`);
};

function perfHistoryPlugin(): Plugin {
  return {
    name: 'dmxsim-perf-history',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__bench', (request, response) => {
        if (request.method === 'GET') {
          const runs = readHistory();
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(`[${runs.join(',')}]`);
          return;
        }
        if (request.method !== 'POST') {
          response.statusCode = 405;
          response.end('GET or POST only');
          return;
        }

        let body = '';
        let overflow = false;
        request.on('data', (chunk: Buffer) => {
          body += chunk.toString();
          if (body.length > MAX_BODY_BYTES) {
            overflow = true;
            request.destroy();
          }
        });
        request.on('end', () => {
          if (overflow) {
            response.statusCode = 413;
            response.end('benchmark result too large');
            return;
          }
          try {
            // Re-serialize so the history stays one object per line.
            const line = JSON.stringify(JSON.parse(body));
            const lines = readHistory();
            appendFileSync(historyPath, `${line}\n`);
            if (lines.length + 1 > MAX_RUNS) writeHistory([...lines, line]);
            response.statusCode = 204;
            response.end();
          } catch {
            response.statusCode = 400;
            response.end('invalid JSON');
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [perfHistoryPlugin()],
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
