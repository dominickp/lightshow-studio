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
| Single-person project maintenance | Stagnation | Keep `show-model` small and tested; keep spike code disposable | Managed |
