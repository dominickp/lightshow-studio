import type {
  FixtureKind,
  FixtureMount,
  FixturePlacement,
  FixtureProfile,
  LaserSetup,
  Vec3,
} from './types';

/**
 * Venue templates.
 *
 * A template describes a room as plain data: shell geometry, optional
 * procedural features, static structure, mount anchors, and camera presets.
 * It contains no renderer code because `show-model` must stay free of
 * three.js (ADR-006); the app builds meshes from these descriptors.
 *
 * Fixtures attach to anchors rather than carrying only absolute coordinates,
 * so "ten moving heads on the front truss" survives a template change and can
 * be authored in bulk (ADR-011). The resolved transform is still written to
 * the fixture, which keeps older files and unknown anchors renderable.
 */

export type VenueRole = 'metal' | 'wall' | 'floor' | 'stage' | 'dark';

/** A static piece of venue geometry, expressed in world metres. */
export interface VenuePrimitive {
  shape: 'box' | 'plane';
  role: VenueRole;
  size: Vec3;
  position: Vec3;
  /** Rotation in degrees, applied in XYZ order. Planes default to facing +Z. */
  rotationDeg?: Vec3;
}

/** Inclusive metric bounds on all three axes. */
export interface VenueBounds {
  x: [number, number];
  y: [number, number];
  z: [number, number];
}

/**
 * A planar surface a beam can terminate on. `axis`/`value` define the plane;
 * `bounds` clips it to the physical object.
 */
export interface VenueSurface {
  kind: 'floor' | 'wall' | 'riser' | 'led' | 'ceiling';
  axis: 'x' | 'y' | 'z';
  value: number;
  bounds: VenueBounds | null;
  /** Lifts hit decals off the surface so they do not z-fight. */
  decalOffset: number;
}

/**
 * Procedural features the renderer knows how to build. Omitted features mean
 * the venue has none. Boxes belong in `structure`; this only covers geometry
 * that is generated rather than placed (instanced crowd, animated LED wall,
 * haze) plus the emissive accent strips.
 */
export interface VenueFeatures {
  ledWall?: { width: number; height: number; y: number; z: number };
  /** Emissive strips that pulse with the beat, e.g. stage and booth edges. */
  accentStrips?: { size: Vec3; position: Vec3 }[];
  crowd?: { count: number; spreadX: number; spreadZ: number; nearZ: number };
  haze?: boolean;
}

export type AnchorKind = 'truss' | 'tower' | 'floor' | 'riser' | 'wall' | 'free';

/**
 * A place a fixture can be mounted. `start`/`end` form a segment even for
 * point mounts (use the same point twice), so bulk placement can distribute
 * fixtures along a truss.
 */
export interface MountAnchor {
  id: string;
  name: string;
  kind: AnchorKind;
  start: Vec3;
  end: Vec3;
  /**
   * Direction the anchor faces. `yawDeg` is derived from its horizontal part
   * (0 = +Z, the audience side).
   */
  normal: Vec3;
  /**
   * Mount pitch for fixtures on this anchor, using the same convention as
   * `FixturePlacement.pitchOffsetDeg`: 0 hangs down, 90 points along the
   * anchor normal, 168 is a floor uplight, 180 points straight up.
   */
  mountPitchDeg: number;
  /**
   * Default world offset applied to fixtures added on this anchor. Trusses hang
   * their lights below the bar; riser edges sit on top of the deck. Bulk-add
   * uses this so a new fixture is immediately in a sensible place.
   */
  mountOffset?: Vec3;
  /** Profile ids the Add dialog should list first. */
  suggestedProfiles?: string[];
}

export interface CameraPreset {
  position: Vec3;
  target: Vec3;
}

/** One fixture in a venue's ready-made rig, resolved through the library. */
export interface RigPresetEntry {
  /** Stable id. Generated from the profile id when omitted. */
  id?: string;
  profileId: string;
  anchorId: string;
  /** Position along the anchor segment, 0..1. */
  u: number;
  offset?: Vec3;
  yawDeg?: number;
  mountPitchDeg?: number;
  name?: string;
  /** Laser beam setup for laser fixtures (ADR-012). */
  laser?: LaserSetup;
}

