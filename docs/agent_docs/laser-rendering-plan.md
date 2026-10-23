# Laser Rendering Plan

**Status:** in progress (2026-10-19). L0 and L1 are implemented; L2–L5 are
planned. `LaserRig` (`src/laser-rig.ts`) renders each laser as camera-facing
ribbon quads (one quad per beam, one draw call per fixture) built in the
vertex shader from a per-beam direction attribute, with `fan`, `sweep`,
`tunnel`, `wave`, and `lattice` patterns computed on the CPU. Beams terminate
on venue surfaces and draw an additive dot splat per hit (`dots` pattern
still falls back to `fan` — it needs sprite diffraction, L5). `Stage` creates
rigs through the `createFixtureRig` factory. Room-light contribution is
intentionally zero (`beamInfo.level = 0`).
**Scope:** make laser fixtures look and behave like lasers. Depends on the rig
model in `stage-rig-editor-plan.md` for placement and persistence; the render
path itself is independent.

## The problem

`FixtureRig` builds every fixture from the same cone-based beam proxy
(`createBeamMaterial()` in `src/rig.ts`). A laser is only distinguished by
`kind === 'laser'` in two places:

- `gain = 9` on beam intensity;
- floor-pool intensity multiplied by `0.05`.

Everything else is the moving-head path: a 16-sided cone from a 6 mm aperture
(`LASER.beam.apertureDiameterM`), a spread of `0.6°–1.8°`
(`LASER.beam.spreadDeg`), and a cylinder that widens with throw. At 20 m a 1.2°
cone is ~0.42 m wide, so the result reads as a thin spotlight, not a laser.

Real laser projectors (and the reference photos) show:

- several **razor-thin, near-parallel beams** from one aperture;
- **fans** and symmetric patterns, not a single cone;
- beams that stay bright across the whole room and **terminate in a visible
  dot/splat** on a surface;
- strong bloom and a hot near-white core with a saturated edge;
- movement that comes from **scanners** (pattern phase, fan rotation), not
  from a smoothly slewing head.

A laser is therefore a different render primitive and a slightly different
control model, not a brighter moving head.

## Design

### 1. Model: a laser setup on the placement

Add an optional block to `FixturePlacement` (additive; bundled into the v2
schema from the rig plan):

```ts
export type LaserPattern = 'fan' | 'sweep' | 'tunnel' | 'wave' | 'lattice' | 'dots';

export interface LaserSetup {
  /** Number of emitted beams. Clamped to `profile.laser.maxBeams`. */
  beams: number;
  /** Beam arrangement. */
  pattern: LaserPattern;
  /** Full fan width in degrees. Ignored by patterns with no fan. */
  fanDeg: number;
  /** Per-beam divergence in degrees (the beam's own spread). */
  divergenceDeg: number;
  /** Pattern motion in cycles per second; 0 = static. */
  speedHz: number;
  /** Pattern phase offset in degrees, so grouped lasers can be offset. */
  phaseDeg: number;
}
```

Defaults for a `LASER` fixture: `beams: 8`, `pattern: 'fan'`, `fanDeg: 40`,
`divergenceDeg: 1.2`, `speedHz: 0.5`, `phaseDeg: 0`.

Profile addition (optional, so existing snapshots stay valid):

```ts
profile.laser?: {
  maxBeams: number;              // 32
  patterns: LaserPattern[];      // what the UI should offer
  fanDeg: [number, number];      // limits, e.g. [0, 120]
};
```

Separate **setup** from **animation**, consistent with ADR-010:

- **Setup (persisted, not animated):** beam count, pattern, fan width,
  divergence, speed, phase. These are what an operator changes between songs
  or between cues on a console.
- **Animated by clips:** `rotation` (pattern rotation) and `pan`/`tilt` (aim)
  already exist. Use `rotation` as the scanner's rotational phase so current
  sweep/hold actions produce visible motion without new attributes.
