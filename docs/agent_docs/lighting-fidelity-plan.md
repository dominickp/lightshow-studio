# Lighting Fidelity Plan

**Status:** Tier 0 complete except 0.7 (2026-10-18). Tier 1 not started.
**Scope:** make the rendered light read as light in haze, on surfaces, and
toward the viewer — not as glowing geometry. Complements
`laser-rendering-plan.md` (which owns the laser primitive) and
`decisions.md` ADR-007 (low-fi geometry, high-fidelity light).

## The gap

Reference photos in `docs/user_docs/lightshow_inspiration/` share these traits:

- the beam is a **scattering volume**: soft cross-section, bright core,
  feathered silhouette, brighter when it points toward the camera;
- beams **end on geometry** with a soft penumbra (floor, riser, walls, truss,
  crowd), and never show a flat cut when they hit nothing;
- the **surfaces light up**: correct projected ellipse pools, spill on the
  truss and crowd, colour bounce into the room;
- **haze is the main ingredient**; at zero haze you should see only the
  emitter and the surface hit;
- fixtures aimed at camera are **blinding glare**, not a small lens dot;
- wide fixtures (wash/blinder/strobe) read as soft **area sources**.

The current renderer (`apps/lighting-spike/src/rig.ts`) builds every fixture
from one hollow cone mesh:

- `facing = |normalView · viewDir|` made the cone read as a glowing tube and
  made beams pointed at the camera nearly disappear (normals are radial, so
  `n·v → 0` when looking down the axis; the cylinder has no caps);
- `length = min(throwM, hardcoded floor/riser hit)` truncated upward beams
  with a flat rim and ignored venue walls, ceiling, LED wall, and truss;
- the pool was a flat additive circle at `2.4 ×` the true cone radius;
- beam brightness ignored spread (a 6° head was as bright per pixel as a 42°
  head);
- beam brightness was constant — no haze coupling, so `FogExp2` did basically
  nothing over a 20 m beam;
- the only actual lighting was one hardcoded `SpotLight` and four fake
  `PointLight`s at arbitrary positions driven by `states[(i*7) % n]`.

## Tiers

### Tier 0 — cheap wins, big perceived jump

| # | Change | Status |
|---|---|---|
| 0.1 | View-ray cone integration (soft cross-section, bright when end-on) | ✅ done |
| 0.2 | Source glare sprite at the lens | ✅ done |
| 0.3 | Beam termination on `VenueSurface[]` + soft end fade | ✅ done |
| 0.4 | Pool fix: true radius, projected ellipse, penumbra, energy scaling | ✅ done |
| 0.5 | Spread normalisation (narrow beams brighter per pixel) | ✅ done |
| 0.6 | `haze` parameter driving beam brightness + scene fog | ✅ done |
| 0.7 | Depth-texture soft intersection | ⏳ deferred — needs the scene depth texture plumbed into rig materials; 0.3's fade covers the visible hard edge for now |

Acceptance for Tier 0: a beam pointed at the camera is the brightest thing in
the frame; a beam pointed at the ceiling fades out instead of ending in a flat
rim; a beam hitting the wall stops on the wall; the floor pool matches the
beam's cone and is elliptical on grazing hits.
### Beam shader revert (2026-10-19, user decision)

The Tier 0.1 view-ray cone integral was **reverted** to the original
local-space shading (axial falloff × |n·v| facing × noise). Both variants were
verified side by side at matched camera/song time; the integral version was
rejected on three user-visible counts, measured in screenshots:

- mean viewport luminance 0.16 vs 0.10 original, clipped pixels 6.0 % vs 1.6 %:
  volumetrics read as opaque slabs, the opposite of "scattering volume";
- no normal term, so the cone shaded flat instead of with a bright core and
  feathered silhouette;
- the chord collapses to zero at the end plane (every fragment at
  `axial = length` has no chord), which painted a dark disc inside a bright rim
  at every beam base. Reproduced with the crowd disabled to rule out crowd
  occlusion; the original formulation shows no artifact at the same frames.

Kept from the integral era: beams terminate on `venue.surfaces` (including the
club ceiling) with a 0.9 m dissolve when they escape into the room; the emitter
glare is sized from the real aperture (`apertureRadius × 4`, capped ≥ 0.22 m)
instead of growing with camera distance; `uHaze` still couples beam weight to
the scene haze. The room-lighting pool and the fixed light count are separate
and unaffected.

### Spill and haze coupling (2026-10-19)

