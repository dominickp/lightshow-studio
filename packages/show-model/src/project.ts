import { z } from 'zod';
import { DEFAULT_VENUE_ID } from './venue';

/**
 * Project-file schema (`.dmxsim`).
 *
 * A project is the portable unit of user work: the rig, the arrangement, the
 * song timeline (beat grid and loop), and the app settings needed to reproduce
 * a session. The document is JSON and is validated with Zod before it reaches
 * app state. See `docs/agent_docs/project-file-format.md` for the prose spec.
 *
 * The timeline owns the beat grid instead of `show.beatGrid` because the grid
 * is editable independently of the rig (ADR-003), and an imported audio file
 * may legitimately have no detected tempo (`bpm: null`).
 */

export const PROJECT_FORMAT = 'dmxsim-project';
export const PROJECT_VERSION = 2;

export const CUE_ACTIONS = ['hold', 'fade', 'pulse', 'sweep', 'strobe', 'fire'] as const;
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

export const clipSchema = z.object({
  id: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  attributes: z.partialRecord(z.enum(CONTROLLABLE_ATTRIBUTES), z.array(keyframeSchema)),
  fadeInSec: z.number().nonnegative().optional(),
  fadeOutSec: z.number().nonnegative().optional(),
  easing: z.enum(EASINGS).optional(),
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

export const projectAudioSchema = z
  .object({
    /**
     * `bundled` resolves to a track shipped with the app; `external` means the
     * user must provide the audio file locally (ADR-003).
     */
    source: z.enum(['bundled', 'external']).default('external'),
    id: z.string().optional(),
    title: z.string().optional(),
    artist: z.string().optional(),
    fileName: z.string().optional(),
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
      })
      .prefault({}),
    settings: projectSettingsSchema,
    audio: projectAudioSchema,
  })
  .superRefine((project, ctx) => {
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
  });

/** Schema defaults, e.g. for a new project or a settings section omitted in a file. */
export function defaultProjectSettings(): ProjectSettings {
  return projectSettingsSchema.parse({});
}

export type ProjectFile = z.infer<typeof projectFileSchema>;
export type ProjectVenue = z.infer<typeof projectVenueSchema>;
export type ProjectClip = z.infer<typeof projectClipSchema>;
export type ProjectTimeline = z.infer<typeof projectTimelineSchema>;
export type ProjectSettings = z.infer<typeof projectSettingsSchema>;
export type ProjectShow = z.infer<typeof projectShowSchema>;
export type ProjectAudio = z.infer<typeof projectAudioSchema>;

export class ProjectFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/**
 * Forward-only migration hook.
 *
 * v1 predates venue templates: it had no `venue` section and pinned
 * `show.version` to 1. The only venue that existed then is the club stage, so
 * v1 files are upgraded by naming it and bumping the show version. Fixtures
 * keep their absolute transforms and simply have no `mount`; the UI shows them
 * as unattached until they are re-anchored.
 */
function migrateV1toV2(project: Record<string, unknown>): Record<string, unknown> {
  const show = project.show;
  const nextShow = typeof show === 'object' && show !== null
    ? { ...(show as Record<string, unknown>), version: 2 }
    : show;

  return {
    ...project,
    version: 2,
    venue: project.venue ?? { id: DEFAULT_VENUE_ID, name: 'Club Stage' },
    show: nextShow,
  };
}

/**
 * Forward-only migration hook. The current version is 2; files from the future
 * are rejected with a clear message instead of being silently half-loaded.
 */
export function migrateProject(input: unknown): unknown {
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
  if (candidate.version < 1) {
    throw new ProjectFileError(`Unsupported project version ${candidate.version}`);
  }

  const project = candidate as Record<string, unknown>;
  if (candidate.version === 1) return migrateV1toV2(project);
  return project;
}

/** Validate an unknown JSON value as a project document. */
export function parseProject(input: unknown): ProjectFile {
  const result = projectFileSchema.safeParse(migrateProject(input));
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
