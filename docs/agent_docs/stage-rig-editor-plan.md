# Stage Templates and Rig Editing Plan

**Status:** in progress (2026-10-18). M0–M3 are implemented; M4–M6 are planned.
**Scope:** data-driven venues, a second preset stage, and adding/removing/
placing fixtures so the rig is authored in the app and saved in `.dmxsim`.
Laser rendering is a separate plan: `laser-rendering-plan.md`.

## Why now

The spike's venue is fixed in code (`addRoom()` in `src/stage.ts`) and its rig
is generated in `src/demo-rig.ts`. A `.dmxsim` project can change fixture
*setup* values but not which fixtures exist: `openProject()` rejects any
project whose fixture IDs differ from the running build
(`rigMatches()` in `src/project-file.ts`). `activeFixtureCount` reveals the
first N fixtures by array index, which is a rendering stress control, not a
way to author a smaller show.

That leaves three product gaps this plan closes:

1. **Venue choice.** Users want more than one stage to build on, and many will
   not want to spend time building a rig at all. Each venue therefore ships as
   a template with a ready-made default rig, so "pick a stage, press play"
   works immediately. The inspiration photos show clearly different rigs: a
   club-ish stage with three overhead trusses and a centred LED wall, versus
   wide main-stage rigs with overhead grids, vertical side ladders, and low
   floor uplights.
2. **Rig ownership.** Users need fewer or additional lights, attached to a
   real structure (truss, riser edge, floor, wall), aimed sensibly.
3. **Portability.** A project file should fully describe its rig, so opening
   it on another machine reproduces the stage rather than failing a rig check.

A smaller rig is also the legitimate answer to "less complicated timeline": one
lane per fixture means removing a fixture removes its lane. This is preferable
to overloading the lane list with filters; group lanes are a later convenience.

## Current constraints to respect

- `packages/show-model` is renderer-free (ADR-006). Venue structure must be
  plain data there; three.js meshes are built in the app/renderer.
- Fixtures embed a full profile snapshot (ADR-008), so any project is
  evaluable without a profile lookup. Keep that.
- Physical mounting is not animatable; pan/tilt and zoom are (ADR-010).
  Mount orientation must stay on `FixturePlacement`.
- `evaluateFixtureStates()` reads `show.fixtures` every frame, and the stage
  rebuilds rigs from the same array (`Stage.setShow()`), so replacing the array
  propagates without extra plumbing.
- The arrangement keeps its own `fixtures` reference and renders one lane per
  fixture; it needs an explicit `setFixtures()` (today it is constructed once
  and only `applyProjectFixtureSetup()` mutates placements).
- Existing schema is `.dmxsim` version 1. Additive optional fields and a
  migration are required by `project-file-format.md`.

## Design

### 1. Venue templates (data, not code)

Introduce a `VenueTemplate` in `packages/show-model`:

```ts
export interface VenueTemplate {
  id: string;                 // 'club-stage', 'main-stage'
  name: string;
  description?: string;
  /** Room shell and stage dimensions, in metres. */
  bounds: { width: number; depth: number; height: number };
  /**
   * Optional procedural features the renderer knows how to build. Absent
   * means "this venue has none".
   */
  features: {
    riser?: { width: number; depth: number; height: number; z: number };
    ledWall?: { width: number; height: number; y: number; z: number };
    booth?: { width: number; height: number; depth: number; z: number };
    crowd?: { count: number; spreadX: number; spreadZ: number; nearZ: number };
    haze?: boolean;
  };
  /** Static structure: trusses, towers, walls, riser sides, decor. */
  structure: VenuePrimitive[];
  anchors: MountAnchor[];
  /** Ready-made rig, so choosing a venue needs no fixture authoring. */
  defaultRig: RigPreset;
  cameraPresets: CameraPreset[];
}

export interface RigPreset {
  id: string;
  name: string;
  fixtures: {
    profileId: string;        // resolved from the fixture library at app layer
    anchorId: string;
    u: number;
    offset?: Vec3;
    yawDeg?: number;
    mountPitchDeg?: number;
    name?: string;
  }[];
}

export interface VenuePrimitive {
  shape: 'box' | 'plane';
  role: 'metal' | 'wall' | 'floor' | 'stage' | 'dark';
  size: Vec3;
  position: Vec3;
  /** Plane normal/rotation in degrees. */
  rotationDeg?: Vec3;
}
```

