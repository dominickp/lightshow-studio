# Lighting spike (`@dmxsim/lighting-spike`)

Phase 0 renderer/performance experiment for dmx-sim. It renders a procedural club/stage venue with a 32-fixture rig driven by an editable arrangement to answer two questions: does the lighting look work, and what fixture budget can we afford? The spike's renderer code is disposable; stable pieces get extracted into `packages/renderer` later.

The stage has no hard-coded lighting effects. The rig and the 16-bar demo arrangement are loaded from [../../resources/sample_projects/koto-chill/koto-chill.dmxsim](../../resources/sample_projects/koto-chill/koto-chill.dmxsim) at startup — the project file sits next to the audio it scores, so it is easy to find and overwrite. Playback evaluates exactly those clips, so moving, resizing, or deleting a clip changes the light on screen. **Save project** downloads the current rig, timeline, clips, and settings as a `.dmxsim` file; **Open project** validates one and applies it. Edit the demo file on disk and reload the page to iterate on it, or run `npm run project:generate` (repo root) to rebuild it from [src/demo-arrangement.ts](src/demo-arrangement.ts). Format spec: [../../docs/agent_docs/project-file-format.md](../../docs/agent_docs/project-file-format.md).

Playback is driven by the audio clock prototype ([src/audio-clock.ts](src/audio-clock.ts)): song time comes from `AudioContext`, not from frame deltas, and the transport strip scrubs a real waveform with the beat grid drawn on it.

Findings live in [../../docs/agent_docs/spike-notes.md](../../docs/agent_docs/spike-notes.md).

## Audio

The demo loads `resources/sample_projects/koto-chill/The Koto Chill.ogg` (zircon, third-party music). Vite bundles it into production output; confirm distribution rights before publishing. Its beat grid was measured offline, not detected at import time: **130.00 BPM**, first beat at 0.02 s, default loop bars 41–56. Those constants live in [src/track.ts](src/track.ts) and are a placeholder for the real import-time analysis described in ADR-003.

## Run

```sh
npm run dev        # from the repo root, or: npm run dev -w @dmxsim/lighting-spike
```

Open the Vite URL in a WebGPU-capable browser. Uses three.js `WebGPURenderer` with TSL node materials; the browser may fall back to WebGL2 — verify with the backend label in the HUD.

## Controls

- **Space**: play/pause the audio and the lighting arrangement
- **Click / drag the waveform**: scrub
- **L**: toggle audio looping (clips play at their absolute song times)
- **1**: toggle beam cones (mesh-based haze proxy, not true raymarched volumetrics)
- **2**: toggle bloom
- **3**: toggle shadows
- **4**: toggle fixture strobes (on by default)
- **C**: cycle camera presets
- **O**: toggle a slow orbit across the front of the stage, with a gentle rise/fall and zoom breathing
- **[ / ]**: cycle fixture counts
- Mouse drag / scroll: orbit and zoom

Drag a lane to add a clip, drag a clip to move it, drag its edge to resize it, or select a clip and press **Delete** to remove it. The demo arrangement is ordinary clip data; edit it freely.

The HUD reports requestAnimationFrame timing, per-frame draw calls/triangles, resolution scale, backend, active fixtures, song position in bars/beats, measured output latency, and the loop bars. rAF timing follows the display refresh rate; it is not a GPU timestamp.