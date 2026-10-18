# Roadmap

Phase gates are about proving the risky thing before building the expensive thing.

## Phase 0 — Spikes (throwaway code allowed)

- **Lighting spike** (`apps/lighting-spike`): procedural venue, mixed fixture types, additive TSL beam-cone proxies, fog, bloom, floor pools, perf HUD, dynamic resolution. Visual look and basic frame budget are documented; still compare half-resolution volumetrics and test on a 60 Hz / mid-range GPU before choosing the renderer path.
- **Audio clock prototype** (`apps/lighting-spike/src/audio-clock.ts`): implemented against the sample track with `AudioContext` time, output-latency compensation, audio loop points, waveform peaks/grid, play/pause/scrub. This validates the clock/transport path, but audio selection and import are not implemented.
- **Beat detection evaluation**: compare `web-audio-beat-detector` / `essentia.js` results against manually tapped BPM. Not started — the current track's 130 BPM / 0.02 s offset was measured offline and hard-coded in `src/track.ts`.

Exit criteria: a documented frame budget in `docs/agent_docs/spike-notes.md`, a look worth iterating on, and enough audio-sync evidence to proceed into the vertical slice. The first two have promising evidence; target-hardware performance and automated beat analysis remain open.

### Recommended next: timeline authoring slice

Build on the working audio clock in this order:

1. Add local audio selection and playback for a user-provided file.
2. Show and allow editing of BPM and beat-grid offset; keep analysis results correctable.
3. Display the waveform with beat/bar markers driven by that grid.
4. Add a minimal clip lane with create/move/resize and play/pause/scrub, proving a short lighting cue can be authored and stays synced.

**Keep the current fixture set.** Defer additional fixture types and lighting effects until this authoring flow is proven; those expand the content surface before the core workflow is validated. In parallel, validate the renderer on a 60 Hz / mid-range GPU and compare proxy beams with half-resolution volumetrics.

## Phase 1 — Vertical slice

One room, four fixture types (moving head, wash, strobe, laser), fog/haze, local audio upload with analysis, waveform + beat grid, timeline with clips/envelopes and snapping, play/pause/scrub at 60 fps.

Not in scope: sharing, DMX output, SFX, multiple rooms.

Exit criteria: a 30-second clip can be authored end-to-end and looks/sounds synced.

## Phase 2 — Authoring depth

- Preset/effect library (pulse, chase, strobe, rainbow, sweep, bounce)
- Undo/redo via command objects, copy/paste at beat offsets, quantize, loop regions
- Camera presets and fixture placement gizmo
- Save/load `.dmxsim`, autosave, version migrations
- Inspector with per-fixture capability constraints

## Phase 3 — Spectacle

- Gobos, prisms, LED walls
- CO2 jets, confetti, cold sparks, bubbles/snow (stateful particle layer)
- Additional rooms: home theater, underground EDM venue
- Audio-reactive effect modifiers (envelope followers) layered on authored clips

## Phase 4 — Local output

- Offline video export (WebCodecs), including the locally loaded audio
- Portable `.dmxsim` show files with audio references; users provide audio separately when moving projects between machines

Sharing/cloud sync is not planned unless the product direction changes.

## Phase 5 — Hardware credibility

- DMX compile step: fixture state → universes via fixture profiles
- Art-Net / sACN output and a universe/channel monitor
- Import/export real fixture profiles
- "Learn DMX" affordances: show channel values alongside visual result

## Explicit non-goals (until revisited)

- YouTube audio import (no sample access; ToS risk — see ADR-003)
- Photoreal assets
- Multi-user realtime collaboration
- Mobile-first UI