`addRoom()` becomes `buildVenue(template)` in the stage: one loop over
`structure` plus feature builders (`ledWall`, `accentStrips`, `crowd`, `haze`)
that reuse today's code. The scene-side mapping lives in
`apps/lighting-spike/src/venue-builder.ts` (`buildVenue`, `buildCrowd`,
`disposeGroup`), so `show-model` stays renderer-free. The current room becomes
`CLUB_STAGE` with the same numbers (`stage.ts` today: floor 40×34 at z=3, walls
at ±17 and z=-12, ceiling y=12, riser 24×0.3×9.4 at z=-7.3, trusses y=8 at
z=1.6/-2.0/-5.6 spanning x=±10.5, LED wall 13.5×6.2 at z=-11.85, crowd of 90,
booth at z=-9.7). `Stage.setVenue()` tears down and rebuilds everything the
template owns. Exit criterion: the club stage renders identically to today.

### 2. Mount anchors define *where* and *which way*

```ts
export interface MountAnchor {
  id: string;                 // 'truss-front'
  name: string;               // 'Front truss'
  kind: 'truss' | 'floor' | 'riser' | 'wall' | 'tower' | 'free';
  /** Segment a fixture can be distributed along; equal points for point mounts. */
  start: Vec3;
  end: Vec3;
  /** Direction a fixture mounted here faces at its neutral orientation. */
  normal: Vec3;
  /** Default physical mounting orientation for this anchor. */
  mountPitchDeg: number;      // 0 = beam down; 180 = beam up
  /** Profiles the Add dialog should surface first. */
  suggestedProfiles?: string[];
}
```

Club-stage anchor set (from the current geometry):

| Anchor | Kind | Segment | Notes |
|---|---|---|---|
| `truss-front` | truss | (-10.5, 8, 1.6) → (10.5, 8, 1.6) | over the crowd/intro area |
| `truss-mid` | truss | (-10.5, 8, -2.0) → (10.5, 8, -2.0) | over the stage front |
| `truss-rear` | truss | (-10.5, 8, -5.6) → (10.5, 8, -5.6) | over the riser |
| `tower-left` / `tower-right` | tower | (∓10.5, 0.2, *) → (∓10.5, 8.2, *) | vertical side ladders |
| `riser-front` | riser | (-12, 0.3, -2.6) → (12, 0.3, -2.6) | low uplights |
| `stage-floor` | floor | (-12, 0.3, -12) → (12, 0.3, -2.6) | free placement on the deck |
| `wall-back` | wall | (-17, 0.5, -11.9) → (17, 0.5, -11.9) | wash/uplight mounts |

Anchors are also the snapping targets in the editor and the grouping key in
the rig list ("Front truss · 10 lights"). Distribution along a segment is what
makes bulk add useful: "8 moving heads, evenly on `truss-front`".

### 3. Placement gains a mount reference

```ts
export interface FixtureMount {
  anchorId: string;
  /** 0..1 along the anchor segment. Ignored for point anchors. */
  u: number;
  /** Offset from the resolved anchor point, in metres. */
  offset: Vec3;
  /** Override the anchor's suggested pitch for this fixture. */
  mountPitchDeg?: number;
}

export interface FixturePlacement {
  id: string;
  name?: string;              // friendly lane label; defaults to `<kind> <n>`
  profile: FixtureProfile;
  position: Vec3;             // resolved/cached; keeps v1 files and unknown venues valid
  yawDeg: number;             // resolved/cached
  pitchOffsetDeg?: number;    // resolved/cached
  mount?: FixtureMount;
  defaults?: FixtureDefaults;
}
```

Resolution lives in `show-model` and is pure and testable:

```ts
resolveMount(venue: VenueTemplate, mount: FixtureMount): { position: Vec3; yawDeg: number; pitchOffsetDeg: number }
```

