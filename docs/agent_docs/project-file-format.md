# Project File Format (`.dmxsim`)

**Status:** version 1, implemented in `packages/show-model/src/project.ts`.
**Schema companion:** `project-file.schema.json` (generated).
**Reader/writer:** `parseProject()` / `serializeProject()` in `@dmxsim/show-model`.

A `.dmxsim` file is the portable unit of user work: the fixture rig, the
authored arrangement, the song timeline (beat grid and loop), the audio
reference, and the app settings needed to reproduce a session. It is UTF-8 JSON
and is validated before it reaches app state (ADR-008).

The lighting spike loads `resources/sample_projects/koto-chill/koto-chill.dmxsim` at
startup, so the bundled demo can be edited on disk and opened back with **Open
project**. It sits next to the sample audio it scores. **Save project** writes
the current rig, timeline, clips, and settings back out.

## Goals

- Reproduce a session: same rig, same clips, same loop, same view settings.
- Stay diffable and human-editable so the demo can be iterated on disk.
- Version explicitly and extend without breaking older files.
- Never embed audio; store a reference instead (ADR-003).

## Non-goals (version 1)

- Embedding audio samples or rendered video.
- Referencing fixture profiles by ID only; profiles are embedded snapshots.
- Undo history, autosave state, or in-flight UI selection.
- Cross-version migrations beyond rejecting newer files with a clear error.

## Top-level shape

```json
{
  "format": "dmxsim-project",
  "version": 1,
  "name": "Koto Chill demo",
  "description": "optional free text",
  "show": { "...": "rig" },
  "timeline": { "...": "duration, beat grid, loop" },
  "arrangement": { "clips": [] },
  "settings": { "...": "render, playback, ui" },
  "audio": { "...": "reference only" }
}
```

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Literal `dmxsim-project`. |
| `version` | yes | Integer document version. This spec describes `1`. |
| `name` | yes | Human-readable project name; used for the export filename. |
| `description` | no | Free text. |
| `show` | yes | Fixture rig and (future) show-level tracks. |
| `timeline` | yes | Song length, beat grid, and loop region. |
| `arrangement` | no | Authored clips. Missing means no clips. |
| `settings` | no | Render/playback/UI state. Missing sections use defaults. |
| `audio` | no | Reference to the audio file. Defaults to `external`. |

Unknown fields are ignored (stripped) by version 1 readers. Writers must not
rely on that to transmit data to older readers.

## `show`

```json
{
  "version": 1,
  "name": "Spike — demo rig",
  "fixtures": [
    {
      "id": "mh-front-0",
      "profile": { "...": "full fixture profile snapshot" },
      "position": { "x": -8.1, "y": 7.4, "z": 1.6 },
      "yawDeg": -12,
      "pitchOffsetDeg": 0
    }
  ],
  "tracks": []
}
```

- `fixtures[].profile` is a complete profile snapshot: channel map,
  capabilities, physical limits, and beam data. A file must be evaluable
  without a fixture library lookup.
- `fixtures[].id` is the stable key used by `arrangement.clips[].fixtureId`.
- `position` is in metres; `yawDeg` / `pitchOffsetDeg` are mechanical mounting
  orientation only (animated pan/tilt lives in clips).
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
        "fadeInSec": 0
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
| `action` | `hold`, `fade`, `pulse`, `sweep`, or `strobe`. |
| `colorIndex` | Non-negative integer index into the app palette. Default `0`. |
| `fadeInSec` | Optional non-negative override for the clip's fade-in. |

Cues are evaluated against the loop only when they fall inside the loop
region; clips outside it are authored but cannot play. The demo generator
places every clip on the loop's bar grid.

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
      "lofi": false,
      "strobes": false,
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
- `render.cameraView` is an index into the app's camera presets.
- `ui.dockHeightPx: 0` keeps the stylesheet default dock height.
- `ui.waveformHeightPx` is clamped to `40..200`.
- Render-only fixture preview overrides (test output, aim offsets, spread) are
  intentionally **not** saved.

## `audio`

```json
{ "source": "bundled", "id": "koto-chill", "title": "The Koto Chill", "artist": "zircon", "fileName": "The Koto Chill.ogg" }
```

- `source: "bundled"` resolves to a track shipped with the app; `id` identifies
  it.
- `source: "external"` means the user must provide the file locally. `fileName`
  is a hint for UI and relinking, not a path.
- Audio bytes are never embedded. Moving a project to another machine requires
  the owner to supply the audio file (ADR-003).
- Exporting after loading local audio records `{ source: "external", fileName }`.

## Versioning and compatibility

- `version` is a positive integer. Readers support exactly the versions they
  know plus forward migrations.
- A file with a **newer** version is rejected with a clear error; it is never
  partially loaded.
- A file with a **different `format`** is rejected.
- Migration runs before validation (`migrateProject()`), so old shapes are
  upgraded to the current schema and then checked once.
- Additive fields must be optional or defaulted. Removing/renaming a field
  requires a version bump and a migration.
- Readers ignore unknown fields; writers emit only known fields.
- Changing the meaning of an existing field without renaming it is forbidden.

### Adding a field (checklist)

1. Add it to `project.ts` as optional or with `.default()` / `.prefault()`.
2. Add a test covering the default and a round-trip.
3. Update this document and regenerate `project-file.schema.json`.
4. If the field is required for correct playback, bump `version` and migrate.

## Validation

`parseProject()` performs structural validation plus cross-field checks:

- `format` is `dmxsim-project`
- `version` is supported and not newer than the reader
- fixture IDs are unique
- clip IDs are unique
- every `arrangement.clips[].fixtureId` refers to a declared fixture
- clip `endSec > startSec`
- loop `endSec > startSec`
- loop `endSec <= durationSec`

Issues surface as `ProjectFileError` with the failing path (for example
`Invalid project file at \`timeline.loop.endSec\`: ...`). The UI reports the
message without mutating the current show.

## Demo project workflow

```
resources/sample_projects/koto-chill/
  The Koto Chill.ogg     # audio the demo scores
  koto-chill.dmxsim      # loaded at startup
npm run project:generate # rebuilds the .dmxsim from demo-arrangement.ts
```

- Edit `koto-chill.dmxsim` directly to iterate on the demo: move/resize clips,
  change the loop, change settings, then reload the page.
- **Save project** exports the current state (for example after editing a clip
  in the app) to a new `.dmxsim` file; replace the bundled file with it if that
  should become the new default.
- `npm run project:generate` is a reset: it overwrites the bundled file from
  the procedural demo and also regenerates the JSON Schema companion.
- The spike's rig is fixed at startup. Opening a project whose fixture IDs do
  not match the loaded rig is rejected rather than partially applied.

## Minimal example

```json
{
  "format": "dmxsim-project",
  "version": 1,
  "name": "My song",
  "show": {
    "version": 1,
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
