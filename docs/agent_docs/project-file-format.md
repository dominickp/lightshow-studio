# Project File Format (`.dmxsim`)

**Status:** version 4, implemented in `packages/show-model/src/project.ts` and
`packages/show-model/src/bundle.ts`.
**Schema companion:** `project-file.schema.json` (generated, describes
`project.json`).
**Reader/writer:** `parseProject()` / `readProjectBundle()` /
`writeProjectBundle()` in `@dmxsim/show-model`.

A `.dmxsim` file is the portable unit of user work: the venue, the fixture rig,
the authored arrangement, the song timeline (beat grid and loop), the audio,
the LED wall media, and the app settings needed to reproduce a session.

Since version 4 the file is a **ZIP bundle**, not a bare JSON document. It
holds `project.json` plus a content-addressed `media/` directory, so a show can
be shared as one attachment including its song and wall images/videos. The JSON
document is validated with Zod before it reaches app state (ADR-008).

Because a project names its venue and embeds full fixture profiles, opening a
file on another machine reproduces the stage without a profile lookup and
without a rig-equality check (ADR-011). Venue *geometry* still ships with the
app (see below).

The lighting spike loads `resources/sample_projects/koto-chill/koto-chill.dmxsim`
at startup. That file is a bundle; replacing it with a bundle saved from the app
is how the demo arrangement is published. **Open project** and **Save project**
read and write the same container.

## Container

```
koto-chill.dmxsim            # ZIP archive
  project.json               # the version 4 document (below)
  media/<sha256>.<ext>       # audio, wall images and videos
```

- `project.json` is the human-editable document; `unzip -p show.dmxsim
  project.json` prints it.
- Media is **content-addressed** by lowercase SHA-256. Two clips that use the
  same file store it once, and the same source re-saved produces identical
  bytes. Entry names come from the manifest's MIME type or original extension.
- The manifest (`media` in `project.json`) lists every file the document
  references. Writers prune it, so deleting a clip removes its bytes from the
  next save.
- Readers validate the envelope, limit entry counts and sizes (512 MB total),
  reject absolute paths and `..` segments, and never extract to disk.
- A manifest entry with no matching archive file is a **warning, not an error**:
  the project still opens, the affected look falls back to black, and the UI
  reports how many files were missing. Opening never mutates the file.

## Goals

- Reproduce a session: same rig, same clips, same loop, same audio, same view
  settings, in one shareable file.
- Keep `project.json` diffable and human-editable, even though the container is
  binary.
- Version explicitly and reject mismatched versions with a clear message.

## Non-goals (version 4)

- Backward compatibility. This spike is a demo: only the current version is
  read, and the bundled demo is regenerated for each format change.
- Referencing fixture profiles by ID only; profiles are embedded snapshots.
- Storing venue geometry. The file names a venue template; the template's
  structure, anchors, and camera presets ship with the app.
- Renderer-side transcoding. Media is stored as imported, so a future video
  export can reuse the originals.
- Undo history, autosave state, or in-flight UI selection.

## Top-level shape

