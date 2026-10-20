# Design Decisions (ADRs)

Short form: context → decision → consequence. Update or supersede rather than rewrite.

---

## ADR-001 — Web app on three.js WebGPURenderer + TSL

**Context.** Need strong lighting effects and fast iteration. Native/Rust would slow down visual tuning; major engines are excluded by preference.

**Decision.** Vite + TypeScript web app rendering with `three/webgpu` (WebGPURenderer) and TSL node materials. WebGL2 fallback comes free from the same TSL graph.

**Consequences.**
- Effects are written as TSL graphs, never raw GLSL, so one code path serves WebGPU and WebGL2.
- All shader/material work is isolated in `packages/renderer` behind a small interface; swapping to Babylon or native `wgpu` later stays possible.
- Worst case (very high fixture counts) is mitigated by capping visible volumetric lights, not by changing engines.

---

## ADR-002 — Time is a pure function of the show

**Context.** Playback, scrubbing, looping, and video export all need the same visual result for the same song position.

**Decision.** `evaluateFixtureStates(show, timeSec): FixtureState[]` lives in `packages/show-model` and is pure. The renderer samples it every frame. Song time comes from one audio clock; it is never accumulated from frame deltas.

**Consequences.**
- Scrub/pause/jump are just setting time.
- Deterministic playback, frame-accurate seeking, unit-testable golden timelines, and offline video export are cheap.
- Only inherently stateful effects (particles, confetti, CO2 plumes) use a separate fixed-timestep sim with a reseed-at-time-`t` path.

---

## ADR-003 — Local audio upload only; no YouTube import

**Context.** Beat/onset analysis requires the raw audio samples. YouTube's IFrame Player exposes no sample data, and ripping it violates the platform's terms.

**Decision.** Users upload an audio file. The app analyzes it on import (in a Worker) and stores the resulting beat grid in the show document. YouTube is not a supported audio source.

**Consequences.**
- Analysis (BPM, offset, onsets, waveform peaks) is a first-class import step.
- Auto-detection must always be correctable: tap tempo, BPM field, offset nudge, grid editing.
- No cloud upload, share links, or audio distribution are planned. A local show file can reference the audio by filename/hash; moving it to another machine requires the owner to provide the audio separately.
- Local playback and locally rendered video export may include the imported audio.

---

## ADR-004 — Simulate real DMX conventions

**Context.** Target audience is people without access to expensive lighting hardware. Fidelity to real-world fixtures is what makes the simulator useful for learning and for pre-programming a real rig.

**Decision.** Model fixtures the way DMX does:
- Fixture profile = channel map + capabilities + physical limits (e.g. pan/tilt ranges, strobe 1–20 Hz, no color mixing).
- Show-layer attributes resolve to a **fixture-state layer** (`intensity, color, pan, tilt, zoom, focus, strobeRate, gobo, prism, rotation, …`) expressed in real-world units.
- 8-bit and 16-bit channel pairs are both supported in profiles.
- A future compile step maps fixture state → DMX universes (512 channels) for Art-Net/sACN output.

**Consequences.**
- Renderer consumes real-world units, so lighting looks physically consistent.
- Capability data drives editor validation: unsupported actions are visibly unavailable per fixture.
- Profile JSON is the same data that would eventually talk to real hardware, so no rewrite to add DMX output.
- Working title is `dmx-sim`; product name TBD.

---

## ADR-005 — Clips with envelopes are the timeline primitive

**Context.** Notes-on/off alone cannot express holds, fades, sweeps, or strobes, which are the core creative vocabulary.

**Decision.** A track holds clips; each clip has a time range and property envelopes/curves. A "note" is a very short clip. An effect/preset library (pulse, chase, strobe, rainbow, sweep, bounce) generates clips rather than being a separate runtime system.

**Consequences.**
- Holds and fades fall out of one primitive.
- Presets make it fast to produce musical results without drawing hundreds of notes.
- Timeline UI needs envelope editing early, not as a later add-on.

---

## ADR-006 — Monorepo with a renderer-free core

**Context.** Core logic must be testable headlessly and reusable for video export and future DMX output.

