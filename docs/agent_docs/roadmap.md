# Roadmap

Phase gates are about proving the risky thing before building the expensive thing.

## Phase 0 — Spikes (throwaway code allowed)

- **Lighting spike** (`apps/lighting-spike`): procedural venue, mixed fixture types, additive TSL beam-cone proxies, fog, bloom, floor pools, perf HUD, dynamic resolution. Visual look and basic frame budget are documented; still compare half-resolution volumetrics and test on a 60 Hz / mid-range GPU before choosing the renderer path.
- **Audio clock prototype** (`apps/lighting-spike/src/audio-clock.ts`): implemented against the sample track with `AudioContext` time, output-latency compensation, audio loop points, waveform peaks/grid, play/pause/scrub. This validates the clock/transport path, but audio selection and import are not implemented.
- **Beat detection evaluation**: compare `web-audio-beat-detector` / `essentia.js` results against manually tapped BPM. Not started — the current track's 130 BPM / 0.02 s offset was measured offline and hard-coded in `src/track.ts`.

Exit criteria: a documented frame budget in `docs/agent_docs/spike-notes.md`, a look worth iterating on, and enough audio-sync evidence to proceed into the vertical slice. The first two have promising evidence; target-hardware performance and automated beat analysis remain open.

Recommended next: begin the Phase 1 authoring slice on top of the working clock—local audio selection, editable BPM/offset, then waveform beat grid and a minimal clip lane with scrub/playback. Keep the current fixture set; more fixture/effect types are later-phase work. In parallel, validate the renderer on a 60 Hz / mid-range GPU and compare proxy beams with half-resolution volumetrics.

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
