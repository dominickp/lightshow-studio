# Roadmap

Phase gates are about proving the risky thing before building the expensive thing.

## Phase 0 — Spikes (throwaway code allowed)

- **Lighting spike** (`apps/lighting-spike`): procedural venue, mixed fixture types, additive TSL beam proxies with profile-sized emitting apertures, fog, bloom, floor pools, perf HUD, dynamic resolution. The selected-fixture panel edits persisted fixture setup (mount yaw/pitch, level, beam angle); clips override level, colour, aim, and strobe while active, but do not author beam angle yet.
- **Reference-driven lighting-fidelity spike:** use a small set of the supplied concert images to define repeatable camera/show comparisons; compare the current beam proxy with half-resolution volumetrics; tune beam-angle/falloff, aperture and haze density, and exposure/bloom to retain detail in bright overlaps. Record before/after images and frame cost on a 60 Hz / mid-range GPU before choosing a rendering path. This is a stylized concert-realism target, not a photoreal-asset project.
- **Venue and fixture authoring discovery**: define a venue as a loadable stage structure with a default rig; users can add, remove, position, mount, aim, duplicate, and group fixtures. Specify placement gestures, snapping/attachment to truss or stage points, and fixture-library/profile selection before building a full editor.
- **Atmosphere authoring discovery**: haze/fog-machine density and position should be controllable, including song-timed activation/envelopes so a fog cue can precede a laser look. Keep global venue atmosphere separate from local/sourced effects and fixture cues.
- **Audio clock prototype** (`apps/lighting-spike/src/audio-clock.ts`): implemented against the sample track with `AudioContext` time, output-latency compensation, audio loop points, waveform peaks/grid, play/pause/scrub, and local audio selection/import.
- **Beat detection evaluation**: compare `web-audio-beat-detector` / `essentia.js` results against manually tapped BPM. Not started — the current track's 130 BPM / 0.02 s offset was measured offline and hard-coded in `src/track.ts`.

Exit criteria: a documented frame budget in `docs/agent_docs/spike-notes.md`, a look worth iterating on, and enough audio-sync evidence to proceed into the vertical slice. The first two have promising evidence; target-hardware performance and automated beat analysis remain open.

### Recommended next: timeline authoring slice

Build on the working audio clock in this order:

1. [x] Add local audio selection and playback for a user-provided file.
2. Show and allow editing of BPM and beat-grid offset; keep analysis results correctable.
3. Display the waveform with beat/bar markers driven by that grid.
4. [x] Prototype an FL Studio-inspired arrangement with fixture-specific lanes, create/move/resize clips, and capability-aware actions. This proves a cue can reach the matching fixture in sync; clips can now be saved and restored through `.dmxsim` project files (see `docs/agent_docs/project-file-format.md`).

**Keep the current fixture set.** Defer additional fixture types and lighting effects until this authoring flow is proven; those expand the content surface before the core workflow is validated. In parallel, validate the renderer on a 60 Hz / mid-range GPU and compare proxy beams with half-resolution volumetrics.

## Phase 1 — Vertical slice

One room, four fixture types (moving head, wash, strobe, laser), fog/haze, local audio upload with analysis, waveform + beat grid, timeline with clips/envelopes and snapping, play/pause/scrub at 60 fps.

Not in scope: sharing, DMX output, SFX, multiple rooms.

Exit criteria: a 30-second clip can be authored end-to-end and looks/sounds synced.

## Phase 2 — Authoring depth

- **Fixture behavior and clip controls:** replace the current canned action mapping with capability-aware authoring. Moving heads/washes get mount orientation plus pan/tilt targets and movement shapes (sweep, circle, figure-8, bounce) with range, speed, direction, and phase; fixed fixtures get installation aim (yaw/pitch) and beam controls only when their profile supports them. Expose dimmer/fade, color, zoom in full-angle degrees, focus, strobe rate (Hz and musical divisions), and rotation in meaningful units. Keep unsupported channels read-only until the model can animate them.
- Preset/effect library (pulse, chase, strobe, rainbow, sweep, bounce)
- Undo/redo via command objects, copy/paste at beat offsets, quantize, loop regions
- **Fixture placement editor:** add/remove/duplicate fixtures from the profile library; select and position/rotate them in the 3D venue, with snapping/attachment points on trusses and stage structures, numeric transforms, and a clear distinction between physical mounting orientation and animated pan/tilt. Allow grouping and multi-selection; preserve profile capability constraints.
- **Venue templates:** load a venue with its geometry, camera presets, and sensible default fixture rig. Keep user-added fixtures and edits distinct from the venue defaults; provide reset-to-template behavior. Start with the current venue and one alternative only after placement workflow is validated.
- Camera presets and fixture placement gizmo
- Save/load `.dmxsim`, autosave, version migrations
- Inspector with per-fixture capability constraints
- **Atmosphere authoring:** global haze/fog density plus positioned fog-machine sources that can be triggered and faded by arrangement clips. A fog cue can build before a laser/beam cue; define timing, persistence/decay, coverage radius, and whether density accumulates or clears. Surface the photosensitivity warning/control for strobe-heavy looks.

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