**Floor spill.** A real fixture does not stop dead at its beam angle: the
reflector, the lens and the fixture's field angle throw a little light wider
than the nominal cone. The floor decal is therefore drawn at 1.15× the
geometric footprint, with the texture's bright core ending at radius 0.87
(coincident with the cone edge) and a faint tail out to 1.0. The tail is ~14 %
of the core, which is in the range of real spill and reads as scatter rather
than a second ring.

**Haze.** Beam brightness scales with `uHaze²`: air scatter is the only reason
a beam volume is visible, so thinning the haze empties the volume quickly. At
`haze = 0` the room shows LED/stage emissives and coloured floor pools with no
beams at all.

**Haze controls pool softness, not pool presence.** A clear room scatters
nothing sideways, so the footprint is the geometric cone with a tight edge;
haze scatters light past the cone edge and widens the penumbra. The pool
material interpolates with `uHaze`:

| | haze 0 | haze 1 |
|---|---|---|
| core → penumbra step | 0.62 → 0.84 | 0.22 → 0.72 |
| penumbra ends at | 0.90 | 1.00 |
| penumbra gain | 0.24 | 0.34 |
| footprint scale | 1.18× cone | 1.35× cone |

`poolHazeGain()` also keeps total energy roughly constant: the pool brightens as
haze drops (~3× at 0), because light that would have been scattered in the air
now reaches the surface.

Verified: mean floor-band luminance 0.026 / 0.099 / 0.139 at haze 0 / 0.65 / 1.
A slider lives in the **Venue settings** panel (Atmosphere group) and persists in
`dmxsim.spike.render` as `haze`; `H` cycles 0 → 0.3 → 0.65 → 1. Haze is a
render preference, not a project setting, so the `.dmxsim` schema is unchanged.

Known gap at `haze = 0`: the room reads very dark outside the pools. There is no
ambient reference, floor albedo is only ~4 %, and the floor haze plane
(`buildHaze`) is multiplied by haze so it vanishes. Options: give the haze plane
a non-zero floor, raise floor albedo, or lift ambient at low haze.

Follow-up if the cone-integral approach is ever retried (Tier 1's quad pass
would be the place): integrate over a *truncated* cone (apex pulled back by
`apertureRadius / slope`) so the volume starts at the lens, and bound the end
fade so a landed beam still reaches its surface pool.

### Tier 0 session log (2026-10-18)

Verified in the browser (Chromium/WebGL2 fallback) from the front and
audience camera presets:

- beams have a soft cross-section and no longer show a hollow-tube silhouette;
- beams terminate on the venue surfaces and dissolve at the end;
- flood/wash fixtures now throw soft wide lobes instead of a hard cone rim;
- the stage floor shows coloured pools that follow the beam footprint;
- fixtures have an emitter glare sprite, and it grows as the beam turns
  toward the view.

Two implementation traps worth remembering:

1. The quadratic roots are distances **along the view ray**, while the beam
   length is metres **along the beam axis**. The chord must be clipped by
   `axial = dot(x, axis) ∈ [0, length]`, not by `t <= length`.
2. For a narrow cone the quadratic coefficient `qa = m² - cos²` is usually
   negative. Forcing the denominator positive flips the root order and makes
   the chord clamp to zero (invisible beams). Keep the sign and sort the two
   roots instead.

Current tuning constants in `createBeamMaterial()`: density `sqrt(chord) × 3.6`,
phase `0.75 + 1.6·toward²`, axial falloff `1 − 0.35·t`. Pool intensity is
`level × spreadGain × 0.75 / ((1 + d·0.1) × stretch)`. These were tuned against
the club demo; re-check them when real surface lighting (Tier 1.9) lands,
because pools and beams will then share a much brighter floor.

Known gaps visible in the spike after Tier 0:

- ~~the room is still not *lit* by the fixtures~~ — fixed by the Tier 1.9/1.10
  first pass (2026-10-18): floor washes, lit crowd silhouettes, wall spill,
  and beat-pulsed ambient now come from the live fixtures;
- many overlapping wide beams read as translucent sheets rather than volume;
  the area-source treatment in Tier 2.15 is the fix. Close-up, the wedge
  silhouette of a wide wash is still visible — same root cause;
- the bounce fill is one fake bounce with no occlusion, so light leaks
  through the riser and the crowd; real shadows on more than one light would
  need a bigger budget (Tier 2.14);
- no colour bounce, so the air away from a beam stays black — Tier 1.10.
- **shadows are visually inert, so the Shadows toggle was removed
  (verified 2026-10-21).** The key light's shadow map does render, but nothing
  occludes that spot's cone in the sample show: canvas captures were
  pixel-identical with shadows on and off at 7 song times and all 4 camera
  presets. Beams and floor pools are additive decals, so they cannot receive
  shadows either. The key light now always casts (no runtime toggle, no
  `setShadows`). Making shadows read means an occluder in the key light's beam
  (crowd/riser) or promoting a second key light.
