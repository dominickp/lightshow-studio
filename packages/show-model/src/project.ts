import { z } from 'zod';
import { LED_LOOK_KINDS, LED_MEDIA_FITS, LED_MEDIA_KINDS, LED_SYNCS } from './led';

/**
 * Project-file schema (`.dmxsim`).
 *
 * A project is the portable unit of user work: the rig, the arrangement, the
 * song timeline (beat grid and loop), and the app settings needed to reproduce
 * a session. The document is JSON and is validated with Zod before it reaches
 * app state. See `docs/agent_docs/project-file-format.md` for the prose spec.
 *
 * Since version 4 a `.dmxsim` is a ZIP bundle: this document is stored as
 * `project.json` next to a `media/` directory that holds the audio and LED wall
 * files it references. See `bundle.ts`.
 *
 * The timeline owns the beat grid instead of `show.beatGrid` because the grid
 * is editable independently of the rig (ADR-003), and an imported audio file
 * may legitimately have no detected tempo (`bpm: null`).
 */

export const PROJECT_FORMAT = 'dmxsim-project';
export const PROJECT_VERSION = 4;

/** Lowercase SHA-256 hex; media is content-addressed in the bundle. */
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase SHA-256 digest');

export const CUE_ACTIONS = ['hold', 'aim', 'fade', 'pulse', 'sweep', 'strobe', 'fire'] as const;
export type ProjectCueAction = (typeof CUE_ACTIONS)[number];

const FIXTURE_KINDS = [
  'moving-head',
  'wash',
  'strobe',
  'laser',
  'par',
  'blinder',
  'led-strip',
  'cryo-jet',
] as const;

const FIXTURE_ATTRIBUTES = [
  'dimmer',
  'red',
  'green',
  'blue',
  'white',
  'pan',
  'panFine',
  'tilt',
  'tiltFine',
  'zoom',
  'focus',
  'strobe',
  'gobo',
  'prism',
  'rotation',
] as const;

const CONTROLLABLE_ATTRIBUTES = [
  'dimmer',
  'red',
  'green',
  'blue',
  'white',
  'pan',
  'tilt',
  'zoom',
  'focus',
  'strobe',
  'rotation',
] as const;

const EASINGS = ['linear', 'sine', 'easeInOut', 'step'] as const;

const LASER_PATTERNS = ['fan', 'sweep', 'tunnel', 'wave', 'lattice', 'dots'] as const;

const rangeSchema = z.tuple([z.number(), z.number()]);

export const fixtureProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(FIXTURE_KINDS),
  manufacturer: z.string().optional(),
  channels: z.array(z.union([z.enum(FIXTURE_ATTRIBUTES), z.null()])),
  capabilities: z.object({
    dimmer: z.boolean(),
    color: z.union([z.literal(false), z.enum(['rgb', 'rgbw'])]),
    panTilt: z.boolean(),
    zoom: z.boolean(),
    focus: z.boolean(),
    strobe: z.boolean(),
    gobo: z.boolean(),
    prism: z.boolean(),
    rotation: z.boolean(),
  }),
  limits: z.object({
    panDeg: rangeSchema,
    tiltDeg: rangeSchema,
    strobeHz: rangeSchema,
  }),
  beam: z.object({
    spreadDeg: rangeSchema,
    apertureDiameterM: z.number().nonnegative(),
    throwM: z.number().positive(),
  }),
  /** Laser-only capabilities. Optional so older snapshots stay valid. */
  laser: z
    .object({
      maxBeams: z.number().int().positive(),
      patterns: z.array(z.enum(LASER_PATTERNS)).min(1),
      fanDeg: rangeSchema,
    })
    .optional(),
});

const normalizedSchema = z.number().min(0).max(1);

/** Setup-layer values; only attributes the fixture can actually drive. */
export const fixtureDefaultsSchema = z.object({
  dimmer: normalizedSchema.optional(),
  red: normalizedSchema.optional(),
  green: normalizedSchema.optional(),
  blue: normalizedSchema.optional(),
  white: normalizedSchema.optional(),
  pan: normalizedSchema.optional(),
  tilt: normalizedSchema.optional(),
  zoom: normalizedSchema.optional(),
  focus: normalizedSchema.optional(),
  strobe: normalizedSchema.optional(),
  rotation: normalizedSchema.optional(),
});

export const fixtureMountSchema = z.object({
  anchorId: z.string().min(1),
  u: z.number().min(0).max(1),
  offset: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
  yawDeg: z.number().optional(),
  mountPitchDeg: z.number().optional(),
});

