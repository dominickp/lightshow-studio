# Lighting Spike Notes

## Prototype

`apps/lighting-spike` renders a procedural club/stage scene with 32 fixtures (moving heads, washes, strobes, lasers, and PARs), a 16-bar 130 BPM show, a crowd silhouette instanced mesh, TSL beam-cone haze proxies, floor pools, LED wall, one shadow-casting spotlight, bloom, and a lo-fi grade toggle.

The beams are additive cone meshes with animated TSL noise and scene fog. They are a fast visual proxy, **not** true volumetric raymarching. The next graphics spike should compare this against a half-resolution volumetric pass.

## Observed in the current dev environment

- WebGPU backend active in the integrated Chrome browser.
- 32 fixtures shown, 22 active on the paused frame at the seeded loop start (the intro's colour fades start from black).
- At 100% resolution: about **6.9–7.0 ms rAF interval**, reported as ~143–144 fps; display refresh appears to cap the result.
- About **278–316 draw calls** and **21–23k triangles** in the sampled frame with beams, bloom, and shadows enabled. This uses `renderer.info.render.drawCalls`, reset once per app frame.
- Disabling beam cones, bloom, or shadows each reduced the sampled draw call count (to roughly 248, 246, and 231 in one comparison) without changing the refresh-capped interval.
- The interval stayed near 7 ms as toggles changed, so this environment did not expose the actual performance ceiling. These are prototype observations, not a device-support claim or GPU-time measurement.

## Visual finding

The low-poly venue plus saturated moving beams is visually promising. Additive floor pools and broad overlapping beams can wash out the scene; keep beam/pool intensity conservative. Disabling a full-frame strobe flash materially improved readability. Fixture strobes remain localized and are off by default; they can be enabled for brief downbeat hits. Add a photosensitivity warning before strobe-heavy shows are a normal default.

## Audio clock prototype

`apps/lighting-spike/src/audio-clock.ts` replaces the placeholder performance clock. Song time is `AudioContext.currentTime - outputLatency`, anchored on an `AudioBufferSourceNode`, so play, pause, scrub and loop are all re-anchors rather than a second time source (ADR-002). The transport can also load a user-selected local audio file; imported tracks start at zero with full-track looping, and their waveform is shown without beat ticks until a beat grid is supplied.

- Latency compensation uses `outputLatency` (40 ms in the integrated Chrome here), so visuals follow the sample that is actually audible.
- Looping uses the source node's `loopStart`/`loopEnd`, which is sample-accurate; the visual clock wraps on the same region.
- A loop is a brace, not a cage: seeking or starting before the loop is allowed, so the song intro plays through and then wraps at the loop end. Only positions at/past the loop end fold back inside it. The arrangement shades the loop region so clips that cannot play are visible.
- The loop is editable: drag the cyan grips on the ruler to move the in/out points, Shift+drag anywhere in the timeline (ruler, waveform, or a lane) to draw a new loop, `Loop` toggles looping, and `Fit loop` zooms to it. The demo arrangement is authored inside the default loop; if the loop is moved away from it, those clips simply no longer play.
- The ruler is scrubbable as well as the waveform, so getting back before the loop does not depend on the horizontal scrollbar.
- Choreography is arrangement data: the stage evaluates the same cues the timeline draws, at absolute song time. Nothing is hard-coded in the renderer, and editing a clip changes the light immediately. Outside authored cues the rig is dark.
- The transport strip draws waveform peaks (min/max per pixel, computed once after decode), beat and bar ticks, the loop region, and a playhead.

## Timeline and notefield design prototype

The lower dock is an FL Studio-style **Playlist / Arrangement view**: a pinned transport, a pinned clip inspector, a sticky time ruler plus audio waveform, and one lane per fixture with sticky fixture labels, beat subdivisions, clip blocks, horizontal/vertical scrolling, and zoom controls.

- Layout: the transport and clip inspector are fixed header rows; the ruler (`top: 0`) and waveform (`top: 28px`) are sticky, so scrolling through 32 fixture lanes never hides the beat grid, audio reference, or playback controls. Track labels stick to the left.
- Zoom: a log-scaled slider (0.25–480 px/s), `−`/`+`, Fit-to-song, Ctrl/Cmd+wheel around the pointer (or plain wheel per axis), and Ctrl/Cmd `+`/`-`/`0`. Zooming keeps the pointer's time anchored. The toolbar floats in the dock corner so it cannot be clipped by the track-label column.
- Loop clarity: the ruler and every lane shade the region outside the transport loop (bars 41–56 by default). Because the audio clock clamps seeks to the active loop, clips drawn outside it never play; the shading makes that constraint visible rather than surprising.
- Authoring: drag in a lane to draw a clip with a live dashed preview; a plain click adds a default-length clip at the playhead. Drag a clip body to move it; drag either edge to resize that edge (left/right edge gestures are distinct). Snapping is 1/16 note when a BPM grid exists. `Backspace` or `Delete` removes the selected clip, and `Ctrl/Cmd+Z` restores it.
- Inspector: the clip inspector keeps the action and colour pickers. Capability badges (Dimmer, RGB/W, Pan/Tilt, Zoom, Strobe rate, Gobo, Prism, Rotation) live in the fixture side panel. Hold, fade, and pulse are available generally; pan/tilt fixtures add sweep and strobe-capable fixtures add strobe. Colour is editable for colour-mixing fixtures. When no clip is selected, the action/colour pickers set the default for the next clip, so drag-created clips inherit the user's intent.
- Fixture response: each cue resolves into the existing show-model envelopes and drives only its target fixture. The default track ships with a seeded demo arrangement (`src/demo-arrangement.ts`) filling the 16-bar loop; before that, the demo was a separate hard-coded show and cues only overrode it when present.

This is a design and behavior prototype, not a finished editor. Clip data is stored in the project file and round-trips through **Open project** / **Save project**; loading another audio file still resets the timeline and discards cues (the audio reference is tracked, but the two are not yet merged). Undo/redo, multi-select, copy/paste, track reordering, and a per-attribute keyframe inspector remain open. BPM/offset editing and beat analysis remain open.

### Project files (2026-10-18)

The shipped demo is now data, not code: the app fetches `resources/sample_projects/koto-chill/koto-chill.dmxsim` at startup and builds the rig, timeline, loop, clips, and view settings from it. The project file lives next to the sample audio it scores. The format is specified in `docs/agent_docs/project-file-format.md` with a generated JSON Schema companion, and validated by Zod in `packages/show-model/src/project.ts`. **Save project** downloads the current rig/timeline/clips/settings as a `.dmxsim` file; **Open project** validates and applies one, rejecting a rig that does not match the running build. Render-only fixture preview overrides are deliberately not saved. `npm run project:generate` rebuilds the bundled demo from `demo-arrangement.ts` (overwriting on-disk edits) and regenerates the schema.

### Frame-cost fixes (2026-10-18)

The user reported ~42 fps in Firefox (WebGPU active) while Chromium held 144 fps. Firefox measured a **20.8 ms median / 27.8 ms p95** rAF interval at 34 ms output latency, so the timeline was CPU/paint-bound, not backend-bound. Changes made to the spike:

- The waveform is painted only on resize, zoom, peaks, or loop/timeline changes; the playhead is a DOM element. Previously a song-wide canvas was cleared and re-blitted every frame (5,929 CSS px at 100% zoom, ~59,500 px at 1000%).
- Lane playheads share one inherited `--playhead-x` custom property instead of 32 per-row `style.left` writes per frame.
- Follow mode reads cached scroll metrics (updated from `scroll`/`ResizeObserver`) instead of reading `scrollLeft`/`clientWidth` after style writes, which forced a synchronous layout of the sticky timeline every frame.
- Cues are indexed by fixture, so evaluation no longer filters the full cue list once per fixture per frame.
- Clips are painted into one canvas overlay instead of hundreds of DOM nodes. The DOM keeps invisible, positioned hit boxes for selection, move, and resize, so gestures are unchanged. This was the decisive Firefox fix: with the demo's 580 clip elements hidden, playback went from ~49 to ~143 fps; after moving their visuals to the canvas, Firefox holds 144 fps during playback. The demo's 29-second loop is dense enough that hiding only off-screen clips was not sufficient.
- Adaptive resolution now only downscales when the main thread is not the bottleneck and never resizes while paused. The old controller treated any slow rAF interval as GPU load and stepped `renderer.setSize()` every 45 frames; pausing removed the follow-scroll cost, so it climbed back in steps, which read as the lights blinking after pause.

Also added: playback volume (gain ramp, mute, persisted), arrow-key seeking (1/16, Shift = measure), lane hover ghosts, a timeline time/measure tooltip, zoom-density grid lines anchored to `firstBeatSec`, and user-facing "measure" terminology (1 measure = 1 bar of 4 beats).

Chromium remained at 144 fps (6.9 ms, ~0.9 ms JS per frame) after the changes; the waveform now performs zero canvas draws during playback. Firefox must still be re-measured.

See `docs/agent_docs/ux-lighting-controls.md` for the evaluated control surface and phased feature plan.

### Measured track facts

`The Koto Chill` (zircon) was analysed offline with a spectral-flux onset envelope plus a dynamic-programming beat tracker:

- **130.00 BPM**, first beat at **0.02 s**; the tempo is stable across the whole file.
- Tempo grid search over the onset envelope is sharp at 130.00, so a constant grid is safe for this track.
- Bars 41–56 (73.87–103.40 s) are a high-energy 16-bar window used as the default loop.
- This is a placeholder for import-time analysis. Auto-detection must stay user-correctable (tap tempo, BPM, offset), which the spike does not implement yet.

### Verified in this environment

- Play/pause/scrub/loop all move the HUD song position and the playhead correctly; seeking to ~101.5 s loops back into 73.87 s as expected.
- No measurable frame-rate change from the transport: still ~6.9 ms rAF interval and ~296 draw calls at 100% resolution.

## Next experiments

1. Compare mesh-cone proxies with a half-resolution volumetric pass and measure both on a 60 Hz / mid-range GPU device.
2. Increase the stress test to 48–64 fixtures; test with bloom and shadows independently.
3. Validate WebGL2 fallback and compare output/quality.
4. Improve physical fixture geometry and DMX profile/channel fidelity before carrying spike code into `packages/renderer`.
5. Add a photosensitivity warning/control before making strobe-heavy shows a normal default.
6. Add editable BPM/offset and real import-time beat analysis (correctable), then validate the grid and snapping with local tracks.