### Tier 1 session log (2026-10-18, first pass)

- `rig.ts` publishes `beamInfo` per fixture per frame; lasers are excluded
  from room lighting (`level = 0`) until `LaserRig` decides otherwise.
- `stage.ts` owns `LIGHT_POOL_SIZE = 4` spotlights, `BOUNCE_LIGHTS = 2` point
  fills, one ambient. The key light always casts shadows (the runtime toggle
  was removed in 2026-10-21; `castShadow` is set once at construction).
- Verified in-browser: floor washes and crowd silhouettes appear, walls pick
  up colour spill, the LED wall and stage edge remain emissive, and dark cues
  now leave the room genuinely dark (the old hardcoded lights never turned
  off).
- Tuning to revisit: pool intensity base (`105` / `26` wide), concentration
  clamp (`22 / spreadDeg → 0.35…3.2`), ambient `0.1 + energy·0.14`.

### Uneven-glow fixes (reported after the first pass)

The user reported that 3–4 fixtures on one side showed a "glow at the bottom,
like a spot reflection", while the rest did not. Three separate causes:

1. **Prefix selection.** The pool sorted active fixtures by dimmer level and
   took the first N. Because most fixtures sit at the same level, the sort was
   effectively stable, so *the same first N fixtures in rig order* always got
   a real light and every other fixture lit nothing. Fixed by stratifying:
   the rig is split into `LIGHT_POOL_SIZE` slices and each slice contributes
   its brightest fixture, so coverage is spatially even regardless of how many
   lights are on.
2. **Bounce hotspot.** The fill light sat 0.3 m above the hit point, so the
   inverse-square falloff blew out a small disk on the floor/riser — reading
   as a spot reflection. Fill lights are now lifted 1.1 m off the surface,
   weaker, and spread by an even stride over the promoted fixtures.
3. **Glare baseline.** The emitter sprite kept a 25 % floor for *every* lit
   fixture, so fixtures aimed away still showed a floating blob at the lens.
   It is now strongly directional (`0.03 + 1.15·toward³`), matching the
   physically reasonable rule that you only see glare when the fixture can
   actually see you.

Budget note: 4 + 2 dynamic lights, and the count must never change. The
earlier 8 + 4 pass cost twice the frame time on the WebGL2 path (4 + 2 holds
60 fps where 8 + 4 sits at ~24 fps in the close-up preset), and toggling
`light.visible` per cue was far worse than the light cost itself: see below.

### Freeze at cue changes (fixed 2026-10-19)

Symptom: ~1 s freezes whenever playback crossed a clip boundary. A Chrome
profile showed a single `Animation frame fired → Function call` task of
1.09 s, 1,041 ms of *scripting* and 3 ms of rendering, so it was never GPU
fill rate.

Cause: `updateLights()` set `light.visible = false` for idle pool slots and
true again when a fixture came back. Changing the visible light count makes
three/webgpu rebuild the light loop of every material in the scene (venue,
crowd instances, fixture bodies), which is a synchronous recompile.

Reproduced locally with a `longtask` observer: 8 long tasks of 1017–1105 ms
per 30 s of playback. Fix: all pool lights are added visible once and idle at
`intensity = 0`, and `castShadow` is assigned once at construction (never per
frame; the runtime shadows toggle was removed in 2026-10-21). Same measurement after the fix: 199 / 74 / 68 ms, 60 fps.

Rule to keep: the number of scene lights is part of the shader program key.
Never add, remove, hide or un-hide a light while a cue can be changing.

### Tier 0.5 — follow-ups discovered while implementing

- [ ] **Haze UI**: `Stage.setHaze()` exists, but the controls panel has no
      slider. Add `Render → Haze` and persist it with render settings.
- [ ] **Tune against a reference frame**: the club demo is dominated by wide
      wash fixtures; add a fixture-panel debug view or a saved camera preset
      that matches `edm_1.png` so beam brightness can be compared directly.
- [ ] **Beam depth sorting**: two additive beam meshes intersecting the same
      fragment double-brighten. Acceptable now; the Tier 1 quad pass removes
      it.
- [ ] **Beam/gobo texture**: `gobo` is modelled but not projected; the
      reference set leans on patterned beams.
- [ ] **Laser primitive**: still one cone per laser. `LaserRig` ribbons are
      Tier 1 below and owned by `laser-rendering-plan.md`.