- **Pattern selection is setup, not animation, in the first pass.** This is
  the smallest change that makes lasers read correctly and reuses the
  persisted-setup layer (ADR-010). Do not add a `ControllableAttribute` for
  beam count, fan, or pattern until there is a concrete authoring need; a
  later `fan` or `pattern` attribute must be additive.

`FixtureState` gains:

```ts
laser?: {
  beams: number;
  pattern: LaserPattern;
  fanDeg: number;
  divergenceDeg: number;
  speedHz: number;
  /** Scanner phase in radians, derived from song time and setup. */
  phase: number;
};
```

`evaluateFixture()` fills it for `kind === 'laser'` (or any profile with a
`laser` block), clamping `beams`/`fanDeg` to the profile limits so a hand-edited
project cannot ask for 5,000 beams. `rotation` becomes the phase offset:
`phase = 2π * (speedHz * timeSec + rotation + phaseDeg/360)`.

### 2. Renderer: `LaserRig`, one draw call per laser

Create a separate rig class and a factory:

```ts
export function createFixtureRig(placement: FixturePlacement): FixtureRig | LaserRig
```

Both expose `addTo`, `removeFrom`, `setVisible`, `update(state, timeSec, options)`,
so `Stage` keeps an array of the common interface.

**Geometry.** One `BufferGeometry` containing `beams × 2` triangles (a quad per
beam) with a per-vertex `beamIndex` attribute, plus the fixture's transform.
Beams are camera-facing ribbons built in the vertex shader:

```
axis      = patternDirection(beamIndex, state.laser)
side      = normalize(cross(axisWorld, viewDir))
position  = origin + axis * t + side * halfWidth
```

This keeps the beam visible at any viewing angle without a 30-sided cylinder
(one beam becomes 4 vertices instead of ~120) and avoids the cone silhouette
that makes the current lasers look like spotlights. Width is world-space
(~4–10 mm) with a **minimum angular width** so distant beams do not disappear:

```
halfWidth = max(worldHalfWidth, distance * minAngularHalfWidth)
```

`minAngularHalfWidth` ≈ 0.0008 rad (~0.05°), which is roughly 1 px at 600 px
FOV; bloom then supplies the glow.

**Colour.** Additive, depth-write off, fog on but with a shallow distance
falloff (unlike the current `1 - 0.85·t` axial fade, which kills long beams).
Core is desaturated toward white; the saturated colour carries the halo:

```
glow = mix(color, vec3(1), 0.55) * core + color * halo
```

**Haze coupling (planned, not in the first pass).** A beam is only visible
because light scatters off haze; the reference images work because the room is
full of it. Fog/haze machines are already on the roadmap for atmosphere
authoring, and their output must drive beam brightness rather than being a
cosmetic overlay:

- add a scene-wide `hazeDensity` value (venue default plus a user setting).
  Beam brightness scales with it, and at zero density a laser reduces to its
  emitter glow plus the surface dot — which is physically correct and makes
  haze a meaningful choice, not decoration;
- the same value should drive spot/wash beam brightness, so all beams respond
  consistently when the room changes;
- when positioned fog machines land, approximate density per beam by sampling
  the source volumes at 3–4 points along the ray and use the average. Do not
  raymarch per beam; the beams are cheap by design and a volumetric pass would
  undo that;
- haze density can itself be clip-animated later (a fog cue before a drop),
  so store it as normalized `0..1` rather than a physical coefficient;
- `fixtures` that emit haze (fog machines) are not beams: they are sources and
  should render as visible plumes, which is separate atmosphere work.

The first laser pass should still ship a fixed sensible haze value so the look
is judged under realistic conditions; the coupling is a small addition once
the atmosphere model exists.

**Patterns** (computed per vertex from `beamIndex`, `phase`, `fanDeg`):

