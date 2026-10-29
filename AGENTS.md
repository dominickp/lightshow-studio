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

## Testing hook
`window.__dmxsim` in `apps/studio` drives playback programmatically via Playwright: `seek(sec)`, `play()`, `pause()`, `toggle()`, plus `time`, `playing`, `duration` (null until audio loads) and `fixtureCount`. Use it to scrub the playhead instead of clicking the ruler.

## Render benchmark
Run this when a change could affect frame cost: renderer/materials/shaders, lights, shadows, post-processing, fixture or laser geometry, LED wall, per-frame JS in the `frame()` loop, or timeline painting.

```js
// with the dev server running and the audio loaded:
await window.__dmxsim.benchmark()   // ~3.5 s; returns fps/frameMs/cpuMs percentiles
```
Then `npm run bench:report` prints the delta against the previous run **on this machine** and exits non-zero on a regression.

- The scenario is built from the loaded rig, not from the sample project, so editing `koto-chill.dmxsim` cannot invalidate a comparison. It pins all fixtures, orbit on, a fixed zoom and song time, and **1280×720 rendering at pixel ratio 1** (`fixed-720p-v1`), independent of IDE pane size, dock height or display DPR. The preview may be clipped during the run; normal sizing is restored afterwards. Awaiting the benchmark also waits for history persistence.
- Comparison is gated on hardware id (`machine.id`, from GPU + cores + browser), render protocol/dimensions, backend, rig and scenario options. Reports search all history, not just the displayed rows. Legacy viewport-sized runs are never compared with fixed-size runs; the new protocol needs two runs to establish a delta. Never compare a laptop run to a desktop run. Timeline/UI work and compositor/vsync can still vary with the host window; this pins the 3D workload, not the entire browser.
- `fps.p50` can be vsync-capped; when it hits the refresh rate, judge `cpuMs.p50` and `drawCalls` instead.
- History: `docs/agent_docs/perf-runs.jsonl` (append-only, last 200 runs, committed on purpose).