```json
{
  "format": "dmxsim-project",
  "version": 4,
  "name": "Koto Chill demo",
  "description": "optional free text",
  "venue": { "id": "club-stage", "name": "Club Stage" },
  "show": { "...": "rig" },
  "timeline": { "...": "duration, beat grid, loop" },
  "arrangement": { "clips": [], "surfaces": [], "surfaceClips": [] },
  "settings": { "...": "render, playback, ui" },
  "audio": { "...": "embedded track" },
  "media": [{ "sha256": "...", "kind": "audio", "mime": "audio/ogg", "bytes": 2827348 }]
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Literal `dmxsim-project`. |
| `version` | yes | Integer document version. This spec describes `4`. |
| `name` | yes | Human-readable project name; used for the export filename. |
| `description` | no | Free text. |
| `venue` | yes | Venue template id and display name. |
| `show` | yes | Fixture rig and (future) show-level tracks. |
| `timeline` | yes | Song length, beat grid, and loop region. |
| `arrangement` | no | Authored fixture and wall clips. |
| `settings` | no | Render/playback/UI state. Missing sections use defaults. |
| `audio` | no | The song. Defaults to `external` (no usable audio). |
| `media` | no | Manifest of files in `media/`. Defaults to empty. |

Unknown fields are ignored (stripped) by readers.

## `media`

```json
{ "sha256": "b97d…", "kind": "audio", "mime": "audio/ogg", "bytes": 2827348, "fileName": "The Koto Chill.ogg" }
```

| Field | Rules |
|---|---|
| `sha256` | Lowercase 64-character digest of the stored bytes. Unique in the file. |
| `kind` | `audio`, `image`, or `video`. |
| `mime` | MIME type detected on import. |
| `bytes` | Exact byte length, for progress and sanity checks. |
| `fileName` | Optional display/relink hint. Never a path. |

References use the digest, not the file name:

- audio: `audio.sha256`
- wall media: `look.media.source = "embedded:<sha256>"`

`bundled:<id>` still refers to a clip shipped inside the app (the Mantissa
loops) and is not copied into bundles; `local:<uuid>` is a transient reference
to a file in the browser's media library, and Save rewrites it to `embedded:`.


## `venue`

```json
{ "id": "club-stage", "name": "Club Stage" }
```

- `id` selects the venue template that ships with the app. Known ids currently
  include `club-stage`; more templates are additive.
- `name` is a display name copied at save time so a file stays readable even if
  the template is renamed.
- Venue geometry, mount anchors, camera presets, and the template's ready-made
  rig live in `packages/show-model/src/venue.ts`, not in the file.
- A reader that does not know the id must fail clearly rather than substitute a
  different stage: fixtures would float in the wrong room.
- Opening a project is not a venue *switch*. It rebuilds the venue named in the
  file, so authored clips are never discarded.

## `show`

```json
{
  "version": 2,
  "name": "Spike — demo rig",
  "fixtures": [
    {
      "id": "mh-front-0",
      "name": "Front truss 1",
      "profile": { "...": "full fixture profile snapshot" },
      "position": { "x": -8.1, "y": 7.4, "z": 1.6 },
      "yawDeg": -12,
      "pitchOffsetDeg": 0,
      "mount": { "anchorId": "truss-front", "u": 0.114, "offset": { "x": 0, "y": -0.6, "z": 0 } }
    }
  ],
  "tracks": []
}
```

- `fixtures[].profile` is a complete profile snapshot: channel map,
  capabilities, physical limits, and beam data. A file must be evaluable
  without a fixture library lookup.
- `fixtures[].id` is the stable key used by `arrangement.clips[].fixtureId`.
- `fixtures[].name` is an optional lane label. The UI falls back to a generated
  name when it is omitted.
- `position` is in metres; `yawDeg` / `pitchOffsetDeg` are mechanical mounting
  orientation only (animated pan/tilt lives in clips).
- `fixtures[].mount` records which venue structure the fixture hangs from
  (ADR-011):

  | Field | Rules |
  |---|---|
  | `anchorId` | Non-empty. Must exist in the named venue template to resolve. |
  | `u` | `0..1`, the position along the anchor segment. |
  | `offset` | Optional world-space metres applied after the anchor point. |
  | `yawDeg` | Optional override of the anchor's derived yaw. |
  | `mountPitchDeg` | Optional override of the anchor's default mount pitch (`0` hangs down, `90` points along the anchor normal, `168` is a floor uplight). |

  The mount wins on load when the anchor exists. `position`/`yawDeg`/
  `pitchOffsetDeg` are a cached resolution and the fallback when a file
  references an anchor the app no longer has, so a fixture is never dropped
  silently.
- `fixtures[].laser` is laser-only setup (ADR-012). Patterns are not
  clip-animatable; `rotation` and pan/tilt move them through normal clips.

  ```json
  { "beams": 12, "pattern": "fan", "fanDeg": 55, "divergenceDeg": 1.2, "speedHz": 0.4, "phaseDeg": 90 }
  ```

  Values clamp to the profile's optional `laser` limits (`maxBeams`,
  `fanDeg`, `patterns`) at evaluation time.
- `fixtures[].defaults` holds optional normalized (`0..1`) setup values — the
  fixture's home look when no clip asserts the attribute. Omitted attributes
  use the profile's built-in defaults. Values are the same normalized units as
  clip keyframes, so a future editor can copy one to the other.
- `tracks` is reserved for envelope-based `Track`/`Clip` data from
  `show-model`. The spike authors `arrangement.clips` instead and emits an
  empty array. Both may coexist during a transition.

> **Timing note.** `show` deliberately has no `beatGrid`. The editable grid
> belongs to `timeline`, because tempo/offset are analysis results that the
> user corrects independently of the rig, and an imported track may have
> `bpm: null`.

## `timeline`

```json
{
  "durationSec": 123.924898,
  "beatGrid": { "bpm": 130, "offsetSec": 0.02, "beatsPerBar": 4 },
  "loop": { "startSec": 73.866, "endSec": 103.405 }
}
```

| Field | Rules |
|---|---|
| `durationSec` | Positive; should match the referenced audio duration. |
| `beatGrid.bpm` | Positive number, or `null` when no tempo is known. Default `null`. |
| `beatGrid.offsetSec` | Seconds to the first downbeat. Default `0`. |
| `beatGrid.beatsPerBar` | Positive integer. Default `4`. |
| `loop.startSec` | Non-negative. |
| `loop.endSec` | Positive and strictly greater than `startSec`; must not exceed `durationSec`. |

## `arrangement.clips`

This is the spike's authored arrangement: one clip per fixture lane, coarse
preset action plus a palette colour.

```json
{
  "arrangement": {
    "clips": [
      {
        "id": "clip-1",
        "fixtureId": "mh-front-0",
        "startSec": 73.866,
        "endSec": 75.712,
        "action": "sweep",
        "colorIndex": 3,
        "fadeInSec": 0,
        "fadeOutSec": 0.08
      }
    ]
  }
}
```

| Field | Rules |
|---|---|
| `id` | Non-empty, unique within the file. |
| `fixtureId` | Must match a `show.fixtures[].id`. Readers may drop unknown lanes. |
| `startSec` | Non-negative. |
| `endSec` | Positive, strictly greater than `startSec`. |
| `action` | `hold`, `fade`, `pulse`, `sweep`, `strobe`, or `fire`. |
| `colorIndex` | Non-negative integer index into the app palette. Default `0`. |
| `fadeInSec` | Optional non-negative override for the clip's fade-in. |
| `fadeOutSec` | Optional non-negative override for the clip's fade-out. |
| `strobe` | Optional pulse shaping for `strobe` clips; see below. |
| `pulseHz` | Optional pulse speed for `pulse` clips. Without it the legacy four-pulse shape is used. |
| `sweep` | Optional movement shaping for `sweep` clips; see below. |

Fades are independent of clip length: a long clip can still snap on over
40 ms, and a short strobe hit can fade out over several beats.

### Strobe shaping

`strobe` clips keep the strobe channel value as their rate, with an optional
override and a per-flash envelope:

```json
{
  "action": "strobe",
  "strobe": { "hz": 12, "attack": 0.05, "release": 0.18, "depth": 0 }
}
```

| Field | Rules |
|---|---|
| `hz` | Optional rate in Hz. Clamped to the profile's `limits.strobeHz`. Overrides the normalized `strobe` channel value. |
| `attack` | Fraction of one cycle spent ramping up from `depth` to full, `0..1`. |
| `release` | Fraction of one cycle spent ramping down to `depth`. |
| `depth` | Level held between flashes, `0..1`; `0` is a full blackout. |

The lamp is lit for the first half of each cycle. The evaluator resolves this
into `FixtureState.strobeLevel`, so playback, scrubbing and offline export all
show the same flash. Shorter ramps read as a hard strobe; longer ones read as
a pulsing dimmer.

### Sweep shaping

`sweep` clips move pan and tilt along one cycling wave. The rate is stored in
Hz instead of being implied by the clip length, and `phase` lets grouped heads
stay deliberately out of step:

```json
{
  "action": "sweep",
  "sweep": {
    "hz": 0.4,
    "phase": 0.25,
    "panCenter": 0.5,
    "panRange": 0.35,
    "tiltCenter": 0.54,
    "tiltRange": 0.12
  }
}
```

| Field | Rules |
|---|---|
| `hz` | Optional cycles per second. Omitted keeps the legacy one cycle across the clip, so a clip's look still depends on its length. |
| `phase` | Starting point in the cycle, `0..1`. `0` puts every clip at the same angle; `0.5` mirrors a pair. |
| `panCenter`, `tiltCenter` | Normalized centres, `0..1`, mapped through the profile's limits. Defaults: pan `0.5`, tilt `0.54`. |
| `panRange`, `tiltRange` | Normalized half-swings, `0..1`. Defaults: pan `0.35`, tilt `0.12`. |

The wave is sampled from song time, not baked into keyframes, so two clips with
the same `hz` and different `phase` never drift apart and a clip resized on the
timeline does not change the movement speed. `sweep` replaces any authored
`attributes.pan`/`attributes.tilt` envelope. A sweep without a `sweep` object
falls back to the original hand-written keyframes.

Cues are evaluated against the loop only when they fall inside the loop
region; clips outside it are authored but cannot play. The demo generator
places every clip on the loop's bar grid.

## `arrangement.surfaces` and `arrangement.surfaceClips`

Version 3 adds venue surfaces that have their own timeline content. The first
surface is the LED wall: it remains part of the venue when no clip is active,
showing its dark, unlit panel. A surface clip turns on a procedural look for a
time range; adjacent clips crossfade. Surfaces are not fixtures and do not
participate in DMX fixture evaluation.

```json
{
  "arrangement": {
    "surfaces": [{
      "id": "led-main", "name": "LED Wall",
      "widthM": 13.5, "heightM": 6.2, "y": 4.9, "z": -11.85,
      "pitchMm": 10, "gap": 0.25, "brightness": 1,
      "blackLevel": 0.015, "gamma": 2.2, "emit": 0.35
    }],
    "surfaceClips": [{
      "id": "led-clip-1", "surfaceId": "led-main",
      "startSec": 73.866, "endSec": 77.558, "opacity": 1,
      "look": {
        "kind": "gradient", "colors": ["#1b0b4d", "#ff2d95"],
        "speed": 0.15, "scale": 1, "angleDeg": 20,
        "softness": 0.5, "intensity": 1, "seed": 7, "sync": "beat"
      }
    }]
  }
}
```

- `surfaces` stores physical placement and display calibration. An empty list
  means use the wall declared by the venue template.
- `surfaceClips[].look.kind` is one of `solid`, `gradient`, `wave`, `radial`,
  `noise`, `grid`, `scan`, `media`, or `blackout`. Older v3 `dots` values load as
  scan bars.
- `colors` contains 1–4 `#rrggbb` stops; `speed`, `scale`, `angleDeg`,
  `softness`, `intensity`, `seed`, and `sync` parameterize the generator.
