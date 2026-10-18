# Lighting spike (`@dmxsim/lighting-spike`)

Phase 0 renderer/performance experiment for dmx-sim. It renders a procedural club/stage venue with a beat-synced 32-fixture demo show to answer two questions: does the lighting look work, and what fixture budget can we afford? The spike's renderer code is disposable; stable pieces get extracted into `packages/renderer` later.

Findings live in [../../docs/agent_docs/spike-notes.md](../../docs/agent_docs/spike-notes.md).

## Run

```sh
npm run dev        # from the repo root, or: npm run dev -w @dmxsim/lighting-spike
```

Open the Vite URL in a WebGPU-capable browser. Uses three.js `WebGPURenderer` with TSL node materials; the browser may fall back to WebGL2 — verify with the backend label in the HUD.

## Controls

- **Space**: play/pause the 16-bar demo loop (128 BPM)
- **1**: toggle beam cones (mesh-based haze proxy, not true raymarched volumetrics)
- **2**: toggle bloom
- **3**: toggle shadows
- **4**: toggle lo-fi posterization
- **5**: opt in/out of brief strobe flashes (off by default)
- **C**: cycle camera presets
- **[ / ]**: cycle fixture counts
- Mouse drag / scroll: orbit and zoom

The HUD reports requestAnimationFrame timing, per-frame draw calls/triangles, resolution scale, backend, active fixtures, and show position. rAF timing follows the display refresh rate; it is not a GPU timestamp.