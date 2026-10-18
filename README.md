# dmx-sim (working title)

A browser-based stage-lighting simulator prototype. The current deliverable is a Phase 0 renderer spike, not yet the full editor: it visualizes a small venue with a beat-synced 32-fixture demo and tests the lighting look/performance.

## Run

```sh
npm install
npm run dev
```

Open the Vite URL in a WebGPU-capable browser. The spike uses three.js `WebGPURenderer` and TSL node materials. The browser may use its WebGL2 fallback when WebGPU is unavailable; verify the backend label in the HUD.

## Spike controls

- **Space**: play/pause the 16-bar demo loop
- **1**: toggle beam cones (mesh-based haze proxy, not true raymarched volumetrics)
- **2**: toggle bloom
- **3**: toggle shadows
- **4**: toggle lo-fi posterization
- **5**: opt in/out of brief strobe flashes (off by default)
- **C**: cycle camera presets
- **[ / ]**: cycle fixture counts
- Mouse drag / scroll: orbit and zoom

The HUD reports requestAnimationFrame timing, per-frame draw calls/triangles, current resolution scale, backend, visible fixtures, and show position. rAF timing follows the display refresh rate; it is not a GPU timestamp.

## Tests and checks

```sh
npm test
npm run typecheck
npm run build
```

See [agent_docs/roadmap.md](./agent_docs/roadmap.md), [agent_docs/decisions.md](./agent_docs/decisions.md), [agent_docs/repo-shape.md](./agent_docs/repo-shape.md), [agent_docs/risks.md](./agent_docs/risks.md), and [agent_docs/spike-notes.md](./agent_docs/spike-notes.md) for current direction and spike findings.