- A `media` look carries a `media` reference instead of a generator:

  ```json
  "media": { "source": "bundled:003", "kind": "video", "fit": "cover", "label": "Mantissa 003" }
  ```

  `source` is namespaced:

  - `bundled:<id>` resolves to a clip shipped with the app (the Mantissa loops)
    and is not copied into bundles.
  - `local:<uuid>` is a transient reference to a file in the browser's media
    library (IndexedDB). It only exists on the machine that imported it, and
    **Save rewrites it to `embedded:<sha256>`**.
  - `embedded:<sha256>` points at a file in the bundle's `media/` directory and
    requires a matching manifest entry. Opening a bundle registers these files
    with the media library, so an opened show stays editable.

  `fit` is `cover` (crop) or `contain` (letterbox).
- `pitchMm` is the physical pixel pitch. The renderer uses a capped, uniformly
  scaled LED matrix so individual diodes remain legible at viewport resolution.
- A surface clip must reference a declared surface when the project declares
  any surfaces. Clip ids are unique across fixture and surface clips.

### Relationship to `show.tracks[].clips`

The long-term model (ADR-005) is a `Clip` with per-attribute keyframes. The
spike's `arrangement.clips` is a compact authoring preset that maps to that
model at evaluation time. A future version will either:

1. extend `arrangement.clips` with optional envelope data, or
2. migrate them into `show.tracks[].clips` and keep `arrangement` for UI state.

