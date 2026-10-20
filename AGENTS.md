## User docs
`./docs/user_docs` is where the user places their docs. Never modify these.

## Agent docs
`./docs/agent_docs` is where agents may document things. Do not use this as a messy dumping ground.

## Quality gates
Run `npm run check` before reporting a task complete. It runs, in order:

- `npm run typecheck` — `tsc -b`
- `npm run lint` — ESLint (flat config in `eslint.config.js`); warnings are
  visible but do not fail the run, errors do
- `npm run knip` — unused files, exports, and dependencies (config in `knip.json`)
- `npm test` — Vitest

When ESLint flags a `prefer-const` forward declaration that a closure needs,
add a short `// eslint-disable-next-line prefer-const` with the reason rather
than restructuring the code. Keep `packages/show-model` free of `three`
imports; the lint config enforces it with `no-restricted-imports`.

## Testing hook (lighting spike)
`window.__dmxsim` in `apps/lighting-spike` drives playback programmatically via Playwright: `seek(sec)`, `play()`, `pause()`, `toggle()`, plus `time`, `playing`, `duration` (null until audio loads) and `fixtureCount`. Use it to scrub the playhead instead of clicking the ruler.

## Render benchmark (lighting spike)
Run this when a change could affect frame cost: renderer/materials/shaders, lights, shadows, post-processing, fixture or laser geometry, LED wall, per-frame JS in the `frame()` loop, or timeline painting.

```js
// with the dev server running and the audio loaded:
await window.__dmxsim.benchmark()   // ~3.5 s; returns fps/frameMs/cpuMs percentiles
```
Then `npm run bench:report` prints the delta against the previous run **on this machine** and exits non-zero on a regression.

- The scenario is built from the loaded rig, not from the sample project, so editing `koto-chill.dmxsim` cannot invalidate a comparison. It pins all fixtures, orbit on, 100% resolution scale, a fixed zoom and a fixed song time, and restores your previous state afterwards.
- Comparison is gated on hardware id (`machine.id`, from GPU + cores + browser) and viewport. Never compare a laptop run to a desktop run.
- `fps.p50` can be vsync-capped; when it hits the refresh rate, judge `cpuMs.p50` and `drawCalls` instead.
- History: `docs/agent_docs/perf-runs.jsonl` (append-only, last 200 runs, committed on purpose).
