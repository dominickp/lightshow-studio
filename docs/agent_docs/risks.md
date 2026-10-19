# Risks

| Risk | Impact | Mitigation | Status |
|---|---|---|---|
| Beam/haze rendering destroys framerate | Core feature unusable | Current spike uses additive mesh cones (not raymarching); compare half-res volumetric pass later, cap simultaneous beams, retain dynamic resolution/HUD | Open — spike |
| Many dynamic lights (24–32) shading cost | Frame drops on mid hardware | Forward+ style budget: cap real lights, fake remaining bounce with additive floor decals; measure max fixture count in spike | Open — spike |
| WebGPURenderer/TSL API churn (pre-1.0 three) | Rework | Pin three version; isolate all TSL/WebGPU code in `packages/renderer` behind a narrow interface | Accepted |
| WebGPU unavailable (older Safari/Firefox) | Lost users | WebGL2 fallback via the same TSL graph; verify the stack runs on WebGLRenderer early | Open |
| Audio clock drift / tab throttling | Desync between visuals and music | `AudioContext` clock + `getOutputTimestamp()` latency compensation; re-anchor on `visibilitychange`; never accumulate frame deltas | Known solution |
| Auto BPM detection wrong | Timeline unusable for that song | Manual BPM, tap tempo, offset nudge, grid editing are mandatory; detection is only a suggestion | Design decision |
| Local audio makes projects non-portable | A project opened elsewhere cannot play its song | Store filename/hash and duration; keep sharing/cloud out of scope; prompt for relinking if project portability is added later | Accepted |
| Timeline perf with many clips | UI jank | Canvas/WebGL piano roll, not DOM nodes; viewport culling; multiresolution waveform peaks | Open — spike now paints the waveform only on change and caches scroll layout; Firefox is still 20.8 ms rAF |
| Undo/redo corrupts document | Data loss | Immutable doc + command objects; Zod validate in tests; autosave snapshots | Open |
| Scope creep (all SFX, all rooms, DMX) | Never ships a slice | Phase gates in `roadmap.md`; Phase 1 fixed to one room and four fixture types | Managed |
| Asset production bottleneck | Slow visual progress | Procedural low-poly geometry; fixture models from primitives/curves | Design decision |
| Fixture capability model too shallow | Editor allows impossible actions | Profile capabilities + limits defined before timeline UI; per-fixture validation in inspector | Open |
| Rig edits invalidate authored clips | Data loss when a light is removed | Removal deletes that fixture's clips in one undoable command and names the count; schema rejects dangling `fixtureId` | Open — see `stage-rig-editor-plan.md` |
| Anchor drift when a venue template changes | Fixtures float or disappear on load | Store the mount **and** the resolved transform; use the cached transform when an anchor is unknown; flag unattached fixtures in the UI | Open |
| Venue data-driven rewrite regresses the look | Lost visual progress | Keep `addRoom()` until `buildVenue()` matches it, compare captures, then delete the old path | Open |
| Switching venue discards clips | User loses authored work | Switching venue warns that placed clips will be cleared and keeps the song loaded; save is offered in the prompt; venue picker is an explicit command; `venue.id` is saved so reopening a project is not a switch | Open — see `stage-rig-editor-plan.md` |
| Laser beam overdraw and bloom cost | Frame drops and washed-out image | One draw call per laser, scene-wide beam budget, no shadows, tune exposure/bloom against reference captures and measure frame cost | Open — see `laser-rendering-plan.md` |
| Laser safety (audience scanning) | Beams aimed into the crowd | Show-level laser enable and a scene-wide beam budget; audience scanning zones are deferred (liked, but need venue data, UI, and per-beam checks). No photosensitivity warning is planned | Managed |
| Haze decoupled from beam visibility | Lights look identical in foggy and clear rooms; atmosphere work becomes cosmetic | Beam shaders read a shared normalized haze value from the start; hazeless scenes legitimately show emitter + surface dot only | Managed — see `laser-rendering-plan.md` |
| One lane per fixture makes large rigs unwieldy | Timeline noise | Removal is the primary simplification; follow with collapsible mount-group lanes and persisted track order | Managed |