| Pattern | Arrangement | Motion |
|---|---|---|
| `fan` | evenly spaced angles across `fanDeg` in the head's fan plane | static |
| `sweep` | same as `fan` | fan centre sweeps with `phase` |
| `tunnel` | beams on a circle around the head axis, `fanDeg` as the cone half-angle | circle rotates with `phase` |
| `wave` | evenly spaced fan, each beam offset by `sin(phase + i/n·2π)` | travelling wave |
| `lattice` | two orthogonal fans | both rotate in opposite directions |
| `dots` | one beam plus a diffraction dot array at the hit | static |

Ship `fan`, `sweep`, `tunnel`, `wave` first. `lattice` needs twice the beams
(two fans) and `dots` needs sprites at the surface hits; both are additive
follow-ups.

**Termination.** A laser must stop on geometry and show a dot. Do it on the
CPU per laser per frame (cheap: beams × surfaces, e.g. 8 × 5):

- the venue template exposes its blocking surfaces as axis-aligned planes with
  bounds (floor, stage deck, back wall, side walls, LED wall);
- for each beam, intersect the ray and take the smallest positive `t`;
- write `t` into a per-beam uniform/attribute for the shader, so the ribbon
  ends exactly on the surface;
- draw one additive dot per beam at the hit (an `InstancedMesh` of small
  quads, one per laser) once the dots pass lands.

Keep the existing `pool` for lasers off; the splat replaces it.

### 3. Stage surfaces for termination

`Stage` currently hardcodes the floor, walls, riser, and LED wall, and the
existing floor-pool logic already special-cases the riser footprint
(`y = 0.3` inside `x ∈ (-11, 11)`, `z ∈ (-12, -2.6)`). Move that knowledge
into the venue template so the same list serves the pool and the laser:

```ts
interface VenueSurface {
  kind: 'floor' | 'wall' | 'riser' | 'led';
  /** Plane: y = constant, x = constant, or z = constant. */
  axis: 'x' | 'y' | 'z';
  value: number;
  bounds: { x: [number, number]; y: [number, number]; z: [number, number] } | null;
  /** Small offset for decals so they do not z-fight. */
  decalOffset: number;
}
```

The rig can then stop hardcoding `hitX > -11 && hitX < 11` and reuse the same
surface list for both the moving-head pool and the laser splat.

### 4. Safety and look

- Add the show-level **laser enable** and a scene-wide beam budget. These are
  functional controls (blank the lasers, keep the frame cost bounded), not a
  safety disclaimer. **No photosensitivity warning** — the user explicitly does
  not want one (2026-10-18).
- **No audience-scanning zones in the first pass.** A scanning zone would be a
  venue-defined volume that limits where beams may terminate (for example,
  "never below 1.5 m over the crowd"). The idea is liked, but it needs venue
  data, UI, and per-beam checks, so it is deferred until the pattern renderer
  is proven. When it lands, it should live in the venue template next to the
  surfaces (section 3).
- Clamp total active beams (e.g. 256 scene-wide) and surface it in the HUD as
  `beams` next to `draw calls`; lasers are cheap, but bloom is not free.
- No shadows, no per-beam lights. The visual is additive geometry plus bloom.
- Provide a `Beam width` setup control (world mm) so users can trade subtlety
  for visibility on projectors.
- Keep beam brightness tied to the haze model (see the haze-coupling note
  above) rather than hardcoding a "laser looks bright" multiplier. A scene
  with no haze should look like a scene with no haze.

### 5. Demo and sample project

The demo ships two lasers (`laser-0`, `laser-1`) on `truss-rear`. Give them
`laser: { beams: 12, pattern: 'fan', fanDeg: 55 }` and `pattern: 'tunnel'` for
one of them, then let the existing `sweep`/`hold` cues drive `rotation`.
Update `resources/sample_projects/koto-chill/koto-chill.dmxsim` in the app
(**Save project**) and check both camera presets.

## Milestones