Rules:

- If `mount` is present and `anchorId` exists, recompute `position` / `yawDeg` /
  `pitchOffsetDeg` from the anchor and `u`, then apply `offset`.
- If the anchor is unknown (file opened against a different venue build), keep
  the stored resolved values and mark the mount unresolved in the UI. Never
  drop a fixture silently.
- `yawDeg` follows the anchor's tangent/normal; the author can still nudge it.
- Writing the file stores **both** the mount and the resolved transform. The
  mount wins on load; the resolved values are the fallback.

### 4. Fix mount pitch being folded into tilt

**Done.** Before this change `evaluate.ts` computed
`tiltDeg = lerp(values.tilt, limits.tiltDeg) + fixture.pitchOffsetDeg`, and
`rig.ts` applied `head.rotation.x = -state.tiltDeg`. A floor uplight is
authored as `pitchOffsetDeg: 168` on the demo PARs, so a moving fixture mounted
at an angle could not use its full tilt range: the offset consumed it.

Mount pitch now lives in the transform, not the state:

```
root(position, yawDeg) -> mount(pitchOffsetDeg) -> yoke(panDeg) -> head(tiltDeg)
```

`FixtureRig` owns a `mount` group between the root and the pan axis and
re-reads `placement.pitchOffsetDeg` every update, so fixture-panel edits and
project loads take effect without rebuilding the rig. Fixed fixtures put their
housing inside the same group, which is why an uplight's can now points up
instead of only its beam doing so.

This physically matches a fixture clamped to a truss or floor plate (pan spins
around the mount axis), frees the profile's tilt limits, and removes the
offset from `FixtureState.tiltDeg`. The demo PARs keep their visual intent
with no numeric migration. `evaluate.test.ts` locks the behaviour: the same
tilt clip yields the same `tiltDeg` at mount pitch 0 and 168, and tilt still
travels the profile's full range.

### 5. Schema v2 and migration

Add to `project.ts` (version 2):

```jsonc
{
  "version": 2,
  "venue": { "id": "club-stage", "name": "Club Stage" },
  "show": {
    "version": 2,
    "fixtures": [
      {
        "id": "mh-front-3",
        "name": "Moving head 4",
        "profile": { "...": "snapshot" },
        "position": { "x": -2.7, "y": 7.4, "z": 1.6 },
        "yawDeg": -3,
        "pitchOffsetDeg": 0,
        "mount": { "anchorId": "truss-front", "u": 0.62, "offset": { "x": 0, "y": -0.6, "z": 0 }, "mountPitchDeg": 0 }
      }
    ]
  }
}
```

Migration v1 → v2 (in `migrateProject()`):

- add `venue: { id: 'club-stage', name: 'Club Stage' }` (the only venue that
  existed at v1);
- add `show.version: 2`;
- leave fixtures without `mount`; they keep their absolute transform and show
  as "Unattached" until re-anchored.

`openProject()` changes from rejecting mismatched rigs to replacing the rig:

1. resolve the venue template (unknown ID → clear error, or fall back to
   `club-stage` with a status warning);
2. `show.fixtures = project.show.fixtures` (profiles are embedded);
3. `stage.setVenue(template)` then `stage.setShow(show)`;
4. `arrangement.setFixtures(show.fixtures)` and `setCues(...)`;
5. drop clips whose `fixtureId` no longer exists (schema already calls that
   invalid; be forgiving on import and report the count).

`applyProjectFixtureSetup()` and `rigMatches()` can then be deleted. Fixture
count lists in `main.ts` (`counts = [10, 16, 22, 26, 32]`) must be derived from
the current rig, or demoted to a pure debug render budget.

### 6. Rig editing UX

**Implemented.** The side panel has two panes and shows one at a time:

- **Modify rig** — opened by the `MODIFY RIG` button in the timeline sidebar
  (the row that used to read `AUDIO`). Lists lights grouped by mount anchor
  (`Front truss · 10`) with a live fixture count, and hosts `+ Add lights`.
  Removal returns here, because removing a light is a rig-level action.