export const laserSetupSchema = z.object({
  beams: z.number().int().positive(),
  pattern: z.enum(LASER_PATTERNS),
  fanDeg: z.number().nonnegative(),
  divergenceDeg: z.number().nonnegative(),
  speedHz: z.number().nonnegative(),
  phaseDeg: z.number(),
});

export const fixturePlacementSchema = z.object({
  id: z.string().min(1),
  /** Friendly lane label; the UI falls back to a generated name. */
  name: z.string().min(1).optional(),
  profile: fixtureProfileSchema,
  position: z.object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  }),
  yawDeg: z.number(),
  pitchOffsetDeg: z.number().optional(),
  /** Venue structure this fixture hangs from (ADR-011). */
  mount: fixtureMountSchema.optional(),
  /** Laser beam setup (ADR-012). */
  laser: laserSetupSchema.optional(),
  /** Values held when no clip is active (ADR-010). */
  defaults: fixtureDefaultsSchema.optional(),
});

export const keyframeSchema = z.object({
  at: z.number().min(0).max(1),
  value: z.number(),
});

/** Per-pulse shaping for a strobing clip. Fractions are of one cycle. */
export const strobeSettingsSchema = z.object({
  /** Explicit pulse rate in Hz; overrides the strobe channel value. */
  hz: z.number().nonnegative().optional(),
  /** Share of the cycle spent ramping up. */
  attack: normalizedSchema.optional(),
  /** Share of the cycle spent ramping down. */
  release: normalizedSchema.optional(),
  /** Level between flashes, 0..1. */
  depth: normalizedSchema.optional(),
});

/** Pan/tilt aim for a clip, with an optional single travel to an end pose. */
export const aimSettingsSchema = z.object({
  pan: normalizedSchema,
  tilt: normalizedSchema,
  /** End pose. Omitted fields keep their start value. */
  toPan: normalizedSchema.optional(),
  toTilt: normalizedSchema.optional(),
  /** Travel duration in seconds; omitted stretches it across the clip. */
  travelSec: z.number().nonnegative().optional(),
  easing: z.enum(EASINGS).optional(),
});

/** Pan/tilt movement shaping for a sweep clip. Centres and ranges are normalized. */
export const sweepSettingsSchema = z.object({
  /** Movement cycles per second. Omitted keeps one cycle across the clip. */
  hz: z.number().nonnegative().optional(),
  /** Starting point in the cycle, 0..1. Offsets grouped heads. */
  phase: normalizedSchema.optional(),
  panCenter: normalizedSchema.optional(),
  panRange: normalizedSchema.optional(),
  tiltCenter: normalizedSchema.optional(),
  tiltRange: normalizedSchema.optional(),
});

export const clipSchema = z.object({
  id: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  attributes: z.partialRecord(z.enum(CONTROLLABLE_ATTRIBUTES), z.array(keyframeSchema)),
  fadeInSec: z.number().nonnegative().optional(),
  fadeOutSec: z.number().nonnegative().optional(),
  easing: z.enum(EASINGS).optional(),
  strobe: strobeSettingsSchema.optional(),
  pulseHz: z.number().nonnegative().optional(),
  aim: aimSettingsSchema.optional(),
  sweep: sweepSettingsSchema.optional(),
});

export const trackSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  fixtureIds: z.array(z.string().min(1)),
  clips: z.array(clipSchema),
});

/** Authored arrangement clip: the spike's coarse preset representation. */
export const projectClipSchema = z
  .object({
    id: z.string().min(1),
    fixtureId: z.string().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    action: z.enum(CUE_ACTIONS),
    colorIndex: z.number().int().nonnegative().default(0),
    /**
     * Custom colour authored in the clip inspector. Absent means the clip uses
     * the palette entry at `colorIndex`.
     */
    colorOverride: z
      .union([
        z.object({
          kind: z.literal('rgb'),
          r: z.number().min(0).max(1),
          g: z.number().min(0).max(1),
          b: z.number().min(0).max(1),
        }),
        z.object({
          kind: z.literal('white'),
          /** Colour temperature in kelvin. */
          cct: z.number().min(1000).max(20000),
        }),
      ])
      .optional(),
    /** Overrides the default fade-in when the clip starts (seconds). */
    fadeInSec: z.number().nonnegative().optional(),
    /** Overrides the default fade-out when the clip ends (seconds). */
    fadeOutSec: z.number().nonnegative().optional(),
    /** Pulse shape for `strobe` clips. */
    strobe: strobeSettingsSchema.optional(),
    /** Pulse speed for `pulse` clips, in Hz. */
    pulseHz: z.number().nonnegative().optional(),
    /** Fixed pan/tilt aim for `aim` clips. */
    aim: aimSettingsSchema.optional(),
    /** Movement shaping for `sweep` clips. */
    sweep: sweepSettingsSchema.optional(),
  })
  .refine((clip) => clip.endSec > clip.startSec, {
    message: 'endSec must be greater than startSec',
    path: ['endSec'],
  });

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #rrggbb');