| # | Work | Exit criterion |
|---|---|---|
| L0 ✅ | `LaserSetup` + profile limits + `FixtureState.laser` + evaluation/clamping + schema | Model tests pass; a project round-trips a laser setup |
| L1 ✅ | `LaserRig` ribbon renderer; factory used by `Stage` | A laser renders as N thin beams, not a cone |
| L2 ✅ | Beam termination on venue surfaces + splat dots (lasers only) | Beams stop on the floor/walls/LED wall; no beams through geometry |
| L3 ✅ | `sweep`, `tunnel`, `wave`, `lattice` patterns driven by `rotation`/`speedHz` | Existing laser clips visibly scan; groups can be phase-offset |
| L4 | Laser master enable and beam budget HUD; bloom/exposure tuning against the references | Look review against `docs/user_docs/lightshow_inspiration`; measured frame cost |
| L5 | `lattice` and `dots`, optional animated `fan` attribute | Deferred unless the authoring flow needs them |

Decision (2026-10-18): ship the easy, high-value path first — setup-based
patterns and `rotation`-driven motion. Anything that needs a new controllable
attribute or venue safety data waits until the pattern renderer has been
judged on screen. Haze coupling ships with the atmosphere work, not with L1–L4,
but the beam shader must already read a haze uniform so the link is a value
change, not a rewrite.

## Tests

`show-model`:

- laser defaults are applied when `laser` is absent;
- `beams` and `fanDeg` clamp to profile limits, including hostile values;
- phase advances with `speedHz` and wraps; `rotation` offsets phase;
- project round-trip preserves the setup; migration leaves non-laser fixtures
  untouched.

Manual/renderer:

- one laser, 32 beams, static fan: verify no z-fighting, visible at 25 m;
- haze at 0, 0.5, and 1: beam brightness scales; at 0 only the emitter and
  the surface dot remain, with no floating streaks;
- floor, riser, back wall, and side-wall hits produce a dot at the surface;
- 16 lasers × 16 beams: frame cost and draw calls; compare with today's cones;
- WebGL2 fallback (same TSL graph) and Firefox, since the ribbon shader is new;
- photosensitivity: not applicable — no warning is shipped (see section 4);
  verify the laser master and beam budget actually darken/clamp output.

## Risks and mitigations

- **Per-vertex pattern math hides bugs.** Keep a debug mode that logs the
  computed beam angles for one fixture and compare with the spec table.
- **Ribbons can look like flat quads when viewed along their edge.** The
  cross-product billboard degenerates when `viewDir` is parallel to the beam;
  clamp the side vector and accept that a beam viewed exactly end-on collapses
  to a dot (which is physically reasonable).
- **Screen-space minimum width can alias.** Use a conservative minimum plus
  bloom; verify on a 1080p capture rather than trusting a live preview.
- **Beam counts multiply.** Users will stack pattern lasers. Cap total beams
  and surface the count; do not let a project file set an unbounded value.
- **Model drift.** Laser pattern is setup, movement is clip-driven; adding
  `fan` later must remain additive and optional.

## Open questions

1. Do we need audience-scanning restrictions/zones for realism and safety, or
   is a global enable enough for a simulator? Liked, but deferred as too
   complex for now; the first pass ships the global enable only (section 4).
2. Is a laser a **fixture** or an effect layer that can exist without a
   physical housing? The reference shows physical projectors, so fixture is
   assumed.
3. Should `lattice`/`dots` be patterns of one fixture, or separate profiles
   (grating vs scanning projector) with different beam budgets?
4. Does the second stage need lasers aimed into the crowd (visible in the
   references) despite the safety affordance? If yes, that is the point where
   an audience zone becomes necessary.
5. Should haze be a venue default, a show setting, or both? Recommended: venue
   provides the default, the show setting overrides it, and clips can animate
   it later.

Resolved: pattern selection is a persisted setup value, not a clip-animatable
attribute, for the first pass (see section 1).
