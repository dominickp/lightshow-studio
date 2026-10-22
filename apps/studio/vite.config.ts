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

/**
 * Public base path for the built app.
 *
 * GitHub Pages serves a project site from `https://<owner>.github.io/<repo>/`,
 * so every emitted asset URL has to carry that prefix; with the default `/`
 * the JS/CSS/audio/video all 404. `GITHUB_REPOSITORY` is set by Actions, so CI
 * derives the path without extra config, while local `dev`, `build` and
 * `preview` keep the root base. Override with `VITE_BASE` for a custom domain
 * or a rename (`VITE_BASE=/ npm run build`).
 */
const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1];
const base = process.env.VITE_BASE ?? (repositoryName === undefined ? '/' : `/${repositoryName}/`);

/**
 * Absolute URL the site is served from, used for link-preview metadata.
 *
 * Facebook, Slack, Discord and friends will not reliably resolve relative
 * `og:image` URLs, so the tags need the full origin. CI provides
 * `GITHUB_REPOSITORY`, which is enough to reconstruct a project page; set
 * `SITE_URL` for a custom domain (e.g. `SITE_URL=https://lightshow.studio/`).
 */
const siteUrl = (() => {
  const override = process.env.SITE_URL;
  if (override !== undefined) return `${override.replace(/\/+$/, '')}/`;
  const [owner, name] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
  if (owner && name) return `https://${owner}.github.io/${name}/`;
  return 'http://localhost:5173/';
})();

const DESCRIPTION =
  'A browser-based stage-lighting simulator: build a DMX rig out of moving heads, ' +
  'washes, lasers and LED walls, program clips on a timeline, and play the show back ' +
  'in sync with your song.';

const IMAGE_ALT =
  'Lightshow Studio: a 3D club stage lit by laser and moving-head beams, ' +
  'with a DAW-style lighting timeline underneath.';

/**
 * Injects Open Graph / Twitter card metadata so shared links render a preview
 * image, title and description instead of a bare URL.
 *
 * The image lives in `public/`, so it ships with the build and is reachable at
 * `${siteUrl}social-card.jpg`. Bump the filename when the image changes: social
 * platforms cache previews by URL and will otherwise keep showing the old one.
 */
function socialMetaPlugin(): Plugin {
  const tags = [
    { name: 'description', content: DESCRIPTION },
    { property: 'og:type', content: 'website' },
    { property: 'og:site_name', content: 'Lightshow Studio' },
    { property: 'og:title', content: 'Lightshow Studio' },
    { property: 'og:description', content: DESCRIPTION },
    { property: 'og:url', content: siteUrl },
    { property: 'og:image', content: `${siteUrl}social-card.jpg` },
    { property: 'og:image:type', content: 'image/jpeg' },
    { property: 'og:image:width', content: '1200' },
    { property: 'og:image:height', content: '630' },
    { property: 'og:image:alt', content: IMAGE_ALT },
    { name: 'twitter:card', content: 'summary_large_image' },
    { name: 'twitter:title', content: 'Lightshow Studio' },
    { name: 'twitter:description', content: DESCRIPTION },
    { name: 'twitter:image', content: `${siteUrl}social-card.jpg` },
    { name: 'twitter:image:alt', content: IMAGE_ALT },
  ];

  return {
    name: 'dmxsim-social-meta',
    transformIndexHtml() {
      return tags.map((tag) => ({
        tag: 'meta',
        attrs: tag,
        injectTo: 'head' as const,
      }));
    },
  };
}

export default defineConfig({
  base,
  plugins: [perfHistoryPlugin(), socialMetaPlugin()],
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
