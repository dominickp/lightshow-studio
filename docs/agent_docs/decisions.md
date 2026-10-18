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
