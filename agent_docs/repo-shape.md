# Repo Shape

npm workspaces monorepo. One TypeScript toolchain, Vite for apps.

```
apps/
  web/            # Phase 1 product app (not yet created)
  spike/          # Phase 0 lighting/perf spike (renderer experiment; extract stable parts later)
packages/
  show-model/     # Pure TS: schema, evaluate(), presets, migrations. NO three.js.
  renderer/       # three/webgpu: fixture meshes, TSL materials, post-processing
  fixtures/       # Fixture profiles (JSON/TS): channel maps, capabilities, physical limits
agent_docs/       # Planning and decisions (agent-maintained)
user_docs/        # User-authored docs — never modify
```

## Dependency rules

```
apps/web, apps/spike -> packages/renderer -> packages/show-model
apps/web, apps/spike -> packages/show-model
apps/web, apps/spike -> packages/fixtures -> packages/show-model (types only)
show-model must never import three, DOM, or WebAudio.
```

The current spike keeps its scene implementation in `apps/spike`; extract stable renderer pieces to `packages/renderer` after the visual/performance experiments.

Enforce with an ESLint `no-restricted-imports` rule in `packages/show-model`.

## Package responsibilities

**show-model**
- `Show` document types + Zod schema + `version` migrations
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
- Fixture → scene object factory
- TSL beam/volume/fog/emissive materials
- Post-processing stack (bloom, streaks, lo-fi pass, dynamic resolution)
- `setFixtureStates(states)` per frame; no show logic
- Perf instrumentation (frame ms, draw calls, visible lights)

**apps/web**
- Layout: viewport, timeline, inspector
- Audio engine + analysis worker
- Editor state (zustand) separate from the immutable show document
- Persistence (IndexedDB autosave, file import/export)

## Tooling

- TypeScript `strict`, `noUncheckedIndexedAccess`
- Vitest for `show-model` and `fixtures`; Playwright for app smoke + screenshot diffs later
- Zod for all external data (documents, profiles, settings)
- Package manager: npm workspaces (no monorepo framework until it hurts)
