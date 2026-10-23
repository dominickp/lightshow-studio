# Studio (`@dmxsim/studio`)

The dmx-sim studio app. It renders a procedural club/stage venue with a 32-fixture rig driven by an editable arrangement. Stable renderer pieces will move into `packages/renderer` as the app grows.

The stage has no hard-coded lighting effects. The rig and the 16-bar demo arrangement are loaded from [../../resources/sample_projects/koto-chill/koto-chill.dmxsim](../../resources/sample_projects/koto-chill/koto-chill.dmxsim) at startup — the project file carries the song it scores, so it is one self-contained file to find, replace and share. Playback evaluates exactly those clips, so moving, resizing, or deleting a clip changes the light on screen. **Save project** downloads the current rig, timeline, clips, and settings as a `.dmxsim` file; **Open project** validates one and applies it. To update the demo, edit it in the app, use **Save project**, and commit the downloaded file over the sample (or replace the file on disk and reload to iterate). Format spec: [../../docs/agent_docs/project-file-format.md](../../docs/agent_docs/project-file-format.md).

Playback is driven by the audio clock prototype ([src/audio-clock.ts](src/audio-clock.ts)): song time comes from `AudioContext`, not from frame deltas, and the transport strip scrubs a real waveform with the beat grid drawn on it.

Findings live in [../../docs/agent_docs/renderer-notes.md](../../docs/agent_docs/renderer-notes.md).

## LED wall

The venue's LED wall is a persistent surface lane, separate from DMX fixtures.
It remains visible as a dark, unlit panel when no surface clip is active. Drag
in its lane to add a procedural look clip; select a clip to choose a generator
and edit its palette, speed, scale, angle, softness, intensity, seed, and beat
sync from **Edit look…**. Adjacent clips crossfade. Click the wall lane name to
open its calibration panel (pixel pitch, pixel gap, brightness, black level,
gamma, and approximate room spill). The built-in generators are Solid, Gradient drift, Linear wave, Radial pulse,
Noise field, Grid / tunnel, Scan bars, and Blackout.

## Projects and audio

The demo project is `resources/sample_projects/koto-chill/koto-chill.dmxsim`. The bundle is the only source of the demo show: the song, the rig, the clips and the wall media all live inside it, so the app ships exactly one copy of the audio. The project carries its own measured grid: **130.00 BPM**, first beat at 0.02 s, default loop bars 41–56.

**New project** asks for a project name and an audio file, decodes the track, and estimates the beat grid from the samples ([src/audio-analysis.ts](src/audio-analysis.ts)). The dialog shows the detected BPM, first beat, and a 16-bar loop start; every value is editable, including ×2 / ÷2 for half/double-time mistakes. Confirming starts an empty arrangement on the current rig, with the song and its grid ready for clips. **Edit project** opens the same dialog for the current project: rename it, correct the BPM/offset/beats-per-bar, and optionally replace the song. Changing only the name or grid keeps every clip (they keep their absolute song times and snap to the new grid); choosing a new song clears them, because the old arrangement was authored against the old song. The dialog says so before you confirm.

The analysis is a compact onset-envelope + autocorrelation estimator, not a general music analyser. It runs on the already-decoded `AudioBuffer` (main thread; a Worker is still worthwhile for very long tracks), uses a low-passed envelope to lock the phase to the kick rather than the hi-hats, and leaves the result correctable in the dialog.

## Run

```sh
npm run dev        # from the repo root, or: npm run dev -w @dmxsim/studio
```

Open the Vite URL in a WebGPU-capable browser. Uses three.js `WebGPURenderer` with TSL node materials; the browser may fall back to WebGL2 — verify with the backend label in the HUD.