**Decision.** npm workspaces: `apps/web`, `packages/show-model`, `packages/renderer`, `packages/fixtures`. `show-model` may not import three.js (enforced by lint).

**Consequences.**
- Fast unit tests over timeline evaluation.
- Offline render/export reuses the same evaluator.
- Package boundaries prevent rendering concerns leaking into the document model.

---

## ADR-007 — Low-fi art direction, high-fidelity light

**Context.** Photoreal assets are expensive to produce and AI-generated environments are unreliable. Lighting is the product, not geometry.

**Decision.** Low-poly procedural geometry (rooms, truss, fixtures built from primitives/curves) with deliberate lo-fi styling (reduced internal resolution, subtle vertex snapping, palette/dither toggle). Spend the visual budget on beams, fog, bloom, gobos, and reflections.

**Consequences.**
- No asset pipeline blocker for the vertical slice.
- The styling pass is a user-facing toggle for clean/modern versus retro presentation.
- Technique budget: evaluate half-res raymarched volumes against mesh-beam proxies, ≤3 shadow-casting lights, additive beams, bloom + anamorphic streaks, no per-light shadow maps.

---

## ADR-008 — JSON show document with schema + migrations

**Context.** Shows are user data; the schema will change a lot during development.

**Decision.** `.dmxsim` is JSON validated by Zod, with an integer `version` and forward migrations. Audio stays in its local file; the show stores a reference. Autosave to IndexedDB.

**Consequences.**
- Explicit migration tests from day one; old shows never silently break.
- Documents stay diffable and easily testable as fixtures.

---

## ADR-009 — Stay with the JavaScript web toolchain

**Context.** Bun, Zig, and native runtimes are available as options, but the target is a browser app built on three.js, Vite, and TypeScript.

**Decision.** Use npm workspaces + Vite + TypeScript for now. This is a portability choice, not a limitation imposed by the currently installed runtime; use newer Node/Vite versions when the project environment is set up. Revisit Bun if install/startup speed becomes a real bottleneck. Zig has no meaningful role in the current browser-rendering path.

**Consequences.**
- Keep browser APIs, audio, and rendering in the web app; keep the show model runtime-agnostic.
- Avoid adopting a second runtime until it brings measurable value.

---

## ADR-010 — Fixture setup is persisted state, not a render override

**Context.** The spike shipped a fixture panel with a render-only "test output" override: it forced a fixture on and offset its aim and beam angle for inspection, but nothing was saved. That made it a debug tool rather than a way to describe a rig — a user could find a good mounting angle or beam angle and then lose it. It also hid a real modelling gap: parameters such as zoom and pan/tilt are DMX-controlled, yet the model had no place to store the value a fixture holds when no clip asserts it.

**Decision.** Split fixture control into layers by *how the value is produced*, not by whether it is "digital":

1. **Physical / personality** — position, mount yaw, mounting pitch, pan/tilt limits, channel map, DMX address. Stored on `FixturePlacement` and `FixtureProfile`; cannot be animated by a clip.
2. **Setup defaults** — normalized values in `FixturePlacement.defaults`, used when no clip asserts that attribute. Saved with the project. This is the fixture's home look.
3. **Program** — clip envelopes (`ControllableAttribute` keyframes). A clip overrides a setup default for as long as it animates that attribute.
4. **Render-only debug** — removed. There is no override layer in the renderer any more.

**Consequences.**
- `evaluateFixture` starts from the built-in `DEFAULTS`, merges `fixture.defaults`, then overlays clips. A default dimmer level lights a fixture with no clips; a clip that only sets colour keeps the default level.
- Mount yaw, mount pitch, and setup defaults round-trip through `.dmxsim` (`fixtures[].yawDeg`, `pitchOffsetDeg`, `defaults`); older files remain valid because the field is optional.
- The fixture side panel edits setup and is persisted, replacing the transient "Live preview" panel. It makes the clip/default distinction visible with a badge.
- A future fixture setup editor can add the rest of layer 1 (limits, channel map, invert flags) without touching the clip model.
- Pan/tilt and zoom remain clip-animatable; only the *mounting* values are physical. "Hardware vs digital" is not the dividing line — "stored vs transmitted per frame" is.
- Mount pitch is applied as a transform (`root -> mount -> pan axis -> tilt head`), not added to `FixtureState.tiltDeg`. A fixture clamped at an angle therefore keeps its whole tilt range, and pan rotates around its own mount axis. Fixed fixtures rotate their housing with the mount; only the beam's direction was ever angled before.