- **Fixture settings** — opened by clicking a track name. Shows name, mount,
  yaw/pitch, level, beam angle, capabilities, and clip counts.

Clicking the button or a track name again closes the panel. Picking a light in
the rig list selects its lane and switches to that light's settings. The header
describes the venue in rig mode (`Venue · Club Stage · 32 lights`) so the pane
never looks like a fixture is selected when it is not.

`+ Add lights` opens a dialog with profile, mount, count, and spacing (spread or
centre cluster). Removal confirms with the light's name and its clip count,
drops those clips in the same step, and refuses to remove the last light.
Placement controls add a name field, a mount select, and a **position on
mount** slider (0–100% along the anchor segment); yaw and mount pitch keep
their sliders. Track labels show `name ?? id` with the mount anchor on the
second line.

The position slider matters because choosing a mount only says *which*
structure a light belongs to. Without it, `resolveMount` used `u: 0.5` and every
re-mounted light landed in the middle of the bar. Switching mounts now keeps
the existing `u` and resets orientation and offset to the new anchor's
defaults, so re-homing a light does not also re-aim it or hang it at the wrong
height. Moving along a mount changes only the position: aim and mount pitch stay
as authored, and since `FixtureRig` reads placement every frame, no rig rebuild
or row re-render is needed.

Not yet exposed: the perpendicular `offset` (x/y/z). It currently comes from
the anchor's `mountOffset`, which is what puts truss lights below the bar and
floor lights on top of the deck. Fine-tuning hanging depth is the next
placement control to add.

The split exists because the rig list and the fixture controls are different
tasks. Showing both at once made the sidebar long and made the panel ambiguous
when nothing was selected.

Two behaviours worth knowing:

- `show.fixtures` is the document, so edits replace the array and rebuild the
  stage rigs. Name and mount edits skip the rebuild because `FixtureRig` reads
  placement every frame.
- Id allocation lives in `show-model` (`nextFixtureId`) and must be given the
  array being built, not the document's starting fixtures; otherwise a bulk add
  hands every new light the same id and the arrangement treats them as one.

Not in this pass: duplicate, context-menu removal, and rig undo (M6).

**Rig section** at the top of the fixture side panel:

- fixtures grouped by anchor: `Front truss · 10`, each row is kind + name with
  a remove button and visibility toggle;
- `+ Add lights` opens a small dialog (modal is acceptable at this size;
  the panel is 286 px wide):
  - **Profile** — grouped list from `PROFILE_LIBRARY` with kind and channel
    count;
  - **Mount** — anchor select, point anchors and segment anchors both allowed;
  - **Count** + **Spacing** (`Even across segment` / `Centred cluster` /
    `Manual`) for segment anchors;
  - **Add** — appends fixtures with generated ids (`mh-front-11`, unique),
    default setup values, and selects the first new fixture.

Placement controls (in the side panel, replacing the plain yaw/pitch sliders):

- **Mount** select (anchors) + `u` slider for segment anchors;
- **Offset X/Y/Z** in metres (this is also how "free" placement works: a `free`
  anchor with a world offset);
- **Yaw** and **mount pitch** sliders, with a "Reset to anchor" action;
- **Name** text field (lane label);
- **Remove light** button (also available via context menu on the lane).

Removal rules:

- Removing a fixture removes its arrangement clips in the same command.
- If `show.tracks[].clips` reference it (the envelope model, currently unused),
  remove those too; the schema forbids dangling references.
- Confirm in the UI, naming the clip count: `Remove wash-3 and its 12 clips?`
  (skip the prompt and allow undo once rig undo exists).

Duplicate: copies profile + setup + mount with `u` shifted by one spacing step
(or `offset.x` + 1 m on point anchors), new id.

Undo: clip undo lives in `Arrangement`. Rig edits are app-level, so this plan
introduces one shared history in `main.ts` that snapshots
`{ fixtures, cues }` for add/remove/duplicate and delegates clip gestures to
the arrangement. Ordering caveat: the shared stack must record which subsystem
owns each entry. Grouping multi-select rig edits technically belongs here but
can ship with the first single-fixture version.

### 7. Timeline integration