- [ ] **Sky/ceiling termination**: the club template now lists a ceiling
      surface; confirm other templates do too when they land.
- [ ] **Perf check**: chord integration is per-fragment and cheap, but measure
      at 32 fixtures / 144 fps in both Chromium and Firefox.

### Tier 1 — the real fidelity jump

8. **Screen-space cone volumetric pass.** Replace the cone mesh with one
   bounds quad per fixture and integrate the view ray analytically against the
   cone in the fragment shader, clamped to the scene depth. Removes the
   remaining mesh silhouette, gives free soft intersections with *any*
   geometry (truss, crowd, LED wall), and is the intended ADR-007 budget
   ("half-res raymarched volumes against mesh-beam proxies"). Tier 0.1 already
   does the chord integral; Tier 1 moves it from the cone surface to a quad so
   coverage stops depending on 30 radial segments and depth can clip it.
9. **Actually light the room.** ✅ first pass — the fixture light pool. Every
   fixture used to render only additive geometry while one hardcoded warm spot
   and four point lights at arbitrary coordinates lit the room. `Stage` now
   keeps a pool of 10 `SpotLight`s plus 4 shadowless `PointLight`s and each
   frame promotes the brightest fixtures that are actually on (`rig.beamInfo`
   publishes origin/axis/spread/level/colour/hit from `update()`). Intensity is
   energy-normalised (`22 / spreadDeg` clamp), wide fixtures get a softer
   penumbra, and the brightest fixture is the only shadow caster (ADR-007
   budget). Replaces the analytic-array option if it holds up; revisit at
   higher fixture counts.
10. **One bounce.** ✅ first pass — fill `PointLight`s at the brightest beam
    hits, offset along the hit normal, plus a coloured `AmbientLight` derived
    from the live light average and beat energy. Stops the floor reading as a
    flat decal and puts colour into the air and on the truss.
11. **Gobos and prism.** Project a texture in both the volume and the pool.
    Without this we only cover half the vocabulary in the references.
12. **HDR exposure + two-scale bloom.** Beams should exceed 1.0 luminance so
    ACES desaturates cores to white and bloom supplies both the hot core and
    the wide halo.

### Tier 2 — later, but design for it now

13. **Haze/fog machines and ground fog layers.** Sample density at 3–4 points
    along each beam; never raymarch per beam. The shared `haze` input added in
    0.6 is the single source both spots and lasers read.
14. **Beam shadows.** Only possible after (9): 1–2 shadow-casting key fixtures
    plus crowd/truss occluders. Volumetric beams cannot cast shadows.
15. **Area sources for wide fixtures.** Wash/blinder/strobe should be soft
    lobes, since a 110° "cone" is meaningless; they mostly do surface lighting.
16. **Reflections.** A cheap floor reflection (planar or screen-space) for
    glossy floors is what sells the Justice/EDM stage shots.

## Implementation notes (Tier 0)

- `createBeamMaterial()` now reconstructs the view ray per fragment and solves
  the ray/infinite-cone quadratic. Brightness is
  `sqrt(chord) × phase × endFade × haze × noise × intensity`. The `sqrt`
  compresses the wide dynamic range so side-on beams stay visible while
  end-on beams dominate, and the chord naturally tends to zero at the
  silhouette, which is the soft cross-section.
- Depth write stays off; blending stays additive; both faces are drawn, so the
  chord is effectively counted twice — the intensity constants account for it.
- `FixtureRig.update()` needs the camera, the venue surfaces, and haze. `Stage`
  passes them; callers still pass only `{ volumetrics }`.
- Beam length is the nearest `VenueSurface` hit within `profile.beam.throwM`,
  never the hardcoded riser footprint. No hit means the beam fades over its
  last ~0.9 m instead of showing a cap.
- The pool is a world-space disc oriented by `makeBasis(tangent, bitangent,
  normal)` with `1 / cos(incidence)` stretch and matching penumbra.
- `Stage.setHaze()` updates `FogExp2.density` and the floor haze plane. The
  default comes from `venue.features.haze` (0.65 when present, 0.05 when not).
- Lasers keep the existing cone for now; `LaserRig` remains the plan of record.

## Open questions

- Is `sqrt(chord)` the right compression, or should it be a proper
  Beer–Lambert integral with an extinction coefficient per venue?
- How much of the "haze" screen-space effect belongs in the post pass
  (bloom/exposure) versus in the beam materials?
- When `LaserRig` lands, should spots and lasers share the phase/termination
  helpers introduced here?