---

## ADR-011 — Venues are templates; fixtures attach to anchors

**Context.** The venue geometry was hardcoded in `Stage.addRoom()` and the rig was a generated array. A project could change fixture setup but not which fixtures existed; `openProject()` rejected any file whose fixture IDs differed from the build. Two product needs conflict with that: choosing between preset stages, and authoring a smaller or larger rig. Placement also needs to know *where* a fixture hangs (truss, riser edge, wall), not just an absolute coordinate, or a template change leaves lights floating.

**Decision.**
- A `VenueTemplate` in `packages/show-model` describes the room shell, optional features (riser, LED wall, booth, crowd, haze), static structure, mount anchors, camera presets, and a ready-made `defaultRig` preset as plain data. The app builds three.js meshes from it; the package stays renderer-free (ADR-006).
- Templates exist so a user can pick a stage and press play without authoring a rig; each template's `defaultRig` is what an untouched project starts from.
- A `MountAnchor` is a segment (or point) with a normal and a default mount pitch. Fixtures store `mount: { anchorId, u, offset }` plus the resolved `position`/`yawDeg`/`pitchOffsetDeg`. The mount wins on load when the anchor exists; the cached transform is the fallback for unknown venues, so no fixture is ever dropped silently.
- Opening a project replaces `show.fixtures`, the venue, the stage rig, and the arrangement lanes. Rig equality checks are removed; embedded profile snapshots already make any rig renderable (ADR-008).
- Mount pitch is applied as a transform between the fixture root and its yoke, not added to `FixtureState.tiltDeg`. This frees the profile's tilt limits and matches a real clamp: pan spins around the mount axis.
- Removing a fixture removes its clips in the same undoable command, because the schema forbids dangling `fixtureId` references.
- **Switching venue starts a new project.** Anchors, lanes, and clips are venue-specific, so carrying them across venues leaves floating fixtures and dead lanes. The switch loads the new template's `defaultRig`, clears clips, resets the loop/zoom, and **keeps the loaded song**. When clips exist it warns that the timeline will be cleared (save / clear and continue / cancel); with no clips it switches without a prompt. The venue picker is an explicit command, not a live dropdown.
- Opening a project reads `venue.id` and rebuilds that venue; it is not treated as a switch, so no authored work is discarded.

**Consequences.**
- `.dmxsim` gains a `venue` section and `fixtures[].mount` / `name`; version 2 with a v1 migration that assumes the only venue that existed at v1.
- A second preset stage (main-stage geometry with an overhead grid and side ladders) is data, not a code fork.
- Venue switching is the one destructive rig action. The save prompt and the picker's "clips will be cleared" note are the safety net; undo for venue changes is not required in the first pass.
- Fixture count is no longer a fixed build property; the render-budget toggle becomes a debug/perf control, and removing lights is the real way to simplify the timeline.
- Anchor drift across venue versions is a real failure mode; the cached transform plus an "unattached" UI state contains it.
- Venue *editing* (moving trusses, resizing rooms) stays out of scope; templates are fixed data.

---

## ADR-012 — Lasers use a dedicated beam renderer

**Context.** Every fixture rendered through one cone proxy. A laser was only a brighter cone with a 6 mm aperture and a 0.6–1.8° spread, so at 20 m it looked like a narrow spotlight rather than the razor-thin fans and scanning patterns in the reference photos. A cone is the wrong primitive: a laser emits multiple near-parallel beams, stays bright across the room, and terminates in a visible dot on a surface.