- `Arrangement.setFixtures(fixtures: FixturePlacement[])` replaces the array,
  re-renders rows, drops a selection that no longer exists, and keeps cues for
  surviving fixtures. Add-ons do not disturb existing clips.
- Track labels: bold line is `fixture.name ?? '<Kind> <index>'`; the small line
  shows the anchor name and profile name, e.g. `Front truss · Generic 16ch`.
- Track order stays fixture-array order. Add appends to the end of its anchor
  group; provide "Sort lanes by mount" as a one-shot action to normalise order.
  A persisted, user-reorderable track list is a separate feature
  (`ux-lighting-controls.md` open question).
- A smaller rig naturally yields a shorter timeline. Keep per-lane hide as an
  authoring aid, and keep the render budget as a debug/perf control only.
- Suggested follow-up (not in the first pass): a mount group lane that can be
  collapsed and that fans a group clip out to its members.

### 8. Second preset stage

Ship one new template, `MAIN_STAGE`, deliberately different from the club:

- wider and taller room (about 32 m × 22 m × 16 m);
- no booth riser; a 16–20 m wide LED backdrop;
- an overhead grid of two trusses plus two vertical side ladders;
- a downstage floor strip for uplights and a rear riser for drums;
- camera presets: wide front, low hero, side, overhead.

This matches the reference photos (overhead grids, symmetric side ladders,
large LED backdrop, low front uplights) and proves the template system: new
anchors, different camera set, same fixture model. Each template also ships
its `defaultRig`, built from the same profile library and anchored to that
venue's structures, so a user who does not want to customize anything gets a
working show immediately. `demo-rig.ts` is replaced by these presets.

### 9. Switching venues starts a new project

Fixture positions, lanes, and clips are all tied to a venue's anchors, so
carrying a show across venues produces either floating fixtures or a timeline
full of dead lanes. Switching venue therefore **starts a new project on the
new template's default rig and timeline**. The loaded song is kept: the audio
is independent of the venue, so the user does not have to re-import it.

1. If the arrangement has any clips, warn before doing anything:
   `Changing venue clears the timeline (N clips). The song stays loaded.`
   with `Save project first` / `Clear timeline and change` / `Cancel`.
   With no clips, switch immediately without a prompt.
2. Load the template (venue meshes, anchors, camera presets, default rig).
3. Reset the timeline: clear clips, reset the loop and zoom to the template's
   defaults, keep the audio and its decoded waveform/beat grid.
4. Create the default rig from `template.defaultRig`, giving each fixture a
   fresh id and applying its anchored mount.
5. Reset selection to the first fixture and close the fixture panel.

The prompt is about *placed clips*, not general unsaved edits: the project
file is only written on save, so "unsaved" would otherwise always be true and
the warning would become noise. The save action writes the current venue's
project before the switch, which is the escape hatch for authored work.

The project keeps `venue.id` in the file (schema v2), so saving and reopening
restores the same venue without a switch prompt. Opening a project whose
`venue.id` differs from the loaded template rebuilds the venue from the file's
venue id rather than treating it as a switch, so there is no data loss path.

Because this is destructive, the venue picker is an explicit command
(`Change venue…`), not a dropdown that applies on change. The picker can note
that the song is kept and the timeline is rebuilt, but the real guard is the
clip-count prompt above, which only fires when there is something to lose.
Undo is not required for this action in the first pass; saving first is the
safety net.

The save prompt is a known stopgap. Revisit it once undo/redo and autosave
exist: at that point a venue switch should be a normal undoable action (or at
least survive a reload), and the "save project first" branch can either go
away or become a real autosave-and-continue. Do not build more behaviour onto
the prompt before then (user decision, 2026-10-18).

## Milestones

