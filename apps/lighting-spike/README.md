# Lighting spike (`@dmxsim/lighting-spike`)

Phase 0 renderer/performance experiment for dmx-sim. It renders a procedural club/stage venue with a beat-synced 32-fixture demo show to answer two questions: does the lighting look work, and what fixture budget can we afford? The spike's renderer code is disposable; stable pieces get extracted into `packages/renderer` later.

Playback is driven by the audio clock prototype ([src/audio-clock.ts](src/audio-clock.ts)): song time comes from `AudioContext`, not from frame deltas, and the transport strip scrubs a real waveform with the beat grid drawn on it.

Findings live in [../../docs/agent_docs/spike-notes.md](../../docs/agent_docs/spike-notes.md).

## Audio

The demo loads `resources/sample_audio/The Koto Chill.ogg` (zircon, third-party music). Vite bundles it into production output; confirm distribution rights before publishing. Its beat grid was measured offline, not detected at import time: **130.00 BPM**, first beat at 0.02 s, default loop bars 41–56. Those constants live in [src/track.ts](src/track.ts) and are a placeholder for the real import-time analysis described in ADR-003.

## Run

```sh
npm run dev        # from the repo root, or: npm run dev -w @dmxsim/lighting-spike
```

Open the Vite URL in a WebGPU-capable browser. Uses three.js `WebGPURenderer` with TSL node materials; the browser may fall back to WebGL2 — verify with the backend label in the HUD.

## Controls

- **Space**: play/pause the audio and the 16-bar lighting loop
- **Click / drag the waveform**: scrub
- **L**: toggle audio looping (the choreography always loops on its bar grid)
- **1**: toggle beam cones (mesh-based haze proxy, not true raymarched volumetrics)
- **2**: toggle bloom
- **3**: toggle shadows
- **4**: toggle lo-fi posterization
- **5**: opt in/out of brief strobe flashes (off by default)
- **C**: cycle camera presets
- **[ / ]**: cycle fixture counts
- Mouse drag / scroll: orbit and zoom

The HUD reports requestAnimationFrame timing, per-frame draw calls/triangles, resolution scale, backend, active fixtures, song position in bars/beats, measured output latency, and the loop bars. rAF timing follows the display refresh rate; it is not a GPU timestamp.