/**
 * A wall media reference. The bytes are not stored in the project file:
 * `bundled:` sources ship with the app and `local:` sources live in the
 * user's IndexedDB library on this machine.
 */
export const ledMediaSchema = z.object({
  source: z.string().min(1),
  kind: z.enum(LED_MEDIA_KINDS),
  fit: z.enum(LED_MEDIA_FITS).default('cover'),
  label: z.string().min(1).optional(),
});

/** One procedural or media look instance on a wall. */
export const ledLookSchema = z.object({
  kind: z.enum(LED_LOOK_KINDS),
  colors: z.array(hexColorSchema).min(1).max(4),
  speed: z.number().nonnegative(),
  scale: z.number().positive(),
  angleDeg: z.number(),
  softness: z.number().min(0).max(1),
  intensity: z.number().min(0).max(1),
  seed: z.number(),
  sync: z.enum(LED_SYNCS).default('none'),
  media: ledMediaSchema.optional(),
});

/** Physical and calibration properties of a wall (not per-clip). */
export const ledSurfaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  widthM: z.number().positive(),
  heightM: z.number().positive(),
  y: z.number(),
  z: z.number(),
  /** LED pitch in millimetres. */
  pitchMm: z.number().positive(),
  /** Dark gap share of each pixel cell. */
  gap: z.number().min(0).max(1),
  brightness: z.number().nonnegative(),
  blackLevel: z.number().min(0).max(1),
  gamma: z.number().min(0.5).max(4),
  emit: z.number().min(0).max(1),
});

/** A look playing on a wall. Kept apart from fixture clips so neither path
 * has to branch on the other's fields. */
export const ledSurfaceClipSchema = z
  .object({
    id: z.string().min(1),
    surfaceId: z.string().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    look: ledLookSchema,
    opacity: z.number().min(0).max(1).default(1),
    fadeInSec: z.number().nonnegative().optional(),
    fadeOutSec: z.number().nonnegative().optional(),
  })
  .refine((clip) => clip.endSec > clip.startSec, {
    message: 'endSec must be greater than startSec',
    path: ['endSec'],
  });

export const projectTimelineSchema = z
  .object({
    durationSec: z.number().positive(),
    /** Timing grid. `bpm` is null until a track has a beat grid. */
    beatGrid: z
      .object({
        bpm: z.number().positive().nullable().default(null),
        offsetSec: z.number().default(0),
        beatsPerBar: z.number().int().positive().default(4),
      })
      .prefault({}),
    loop: z.object({
      startSec: z.number().nonnegative(),
      endSec: z.number().positive(),
    }),
  })
  .refine((timeline) => timeline.loop.endSec > timeline.loop.startSec, {
    message: 'loop.endSec must be greater than loop.startSec',
    path: ['loop', 'endSec'],
  })
  .refine((timeline) => timeline.loop.endSec <= timeline.durationSec, {
    message: 'loop.endSec must not exceed durationSec',
    path: ['loop', 'endSec'],
  });

export const projectSettingsSchema = z
  .object({
    render: z
      .object({
        volumetrics: z.boolean().default(true),
        bloom: z.boolean().default(true),
        shadows: z.boolean().default(true),
        /** Deprecated: accepted for older files, but the grade was removed. */
        lofi: z.boolean().optional(),
        strobes: z.boolean().default(true),
        /** Number of rig fixtures rendered. 0 means "use the whole rig". */
        activeFixtureCount: z.number().int().nonnegative().default(0),
        cameraView: z.number().int().nonnegative().default(0),
      })
      .prefault({}),
    playback: z
      .object({
        volume: z.number().min(0).max(1).default(1),
        muted: z.boolean().default(false),
        loopEnabled: z.boolean().default(true),
        followPlayhead: z.boolean().default(true),
        zoomPixelsPerSecond: z.number().positive().default(48),
      })
      .prefault({}),
    ui: z
      .object({
        statsVisible: z.boolean().default(true),
        dockCollapsed: z.boolean().default(false),
        /** 0 keeps the stylesheet's default dock height. */
        dockHeightPx: z.number().nonnegative().default(0),
        waveformHeightPx: z.number().min(40).max(200).default(62),
      })
      .prefault({}),
  })
  .prefault({});