Both are additive, so version 1 files remain loadable.

## `settings`

Every field is optional and has a default, so a minimal file can omit the whole
section.

```json
{
  "settings": {
    "render": {
      "volumetrics": true,
      "bloom": true,
      "shadows": true,
      "strobes": true,
      "activeFixtureCount": 32,
      "cameraView": 0
    },
    "playback": {
      "volume": 1,
      "muted": false,
      "loopEnabled": true,
      "followPlayhead": true,
      "zoomPixelsPerSecond": 48
    },
    "ui": {
      "statsVisible": true,
      "dockCollapsed": false,
      "dockHeightPx": 0,
      "waveformHeightPx": 62
    }
  }
}
```

- `render.activeFixtureCount: 0` means "use the whole rig".
- `render.strobes` defaults to `true`.
- `render.lofi` is accepted for older files but ignored; the grade was removed.
- `render.cameraView` is an index into the app's camera presets.
- `ui.dockHeightPx: 0` keeps the stylesheet default dock height.
- `ui.waveformHeightPx` is clamped to `40..200`.
- Fixture setup (mount yaw/pitch and `show.fixtures[].defaults`) **is** saved;
  clips override those values only while they are active.

## `audio`

```json
{ "source": "embedded", "sha256": "b97d…", "title": "The Koto Chill", "artist": "zircon", "fileName": "The Koto Chill.ogg" }
```