| # | Work | Exit criterion |
|---|---|---|
| M0 ✅ | Schema v2, `VenueTemplate`/`MountAnchor`/`FixtureMount` types, `resolveMount`, migration v1→v2 | Round-trip and migration tests pass; v1 demo opens unchanged |
| M1 ✅ | `CLUB_STAGE` template + `buildVenue()`, `Stage.setVenue()` | Club renders pixel-comparable to today; all 32 fixtures sit on anchors |
| M2 ✅ | Mount pitch transform fix (M0 dependency) and `FixtureState` cleanup | Floor PARs and angled fixtures aim correctly; tilt range is whole |
| M3 ✅ | Rig editor: library dialog, add/remove, placement controls, `Arrangement.setFixtures` | Add 6 heads to `truss-mid`, save, reload, same rig and lanes (duplicate + undo deferred: M6) |
| M4 | Project open replaces the rig; retire `rigMatches` / `applyProjectFixtureSetup` | A project with 5 fixtures opens in a build that knows the venue |
| M5 | `MAIN_STAGE` template with its `defaultRig`, venue picker, switch-starts-new-project flow | Choosing a venue loads its rig and a clean timeline; audio survives; save prompt appears when there are clips |
| M6 | Rig undo, lane sort, docs/schema regen, sample-project update | Deleting a light is undoable; `docs/agent_docs/project-file-format.md` and the JSON Schema match v2 |

Laser work (M-laser) is planned separately and can run in parallel after M1,
because it only touches `rig.ts`/evaluation, not the venue data flow.

## Tests

`show-model`:

- `resolveMount` places a fixture at `u = 0`, `0.5`, `1`, and applies offsets;
- anchor tangent/normal produce the expected yaw;
- unknown anchor keeps the stored transform;
- v1 → v2 migration adds `venue` and `show.version`, leaves fixtures intact;
- `instantiateRig(template, profiles)` produces one fixture per `defaultRig`
  entry, with unique ids and resolved placements;
- venue switching clears clips and resets the loop, and keeps the audio
  reference;
- v2 round-trip with mounts, names, laser setup (once added);
- project validation still rejects duplicate IDs and dangling clip references;
- fixture count is unconstrained (the `min(1)` on `show.fixtures` is fine).

`arrangement`:

- `setFixtures` keeps cues for surviving fixtures and clears a removed
  selection;
- remove-fixture command deletes exactly that fixture's clips.

Manual/renderer checklist (no unit test harness today):

- club stage visual parity before/after the data-driven rebuild;
- mount pitch: a truss head at 0°, a wall wash at 90°, a floor PAR at 180°;
- 8-fixture and 32-fixture rigs at 144 fps in Chromium, plus a Firefox run;
- reload after Save/Open reproduces rig, lanes, clips, and camera.

## Risks and mitigations

- **Rig edits invalidate clips.** Removal deletes clips; keep it one undoable
  command and confirm the count. Schema validation catches dangling IDs.
- **Switching venue destroys authored work.** Starting a new timeline is
  intentional, so the guard is a save prompt before the switch plus a line in
  the picker stating that clips are cleared. Do not make venue a live dropdown.
- **Anchor drift across venue versions.** Resolved transforms are cached and
  used when an anchor disappears; the UI flags unattached fixtures.
- **Data-driven venue regressions.** `buildVenue()` must be checked against the
  current look; keep the old `addRoom()` code only until parity is signed off.
- **Scope.** Venue *editing* (moving trusses, resizing rooms) is explicitly out
  of scope. Templates are fixed data; users choose one and edit fixtures.
- **Timeline clutter.** One lane per fixture is the current contract. Group
  lanes are a follow-up, not a prerequisite.

## Open questions

1. Are fixture names user-editable free text, or generated (`Moving head 4`)
   with an optional rename? Recommended: generated default, optional rename.
2. Do we want a placement gizmo in the viewport in this pass, or are numeric
   and anchor-based placement enough? Recommended: anchors + numerics first;
   raycast dragging afterwards.
3. Should fixed fixtures (PAR, strobe, blinder) gain a "front/back of stage"
   facing preset instead of raw mount pitch? Recommended: keep numeric pitch
   plus anchor defaults, then add presets if users struggle.
4. Should the venue picker live in the transport (next to Open/Save project)
   or as a start screen? Recommended: transport for now; a start screen with
   template previews once there are more than two venues.

Resolved: two venue templates for now, more later; switching venue starts a
new project/timeline on the template's default rig (section 9).
