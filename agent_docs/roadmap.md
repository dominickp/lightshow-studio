# Roadmap

Phase gates are about proving the risky thing before building the expensive thing.

## Phase 0 — Spikes (throwaway code allowed)

- **Lighting spike** (`apps/spike`): procedural venue, mixed fixture types, additive TSL beam-cone proxies, fog, bloom, floor pools, perf HUD, dynamic resolution. Compare against true half-resolution volumetrics before deciding the renderer path. Answer: does the look work, and what fixture count holds 60 fps?
- **Audio clock prototype**: song time from `AudioContext` with latency compensation; waveform peaks; beat grid from BPM + offset.
- **Beat detection evaluation**: compare `web-audio-beat-detector` / `essentia.js` results against manually tapped BPM.

Exit criteria: a documented frame budget in `agent_docs/spike-notes.md`, and a look that is worth iterating on.

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