/**
 * One file carried in the bundle's `media/` directory.
 *
 * Entries are content-addressed: the file is stored as `media/<sha256><ext>`
 * and everything else (audio, LED wall looks) points at the digest, so the
 * same bytes are never stored twice. The manifest stays in `project.json` so a
 * reader can tell what the bundle should contain before opening it.
 */
export const PROJECT_MEDIA_KINDS = ['audio', 'image', 'video'] as const;
export type ProjectMediaKind = (typeof PROJECT_MEDIA_KINDS)[number];

export const projectMediaSchema = z.object({
  sha256: sha256Schema,
  kind: z.enum(PROJECT_MEDIA_KINDS),
  /** MIME type as detected on import; the bundle stores originals untranscoded. */
  mime: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  /** Display/relink hint only, never a path. */
  fileName: z.string().min(1).optional(),
});

export const projectAudioSchema = z
  .object({
    /**
     * `embedded` audio ships in the bundle; `bundled` resolves to a track
     * shipped with the app; `external` means no usable audio is stored.
     */
    source: z.enum(['embedded', 'bundled', 'external']).default('external'),
    /** Required for `embedded`; must appear in the project's `media` manifest. */
    sha256: sha256Schema.optional(),
    id: z.string().optional(),
    title: z.string().optional(),
    artist: z.string().optional(),
    fileName: z.string().optional(),
  })
  .refine((audio) => audio.source !== 'embedded' || audio.sha256 !== undefined, {
    message: 'embedded audio needs a sha256',
    path: ['sha256'],
  })
  .prefault({});

export const projectVenueSchema = z.object({
  /** Template id, e.g. `club-stage`. See `venue.ts`. */
  id: z.string().min(1),
  name: z.string().min(1),
});

export const projectShowSchema = z.object({
  version: z.literal(2),
  name: z.string().min(1),
  /** Full profile snapshots keep the file portable without a profile lookup. */
  fixtures: z.array(fixturePlacementSchema).min(1),
  tracks: z.array(trackSchema).default([]),
});

export const projectFileSchema = z
  .object({
    format: z.literal(PROJECT_FORMAT),
    version: z.literal(PROJECT_VERSION),
    name: z.string().min(1),
    description: z.string().optional(),
    venue: projectVenueSchema,
    show: projectShowSchema,
    timeline: projectTimelineSchema,
    arrangement: z
      .object({
        clips: z.array(projectClipSchema).default([]),
        /** Walls owned by this project. Empty means "use the venue's wall". */
        surfaces: z.array(ledSurfaceSchema).default([]),
        surfaceClips: z.array(ledSurfaceClipSchema).default([]),
      })
      .prefault({}),
    settings: projectSettingsSchema,
    audio: projectAudioSchema,
    /** Every media file the bundle carries; referenced by digest. */
    media: z.array(projectMediaSchema).default([]),
  })
  .superRefine((project, ctx) => {
    const mediaIds = new Set<string>();
    for (const [index, entry] of project.media.entries()) {
      if (mediaIds.has(entry.sha256)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate media digest \`${entry.sha256}\``,
          path: ['media', index, 'sha256'],
        });
      }
      mediaIds.add(entry.sha256);
    }

    const requireMedia = (sha256: string, path: (string | number)[]): void => {
      if (mediaIds.has(sha256)) return;
      ctx.addIssue({
        code: 'custom',
        message: `References media \`${sha256}\` that is missing from the manifest`,
        path,
      });
    };

    if (project.audio.source === 'embedded' && project.audio.sha256 !== undefined) {
      requireMedia(project.audio.sha256, ['audio', 'sha256']);
    }

    for (const [index, clip] of project.arrangement.surfaceClips.entries()) {
      const source = clip.look.media?.source;
      if (source !== undefined && source.startsWith('embedded:')) {
        requireMedia(source.slice('embedded:'.length), [
          'arrangement', 'surfaceClips', index, 'look', 'media', 'source',
        ]);
      }
    }

    const fixtureIds = new Set<string>();
    for (const [index, fixture] of project.show.fixtures.entries()) {
      if (fixtureIds.has(fixture.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate fixture id \`${fixture.id}\``,
          path: ['show', 'fixtures', index, 'id'],
        });
      }
      fixtureIds.add(fixture.id);
    }

    const clipIds = new Set<string>();
    for (const [index, clip] of project.arrangement.clips.entries()) {
      if (clipIds.has(clip.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate clip id \`${clip.id}\``,
          path: ['arrangement', 'clips', index, 'id'],
        });
      }
      clipIds.add(clip.id);
      if (!fixtureIds.has(clip.fixtureId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Clip references unknown fixture \`${clip.fixtureId}\``,
          path: ['arrangement', 'clips', index, 'fixtureId'],
        });
      }
    }

    const surfaceIds = new Set<string>();
    for (const [index, surface] of project.arrangement.surfaces.entries()) {
      if (surfaceIds.has(surface.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate surface id \`${surface.id}\``,
          path: ['arrangement', 'surfaces', index, 'id'],
        });
      }
      surfaceIds.add(surface.id);
    }

    for (const [index, clip] of project.arrangement.surfaceClips.entries()) {
      if (clipIds.has(clip.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate clip id \`${clip.id}\``,
          path: ['arrangement', 'surfaceClips', index, 'id'],
        });
      }
      clipIds.add(clip.id);
      // An empty `surfaces` list falls back to the venue wall, so the id is
      // only checked when the project declares walls of its own.
      if (surfaceIds.size > 0 && !surfaceIds.has(clip.surfaceId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Clip references unknown surface \`${clip.surfaceId}\``,
          path: ['arrangement', 'surfaceClips', index, 'surfaceId'],
        });
      }
    }
  });