export interface RigPreset {
  id: string;
  name: string;
  fixtures: RigPresetEntry[];
}

export interface VenueTemplate {
  id: string;
  name: string;
  description?: string;
  /** Room shell dimensions in metres. */
  bounds: { width: number; depth: number; height: number };
  features: VenueFeatures;
  structure: VenuePrimitive[];
  /** Planes laser beams and floor pools terminate on. */
  surfaces: VenueSurface[];
  anchors: MountAnchor[];
  /** Ready-made rig, so choosing a venue needs no fixture authoring. */
  defaultRig: RigPreset;
  cameraPresets: CameraPreset[];
}

export interface ResolvedMount {
  position: Vec3;
  yawDeg: number;
  pitchOffsetDeg: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const DEG = 180 / Math.PI;

/** Normalize degrees into `-180..180`. */
export function normalizeDeg(deg: number): number {
  const wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** Yaw implied by an anchor's facing: 0 points toward +Z (the audience). */
export function anchorYawDeg(anchor: MountAnchor): number {
  const { x, z } = anchor.normal;
  if (Math.abs(x) < 1e-9 && Math.abs(z) < 1e-9) return 0;
  return normalizeDeg(Math.atan2(x, z) * DEG);
}

/** Point on the anchor segment, before offsets. */
export function anchorPoint(anchor: MountAnchor, u: number): Vec3 {
  const t = clamp01(u);
  return {
    x: lerp(anchor.start.x, anchor.end.x, t),
    y: lerp(anchor.start.y, anchor.end.y, t),
    z: lerp(anchor.start.z, anchor.end.z, t),
  };
}

export function findAnchor(template: VenueTemplate, anchorId: string): MountAnchor | undefined {
  return template.anchors.find((anchor) => anchor.id === anchorId);
}

/**
 * Resolve a persisted mount against a template.
 *
 * Returns `null` when the anchor does not exist (for example a file authored
 * against a newer template). Callers must then keep the fixture's cached
 * transform rather than dropping the light.
 */
export function resolveMount(template: VenueTemplate, mount: FixtureMount): ResolvedMount | null {
  const anchor = findAnchor(template, mount.anchorId);
  if (anchor === undefined) return null;

  const point = anchorPoint(anchor, mount.u);
  return {
    position: {
      x: point.x + (mount.offset?.x ?? 0),
      y: point.y + (mount.offset?.y ?? 0),
      z: point.z + (mount.offset?.z ?? 0),
    },
    yawDeg: normalizeDeg(mount.yawDeg ?? anchorYawDeg(anchor)),
    pitchOffsetDeg: mount.mountPitchDeg ?? anchor.mountPitchDeg,
  };
}

/** Short id stem per fixture kind, used for generated fixture ids. */
export const FIXTURE_ID_PREFIXES: Record<FixtureKind, string> = {
  'moving-head': 'mh',
  wash: 'wash',
  strobe: 'strobe',
  laser: 'laser',
  par: 'par',
  blinder: 'blinder',
  'led-strip': 'led',
};

/**
 * Next unused `<kind>-<n>` id.
 *
 * `existing` must include fixtures created earlier in the same batch. Reading
 * only the document's current fixtures hands out the same id to every light in
 * a bulk add, which then makes one gesture move all of them (`Arrangement`
 * treats the id as clip identity).
 */
export function nextFixtureId(existing: readonly { id: string }[], kind: FixtureKind): string {
  const prefix = FIXTURE_ID_PREFIXES[kind];
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  for (const fixture of existing) {
    const match = pattern.exec(fixture.id);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `${prefix}-${max + 1}`;
}

/**
 * Build a template's default rig. Profiles are supplied by the caller because
 * `show-model` must not depend on the fixture library.
 *
 * Throws on an unknown anchor or profile: a template is our own data, so a
 * missing entry is a programming error rather than user input.
 */
export function instantiateRig(
  template: VenueTemplate,
  profiles: Readonly<Record<string, FixtureProfile>>,
  preset: RigPreset = template.defaultRig,
): FixturePlacement[] {
  const used = new Set<string>();
  let counter = 0;

  return preset.fixtures.map((entry) => {
    const profile = profiles[entry.profileId];
    if (profile === undefined) {
      throw new Error(`Venue "${template.id}" references unknown profile "${entry.profileId}"`);
    }
    const anchor = findAnchor(template, entry.anchorId);
    if (anchor === undefined) {
      throw new Error(`Venue "${template.id}" references unknown anchor "${entry.anchorId}"`);
    }
    const resolved = resolveMount(template, {
      anchorId: entry.anchorId,
      u: entry.u,
      offset: entry.offset,
      yawDeg: entry.yawDeg,
      mountPitchDeg: entry.mountPitchDeg,
    });
    if (resolved === null) {
      throw new Error(`Venue "${template.id}" could not resolve anchor "${entry.anchorId}"`);
    }

    let id = entry.id ?? `${entry.profileId}-${counter++}`;
    while (used.has(id)) id = `${entry.id ?? entry.profileId}-${counter++}`;
    used.add(id);

    return {
      id,
      ...(entry.name === undefined ? {} : { name: entry.name }),
      profile,
      position: resolved.position,
      yawDeg: resolved.yawDeg,
      pitchOffsetDeg: resolved.pitchOffsetDeg,
      ...(entry.laser === undefined ? {} : { laser: entry.laser }),
      mount: {
        anchorId: entry.anchorId,
        u: clamp01(entry.u),
        ...(entry.offset === undefined ? {} : { offset: entry.offset }),
        ...(entry.yawDeg === undefined ? {} : { yawDeg: entry.yawDeg }),
        ...(entry.mountPitchDeg === undefined ? {} : { mountPitchDeg: entry.mountPitchDeg }),
      },
    };
  });
}

/** The only venue that existed before templates were introduced. */
export const DEFAULT_VENUE_ID = 'club-stage';

const CLUB_TRUSS_PITCH = 0;
const UPLIGHT_PITCH = 168;

/** Distribute `count` entries across a segment, inset from both ends. */
function spread(count: number, from: number, to: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [(from + to) / 2];
  return Array.from({ length: count }, (_, index) => from + ((to - from) * index) / (count - 1));
}

function clubDefaultRig(): RigPreset {
  const fixtures: RigPresetEntry[] = [];
  // Fixtures hang below the truss and sit on top of the riser, matching the
  // spikes's original hand-authored positions.
  const HANG = { x: 0, y: -0.6, z: 0 };

  spread(10, 1.2 / 10.5, 1 - 1.2 / 10.5).forEach((u, index) => {
    fixtures.push({
      id: `mh-front-${index}`,
      profileId: 'generic-moving-head',
      anchorId: 'truss-front',
      u,
      offset: HANG,
      yawDeg: (index / 9 - 0.5) * 24,
    });
  });

  spread(6, 4.1 / 10.5 / 2, 1 - 4.1 / 10.5 / 2).forEach((u, index) => {
    fixtures.push({
      id: `mh-rear-${index}`,
      profileId: 'generic-moving-head',
      anchorId: 'truss-rear',
      u,
      offset: HANG,
      yawDeg: (index / 5 - 0.5) * -30,
    });
  });

  spread(6, 3.5 / 10.5 / 2, 1 - 3.5 / 10.5 / 2).forEach((u, index) => {
    fixtures.push({
      id: `wash-${index}`,
      profileId: 'generic-wash',
      anchorId: 'truss-mid',
      u,
      offset: { x: 0, y: -0.5, z: 0 },
      yawDeg: (index / 5 - 0.5) * 20,
    });
  });

  [0, 1, 2, 3].forEach((index) => {
    const side = index < 2 ? 1 : -1;
    fixtures.push({
      id: `strobe-${index}`,
      profileId: 'generic-strobe',
      anchorId: index < 2 ? 'tower-left' : 'tower-right',
      u: 0.8133,
      offset: { x: side * 1.3, y: 0, z: index % 2 === 0 ? 4.4 : 1.0 },
    });
  });

  /* Two lasers with different setups: a wide scanning fan and a rotating
   * tunnel ring. Separate patterns and phase offsets keep them from reading
   * as one duplicated fixture, and give the scanner motion something to move
   * between. */
  const laserSetups: LaserSetup[] = [
    { beams: 10, pattern: 'fan', fanDeg: 52, divergenceDeg: 0.6, speedHz: 0, phaseDeg: 0 },
    { beams: 12, pattern: 'tunnel', fanDeg: 26, divergenceDeg: 0.5, speedHz: 0.12, phaseDeg: 90 },
  ];
  [0, 1].forEach((index) => {
    fixtures.push({
      id: `laser-${index}`,
      profileId: 'generic-laser',
      anchorId: 'truss-rear',
      u: index === 0 ? 9.1 / 21 : 11.9 / 21,
      offset: { x: 0, y: -0.5, z: 0 },
      laser: laserSetups[index]!,
    });
  });

  spread(4, 4.5 / 24, 1 - 4.5 / 24).forEach((u, index) => {
    fixtures.push({
      id: `par-${index}`,
      profileId: 'generic-par',
      anchorId: 'riser-front',
      u,
      offset: { x: 0, y: 0.38, z: 0 },
      mountPitchDeg: UPLIGHT_PITCH,
    });
  });

  return { id: 'club-default', name: 'Club stage rig', fixtures };
}

/**
 * The original spike venue, reproduced exactly as `Stage.addRoom()` built it.
 * Dimensions are the numbers that were hardcoded in the renderer.
 */
export const CLUB_STAGE: VenueTemplate = {
  id: DEFAULT_VENUE_ID,
  name: 'Club Stage',
  description: 'Three overhead trusses, a low riser, a small LED wall, and a standing crowd.',
  bounds: { width: 40, depth: 34, height: 12 },
  features: {
    ledWall: { width: 13.5, height: 6.2, y: 4.9, z: -11.85 },
    accentStrips: [
      { size: { x: 4.5, y: 0.07, z: 0.07 }, position: { x: 0, y: 1.84, z: -8.95 } },
      { size: { x: 23.5, y: 0.06, z: 0.06 }, position: { x: 0, y: 0.32, z: -2.56 } },
    ],
    crowd: { count: 90, spreadX: 26, spreadZ: 14, nearZ: 0.5 },
    haze: true,
  },
  structure: [
    { shape: 'plane', role: 'floor', size: { x: 40, y: 34, z: 0 }, position: { x: 0, y: 0, z: 3 }, rotationDeg: { x: -90, y: 0, z: 0 } },
    { shape: 'plane', role: 'wall', size: { x: 40, y: 14, z: 0 }, position: { x: 0, y: 7, z: -12 } },
    { shape: 'plane', role: 'wall', size: { x: 34, y: 14, z: 0 }, position: { x: -17, y: 7, z: 3 }, rotationDeg: { x: 0, y: 90, z: 0 } },
    { shape: 'plane', role: 'wall', size: { x: 34, y: 14, z: 0 }, position: { x: 17, y: 7, z: 3 }, rotationDeg: { x: 0, y: -90, z: 0 } },
    { shape: 'plane', role: 'wall', size: { x: 40, y: 34, z: 0 }, position: { x: 0, y: 12, z: 3 }, rotationDeg: { x: 90, y: 0, z: 0 } },
    { shape: 'box', role: 'stage', size: { x: 24, y: 0.3, z: 9.4 }, position: { x: 0, y: 0.15, z: -7.3 } },
    { shape: 'box', role: 'metal', size: { x: 21, y: 0.28, z: 0.28 }, position: { x: 0, y: 8, z: 1.6 } },
    { shape: 'box', role: 'metal', size: { x: 21, y: 0.28, z: 0.28 }, position: { x: 0, y: 8, z: -2.0 } },
    { shape: 'box', role: 'metal', size: { x: 21, y: 0.28, z: 0.28 }, position: { x: 0, y: 8, z: -5.6 } },
    { shape: 'box', role: 'metal', size: { x: 0.24, y: 8.4, z: 0.24 }, position: { x: -10.5, y: 4.2, z: 1.6 } },
    { shape: 'box', role: 'metal', size: { x: 0.24, y: 8.4, z: 0.24 }, position: { x: 10.5, y: 4.2, z: 1.6 } },
    { shape: 'box', role: 'metal', size: { x: 0.24, y: 8.4, z: 0.24 }, position: { x: -10.5, y: 4.2, z: -2.0 } },
    { shape: 'box', role: 'metal', size: { x: 0.24, y: 8.4, z: 0.24 }, position: { x: 10.5, y: 4.2, z: -2.0 } },
    { shape: 'box', role: 'metal', size: { x: 0.24, y: 8.4, z: 0.24 }, position: { x: -10.5, y: 4.2, z: -5.6 } },
    { shape: 'box', role: 'metal', size: { x: 0.24, y: 8.4, z: 0.24 }, position: { x: 10.5, y: 4.2, z: -5.6 } },
    { shape: 'box', role: 'stage', size: { x: 4.6, y: 1.5, z: 1.4 }, position: { x: 0, y: 1.05, z: -9.7 } },
    { shape: 'box', role: 'dark', size: { x: 4.2, y: 0.08, z: 1.1 }, position: { x: 0, y: 1.84, z: -9.7 } },
    { shape: 'box', role: 'dark', size: { x: 4.5, y: 0.07, z: 0.07 }, position: { x: 0, y: 1.84, z: -8.95 } },
    { shape: 'box', role: 'dark', size: { x: 23.5, y: 0.06, z: 0.06 }, position: { x: 0, y: 0.32, z: -2.56 } },
  ],
  surfaces: [
    { kind: 'floor', axis: 'y', value: 0, bounds: null, decalOffset: 0.012 },
    { kind: 'riser', axis: 'y', value: 0.3, bounds: { x: [-12, 12], y: [0.3, 0.3], z: [-12, -2.6] }, decalOffset: 0.012 },
    { kind: 'ceiling', axis: 'y', value: 12, bounds: { x: [-20, 20], y: [12, 12], z: [-14, 20] }, decalOffset: 0.02 },
    { kind: 'wall', axis: 'z', value: -11.9, bounds: { x: [-20, 20], y: [0, 14], z: [-12, -11.8] }, decalOffset: 0.02 },
    { kind: 'led', axis: 'z', value: -11.85, bounds: { x: [-6.75, 6.75], y: [1.8, 8], z: [-11.9, -11.8] }, decalOffset: 0.03 },
    { kind: 'wall', axis: 'x', value: -16.9, bounds: { x: [-17, -16.8], y: [0, 14], z: [-14, 20] }, decalOffset: 0.02 },
    { kind: 'wall', axis: 'x', value: 16.9, bounds: { x: [16.8, 17], y: [0, 14], z: [-14, 20] }, decalOffset: 0.02 },
  ],
  anchors: [
    {
      id: 'truss-front',
      name: 'Front truss',
      kind: 'truss',
      start: { x: -10.5, y: 8, z: 1.6 },
      end: { x: 10.5, y: 8, z: 1.6 },
      normal: { x: 0, y: 0, z: 1 },
      mountPitchDeg: CLUB_TRUSS_PITCH,
      mountOffset: { x: 0, y: -0.6, z: 0 },
      suggestedProfiles: ['generic-moving-head', 'generic-wash', 'generic-strobe'],
    },
    {
      id: 'truss-mid',
      name: 'Mid truss',
      kind: 'truss',
      start: { x: -10.5, y: 8, z: -2.0 },
      end: { x: 10.5, y: 8, z: -2.0 },
      normal: { x: 0, y: 0, z: 1 },
      mountPitchDeg: CLUB_TRUSS_PITCH,
      mountOffset: { x: 0, y: -0.5, z: 0 },
      suggestedProfiles: ['generic-wash', 'generic-moving-head'],
    },
    {
      id: 'truss-rear',
      name: 'Rear truss',
      kind: 'truss',
      start: { x: -10.5, y: 8, z: -5.6 },
      end: { x: 10.5, y: 8, z: -5.6 },
      normal: { x: 0, y: 0, z: 1 },
      mountPitchDeg: CLUB_TRUSS_PITCH,
      mountOffset: { x: 0, y: -0.5, z: 0 },
      suggestedProfiles: ['generic-moving-head', 'generic-laser', 'generic-wash'],
    },
    {
      id: 'tower-left',
      name: 'Left tower',
      kind: 'tower',
      start: { x: -10.5, y: 0.5, z: -2.0 },
      end: { x: -10.5, y: 8, z: -2.0 },
      normal: { x: 1, y: 0, z: 0 },
      mountPitchDeg: CLUB_TRUSS_PITCH,
      suggestedProfiles: ['generic-strobe', 'generic-wash'],
    },
    {
      id: 'tower-right',
      name: 'Right tower',
      kind: 'tower',
      start: { x: 10.5, y: 0.5, z: -2.0 },
      end: { x: 10.5, y: 8, z: -2.0 },
      normal: { x: -1, y: 0, z: 0 },
      mountPitchDeg: CLUB_TRUSS_PITCH,
      suggestedProfiles: ['generic-strobe', 'generic-wash'],
    },
    {
      id: 'riser-front',
      name: 'Stage front edge',
      kind: 'riser',
      start: { x: -12, y: 0.32, z: -2.6 },
      end: { x: 12, y: 0.32, z: -2.6 },
      normal: { x: 0, y: 0, z: 1 },
      mountPitchDeg: UPLIGHT_PITCH,
      mountOffset: { x: 0, y: 0.38, z: 0 },
      suggestedProfiles: ['generic-par', 'generic-blinder'],
    },
    {
      id: 'stage-floor',
      name: 'Stage floor',
      kind: 'floor',
      start: { x: -12, y: 0.32, z: -7.3 },
      end: { x: 12, y: 0.32, z: -7.3 },
      normal: { x: 0, y: 0, z: 1 },
      mountPitchDeg: UPLIGHT_PITCH,
      suggestedProfiles: ['generic-par', 'generic-led-strip'],
    },
    {
      id: 'wall-back',
      name: 'Back wall',
      kind: 'wall',
      start: { x: -16.9, y: 0.5, z: -11.9 },
      end: { x: 16.9, y: 0.5, z: -11.9 },
      normal: { x: 0, y: 0, z: 1 },
      mountPitchDeg: 90,
      suggestedProfiles: ['generic-led-strip', 'generic-wash', 'generic-par'],
    },
  ],
  defaultRig: clubDefaultRig(),
  cameraPresets: [
    { position: { x: 0, y: 6.5, z: 16 }, target: { x: 0, y: 3.2, z: -3 } },
    { position: { x: 15, y: 6, z: 9 }, target: { x: 0, y: 3.6, z: -4 } },
    { position: { x: -15, y: 6, z: 9 }, target: { x: 0, y: 3.6, z: -4 } },
    { position: { x: 0, y: 15, z: 7 }, target: { x: 0, y: 1.5, z: -4 } },
    { position: { x: 0, y: 2.1, z: 5.5 }, target: { x: 0, y: 5.5, z: -6 } },
  ],
};

/** Venue templates shipped with the app, keyed by id. */
export const VENUE_TEMPLATES: Readonly<Record<string, VenueTemplate>> = {
  [CLUB_STAGE.id]: CLUB_STAGE,
};

/** Template registry lookup; `undefined` means this build does not know the venue. */
export function venueById(id: string): VenueTemplate | undefined {
  return VENUE_TEMPLATES[id];
}
