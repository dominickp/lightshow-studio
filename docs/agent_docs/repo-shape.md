# Repo Shape

npm workspaces monorepo. One TypeScript toolchain, Vite for apps.

```
apps/
  studio/         # dmx-sim studio app: viewport, timeline, inspector
packages/
  show-model/     # Pure TS: schema, evaluate(), presets, migrations. NO three.js.
  renderer/       # three/webgpu: fixture meshes, TSL materials, post-processing
  fixtures/       # Fixture profiles (JSON/TS): channel maps, capabilities, physical limits
docs/agent_docs/  # Planning and decisions (agent-maintained)
docs/user_docs/   # User-authored docs — never modify
```

## Dependency rules

```
apps/studio -> packages/renderer -> packages/show-model
apps/studio -> packages/show-model
apps/studio -> packages/fixtures -> packages/show-model (types only)
show-model must never import three, DOM, or WebAudio.
```

The studio app keeps its scene implementation in `apps/studio`; extract stable renderer pieces to `packages/renderer` as they settle.

Enforce with an ESLint `no-restricted-imports` rule in `packages/show-model`.

## Package responsibilities

**show-model**
- `Show` document types + Zod schema + `version` migrations
- `.dmxsim` project-file schema (rig + timeline + arrangement + settings) in `project.ts`
- Venue templates: room structure, procedural feature descriptors, mount anchors, camera presets (plain data, no three.js)
- `resolveMount(template, mount)` — pure placement resolution with cached fallbacks
- `evaluateFixtureStates(show, timeSec)` — pure, deterministic
- Timeline math: clips, envelopes, beat grid ↔ seconds conversion
- Preset expansion (preset → clips)
- Tests: golden evaluation, migration fixtures

**fixtures**
- Profile shape: `id`, `name`, ordered DMX channel slots (explicit coarse/fine slots for 16-bit attributes), `capabilities`, physical limits
- Seed profiles are generic approximations; manufacturer-specific profiles need sourced channel tables and validation.
- Physical limits used for UI validation and later DMX compile
- Seed profiles: generic moving head, wash, strobe, laser, PAR, blinder, LED strip

**renderer**
- Venue builder (`apps/studio/src/venue-builder.ts` today): structure primitives, LED wall, accent strips, crowd, haze; owns three.js resources and disposal
- Fixture → scene object factory (`FixtureRig` for spot/wash/fixed, `LaserRig` for multi-beam laser fixtures)
- Venue builder: structure primitives, LED wall, crowd, booth, haze, exposed surfaces for beam termination
- TSL beam/volume/fog/emissive materials
- Post-processing stack (bloom, streaks, dynamic resolution)
- `setFixtureStates(states)` per frame; no show logic
- Perf instrumentation (frame ms, draw calls, visible lights, active laser beams)

**apps/studio**
- Layout: viewport, timeline, inspector
- Audio engine + analysis worker
- Editor state (zustand) separate from the immutable show document
- Persistence (IndexedDB autosave, file import/export)

## Tooling

- TypeScript `strict`, `noUncheckedIndexedAccess`
- Vitest for `show-model` and `fixtures`; Playwright for app smoke + screenshot diffs later
- Zod for all external data (documents, profiles, settings)
- Package manager: npm workspaces (no monorepo framework until it hurts)