/** Schema defaults, e.g. for a new project or a settings section omitted in a file. */
export function defaultProjectSettings(): ProjectSettings {
  return projectSettingsSchema.parse({});
}

export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectVenue = z.infer<typeof projectVenueSchema>;
export type ProjectClip = z.infer<typeof projectClipSchema>;
export type ProjectSurface = z.infer<typeof ledSurfaceSchema>;
export type ProjectSurfaceClip = z.infer<typeof ledSurfaceClipSchema>;
export type ProjectLedLook = z.infer<typeof ledLookSchema>;
export type ProjectTimeline = z.infer<typeof projectTimelineSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectShow = z.infer<typeof projectShowSchema>;
export type ProjectAudio = z.infer<typeof projectAudioSchema>;
export type ProjectMedia = z.infer<typeof projectMediaSchema>;

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/**
 * Validate the document envelope before schema validation.
 *
 * The spike is a demo, so there are no legacy readers or migrations: a
 * document must be the current version. Files from the future are rejected
 * with a clear message instead of being silently half-loaded.
 */
export function assertProjectEnvelope(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ProjectFileError('Project file must be a JSON object');
  }
  const candidate = input as { format?: unknown; version?: unknown };
  if (candidate.format !== undefined && candidate.format !== PROJECT_FORMAT) {
    throw new ProjectFileError(`Not a ${PROJECT_FORMAT} file`);
  }
  if (typeof candidate.version !== 'number' || !Number.isInteger(candidate.version)) {
    throw new ProjectFileError('Project file is missing an integer `version`');
  }
  if (candidate.version > PROJECT_VERSION) {
    throw new ProjectFileError(
      `Project version ${candidate.version} was written by a newer app; this build supports version ${PROJECT_VERSION}`,
    );
  }
  if (candidate.version !== PROJECT_VERSION) {
    throw new ProjectFileError(
      `Project version ${candidate.version} is no longer supported; expected version ${PROJECT_VERSION}`,
    );
  }
  return candidate as Record<string, unknown>;
}

/** Validate an unknown JSON value as a project document. */
export function parseProject(input: unknown): ProjectFile {
  const result = projectFileSchema.safeParse(assertProjectEnvelope(input));
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join('.') ?? '';
    throw new ProjectFileError(
      `Invalid project file${path === '' ? '' : ` at \`${path}\``}: ${first?.message ?? 'validation failed'}`,
    );
  }
  return result.data;
}

/** Pretty-printed JSON, suitable for writing a `.dmxsim` file. */
export function serializeProject(project: ProjectFile): string {
  return `${JSON.stringify(project, null, 2)}\n`;
}

/**
 * JSON Schema for tooling and editors. Optional refinements (end > start) are
 * not represented; `parseProject` remains the authority.
 */
export function projectJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(projectFileSchema) as Record<string, unknown>;
}