- `source: "embedded"` means the song is in the bundle; `sha256` must appear in
  the `media` manifest. Opening the file loads and decodes its own track.
- `source: "bundled"` resolves to a track shipped with the app; `id` identifies
  it. Used only as a fallback when no project supplies audio.
- `source: "external"` means no usable audio is stored. `fileName` is a hint
  for UI and relinking, not a path.
- `title` / `artist` are display metadata; they never affect playback.
- Save embeds whichever track is currently loaded, so bundling a local upload
  requires no extra step. The demo bundle therefore carries its own `.ogg`.

## Versioning and compatibility

- `version` is a positive integer and must equal the reader's version. There
  are no migrations: this is a demo, and only the bundled demo project is
  regenerated on a format change.
- A file with a **newer** or **older** version is rejected with a clear error;
  it is never partially loaded.
- A file whose first bytes are not a ZIP, or that has no `project.json`, is
  rejected as "not a valid .dmxsim bundle".
- Additive fields must be optional or defaulted. Removing or renaming a field
  requires a version bump and a regenerated demo.
- Readers ignore unknown fields; writers emit only known fields.
- Changing the meaning of an existing field without renaming it is forbidden.

### Adding a field (checklist)

1. Add it to `project.ts` as optional or with `.default()` / `.prefault()`.
2. Add a test covering the default and a round-trip.
3. Update this document and regenerate `project-file.schema.json`.
4. If the field changes playback or the container, bump `version` and
   regenerate the bundled demo.