**Decision.**
- A `LaserRig` renders one quad ribbon per beam in a single draw call per fixture, billboarded in the vertex shader, with a small world width and a screen-space minimum width; bloom supplies the glow.
- The beam pattern (`fan`, `sweep`, `tunnel`, `wave`, later `lattice`/`dots`) is computed in the shader from a phase uniform. Beam count, pattern, fan width, divergence, speed, and phase are **setup** values on `FixturePlacement.laser`; `rotation` (and pan/tilt) animate motion through existing clip attributes.
- Beams terminate on venue surfaces (floor, riser, walls, LED wall) that the template exposes, and the same surface list replaces the renderer's hardcoded stage-footprint test for floor pools.
- Beam counts and fan width clamp to profile limits; a scene-wide beam budget and a laser master enable are required.
- Pattern choice is a persisted setup value in the first pass; only `rotation` and pan/tilt are clip-animated. A later pattern/fan attribute must be additive, and no control ships without a document field.

**Consequences.**
- Laser state extends `FixtureState` and the project schema additively; existing projects remain valid.
- `speedHz`/phase is stored in real units, so tempo changes do not distort a laser cue unless the author re-times it.
- Pattern selection is not clip-animatable yet. Adding a `fan` attribute later must remain additive; do not ship a control without a document field.
- Audience-scanning zones are deferred: they are a good idea, but they need venue geometry, UI, and per-beam checks. Revisit once the pattern renderer is proven.
- Laser safety is limited to a show-level master enable and a scene-wide beam budget. No photosensitivity warning is planned (user decision, 2026-10-18); do not re-add one without being asked.
- Beam visibility is a function of atmospheric haze, not a per-fixture brightness multiplier. The laser and spot shaders read a shared haze value from the start, so adding fog/haze machines changes one input instead of rewriting materials. At zero haze, a laser shows its emitter and surface dot only.

---

## ADR-013 — Cryo jets are fixtures with a clip-driven plume and cue SFX

**Context.** Cold-spray jets are a stage effect rather than a light, but they need to be placed, hidden, and choreographed with everything else. The user also supplied a one-shot sound effect that has to fire when a jet fires.

**Decision.**
- Add a `cryo-jet` fixture kind with a `dimmer` channel only. The dimmer is the spray level, so the existing clip evaluator drives it with no parallel effect timeline.
- A `fire` cue action is the jet's authored vocabulary. It maps to a short attack/hold/decay dimmer envelope; other fixture kinds do not offer it.
- `CryoJetRig` renders a widening, noise-driven vapour cone plus a nozzle and ground mist. The plume launches from the nozzle over ~0.16 s when a fire clip starts, then shakes vertically and wanders sideways with rapid multi-frequency flutter while firing; two scrolling noise octaves and a swirling sample rotation keep the surface churning. It is driven from clip intensity and song time, so scrubbing to a firing frame shows the settled plume rather than a frozen first frame. The effect meshes render an invisible warm-up pass at load, so their shader pipelines compile before the first cue instead of stalling playback.
- The plume follows the fixture's local `-Y`, exactly like a beam. A floor jet authored with a 180° mount pitch fires straight up; adding one on the riser does this by default.
- `CryoJetAudio` decodes the bundled one-shot sample at startup and triggers it on the rising edge of a jet's spray level during playback. The sample is fitted to the clip: it repeats when the clip outlasts the sample, and is cut off when the clip ends first. Simultaneous jets with the same remaining duration share one sample at a slightly louder level. Frames that jump more than 0.3 s forward or any distance backward update tracking without firing, so scrubbing is silent. Pause and seek stop any cue sound already in flight.
- The sound routes through the transport master gain, so mute and playback volume apply. Cryo jets are excluded from the room-light/ambient aggregation.

**Consequences.**
- The project schema grows additively: `cryo-jet` in the kind enum and `fire` in the cue-action enum. Older files remain valid.
- Seeking into the middle of a fire clip does not replay its sound; resuming mid-clip is treated as already firing. A later loop pass triggers again when the clip start is crossed.
- A future particle/stateful plume can replace the shader internals behind the same fixture, `fire` action, and `FixtureState` without changing the document format.
- The sound file is bundled with the app. User-replaceable per-jet samples would need a project-audio field and are deferred.