## Validation

`parseProject()` performs envelope checks plus structural validation:

- `format` is `dmxsim-project`
- `version` equals the reader's version
- `venue.id` is present
- fixture IDs are unique
- `fixtures[].mount.u` is within `0..1`
- laser `beams` is a positive integer and `pattern` is a known pattern
- clip IDs are unique (fixture and surface clips share the namespace)
- every `arrangement.clips[].fixtureId` refers to a declared fixture
- clip `endSec > startSec`
- loop `endSec > startSec`
- loop `endSec <= durationSec`
- media digests are unique
- embedded audio and every `embedded:` look ref appear in the `media` manifest

Issues surface as `ProjectFileError` with the failing path (for example
`Invalid project file at \`timeline.loop.endSec\`: ...`). The UI reports the
message without mutating the current show.

`readProjectBundle()` adds container checks on top: ZIP readability, entry
names (no absolute paths or `..`), entry count, total size, and the presence of
`project.json`. Manifest entries with no bytes are returned as `warnings` so the
project can still open.

## Demo project workflow

```
resources/sample_projects/koto-chill/
  The Koto Chill.ogg     # source audio, kept so the bundle can be rebuilt
  koto-chill.dmxsim      # ZIP bundle loaded at startup
npm run project:generate # rebuilds the bundle from demo-arrangement.ts
```

- **Recommended loop:** edit the show in the app and press **Save project**.
  The download is already a complete bundle (document + audio + wall media),
  so replacing `koto-chill.dmxsim` with it updates the demo.
- To inspect a bundle: `unzip -p koto-chill.dmxsim project.json`. To change the
  JSON by hand, unpack into a scratch directory, edit, and re-zip with
  `project.json` at the root and media under `media/`.
- `npm run project:generate` is a reset: it rebuilds the arrangement from the
  procedural demo, embeds the `.ogg`, and regenerates the JSON Schema
  companion. It overwrites any hand edits in the bundle.
- `resources/sample_projects/koto-chill/The Koto Chill.ogg` is the source of
  truth for the audio; it is not loaded by the app any more (the bundle is),
  but the generator needs it.

The spike's rig is authored in the app (or loaded from a project) and saved
with the file; opening a project whose venue or fixture IDs differ from the
running build replaces the rig rather than rejecting the file. See
`stage-rig-editor-plan.md`.

## Minimal example

```json
{
  "format": "dmxsim-project",
  "version": 4,
  "name": "My song",
  "venue": { "id": "club-stage", "name": "Club Stage" },
  "show": {
    "version": 2,
    "name": "One PAR",
    "fixtures": [
      {
        "id": "par-0",
        "profile": {
          "id": "generic-par",
          "name": "Generic PAR",
          "kind": "par",
          "channels": ["dimmer", "red", "green", "blue"],
          "capabilities": {
            "dimmer": true,
            "color": "rgb",
            "panTilt": false,
            "zoom": false,
            "focus": false,
            "strobe": false,
            "gobo": false,
            "prism": false,
            "rotation": false
          },
          "limits": { "panDeg": [0, 0], "tiltDeg": [0, 0], "strobeHz": [1, 20] },
          "beam": {
            "spreadDeg": [10, 40],
            "apertureDiameterM": 0.15,
            "throwM": 8
          }
        },
        "position": { "x": 0, "y": 3, "z": 0 },
        "yawDeg": 0
      }
    ]
  },
  "timeline": {
    "durationSec": 180,
    "beatGrid": { "bpm": 128, "offsetSec": 0, "beatsPerBar": 4 },
    "loop": { "startSec": 60, "endSec": 90 }
  },
  "arrangement": {
    "clips": [
      {
        "id": "clip-1",
        "fixtureId": "par-0",
        "startSec": 60,
        "endSec": 75,
        "action": "fade",
        "colorIndex": 4
      }
    ]
  }
}
```
