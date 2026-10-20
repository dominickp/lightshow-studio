/**
 * The show document is self-contained: each fixture embeds a snapshot of its
 * profile. That keeps evaluation pure and makes a `.dmxsim` file portable
 * without a fixture library lookup.
 */

export type FixtureKind =
  | 'moving-head'
  | 'wash'
  | 'strobe'
  | 'laser'
  | 'par'
  | 'blinder'
  | 'led-strip'
  | 'cryo-jet';

/** DMX-addressable slots. Fine slots make 16-bit channel pairs explicit. */
export type FixtureAttribute =
  | 'dimmer'
  | 'red'
  | 'green'
  | 'blue'
  | 'white'
  | 'pan'
  | 'panFine'
  | 'tilt'
  | 'tiltFine'
  | 'zoom'
  | 'focus'
  | 'strobe'
  | 'gobo'
  | 'prism'
  | 'rotation';

/** Attributes a clip can animate. Values are normalized 0..1 like DMX. */
export type ControllableAttribute =
  | 'dimmer'
  | 'red'
  | 'green'
  | 'blue'
  | 'white'
  | 'pan'
  | 'tilt'
  | 'zoom'
  | 'focus'
  | 'strobe'
  | 'rotation';

/** Emitted beam arrangement for a laser fixture (ADR-012). */
export type LaserPattern = 'fan' | 'sweep' | 'tunnel' | 'wave' | 'lattice' | 'dots';

/**
 * Persistent laser setup. Patterns are setup, not clip animation: `rotation`
 * and pan/tilt move them through the normal clip attributes.
 */
export interface LaserSetup {
  /** Emitted beams, clamped to `FixtureProfile.laser.maxBeams`. */
  beams: number;
  pattern: LaserPattern;
  /** Full fan width in degrees; ignored by patterns with no fan. */
  fanDeg: number;
  /** Per-beam divergence in degrees. */
  divergenceDeg: number;
  /** Pattern motion in cycles per second; 0 is static. */
  speedHz: number;
  /** Pattern phase offset in degrees, for offsetting grouped lasers. */
  phaseDeg: number;
}

/** Profile-side limits for laser features. Optional so older snapshots stay valid. */
export interface LaserLimits {
  maxBeams: number;
  patterns: LaserPattern[];
  fanDeg: [number, number];
}

export interface FixtureProfile {
  id: string;
  name: string;
  kind: FixtureKind;
  manufacturer?: string;
  /** Ordered 1-based channel map. `null` is a reserved/unused slot. */
  channels: (FixtureAttribute | null)[];
  capabilities: {
    dimmer: boolean;
    color: false | 'rgb' | 'rgbw';
    panTilt: boolean;
    zoom: boolean;
    focus: boolean;
    strobe: boolean;
    gobo: boolean;
    prism: boolean;
    rotation: boolean;
  };
  /** Physical limits, in real units. */
  limits: {
    panDeg: [number, number];
    tiltDeg: [number, number];
    strobeHz: [number, number];
  };
  beam: {
    /** Full-angle spread range in degrees, narrow -> wide. */
    spreadDeg: [number, number];
    /** Approximate diameter of the emitting aperture, in metres. */
    apertureDiameterM: number;
    /** Nominal throw used for haze rendering, in metres. */
    throwM: number;
  };
  /** Laser-only capabilities. Absent on non-laser profiles and older snapshots. */
  laser?: LaserLimits;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Persisted anchor reference, resolved through the venue template (ADR-011). */
export interface FixtureMount {
  anchorId: string;
  /** Position along the anchor segment, clamped to 0..1. */
  u: number;
  /** World-space offset from the resolved anchor point, in metres. */
  offset?: Vec3;
  /** Overrides the anchor's derived yaw. */
  yawDeg?: number;
  /** Overrides the anchor's default mount pitch. */
  mountPitchDeg?: number;
}

export interface FixturePlacement {
  id: string;
  /** Friendly lane label; falls back to a generated `<kind> <n>` name. */
  name?: string;
  profile: FixtureProfile;
  position: Vec3;
  /** 0 points the fixture's tilt axis toward +Z (the audience). */
  yawDeg: number;
  /** Mechanical mounting angle, e.g. a PAR can bolted to the stage as an uplight. */
  pitchOffsetDeg?: number;
  /** Structure this fixture is attached to, when authored in this app. */
  mount?: FixtureMount;
  /** Laser beam setup. Only present on laser fixtures (ADR-012). */
  laser?: LaserSetup;
  /**
   * Setup values used when no clip asserts the attribute (ADR-010).
   *
   * Unlike clip envelopes these do not vary with song time: they are the
   * fixture's home look, the equivalent of a console's stored defaults. Omitted
   * attributes fall back to the profile's built-in defaults.
   */
  defaults?: FixtureDefaults;
}

/** Normalized (`0..1`) setup values for one fixture. */
export interface FixtureDefaults {
  dimmer?: number;
  red?: number;
  green?: number;
  blue?: number;
  white?: number;
  pan?: number;
  tilt?: number;
  zoom?: number;
  focus?: number;
  strobe?: number;
  rotation?: number;
}

export interface BeatGrid {
  bpm: number;
  /** Seconds from the start of the audio file to the first downbeat. */
  offsetSec: number;
  beatsPerBar: number;
}

export type Easing = 'linear' | 'sine' | 'easeInOut' | 'step';

export interface Keyframe {
  /** Normalized clip-local time, 0..1. */
  at: number;
  /** Normalized value, 0..1. */
  value: number;
}

export interface Clip {
  id: string;
  startSec: number;
  endSec: number;
  /** Per-attribute envelopes. A missing attribute falls back to the profile default. */
  attributes: Partial<Record<ControllableAttribute, Keyframe[]>>;
  /** Dimmer-only fades, in seconds. */
  fadeInSec?: number;
  fadeOutSec?: number;
  easing?: Easing;
}

export interface Track {
  id: string;
  name: string;
  fixtureIds: string[];
  clips: Clip[];
}

export interface Show {
  version: 1;
  name: string;
  beatGrid: BeatGrid;
  fixtures: FixturePlacement[];
  tracks: Track[];
}

/** Resolved laser state at one instant. */
export interface LaserState {
  beams: number;
  pattern: LaserPattern;
  fanDeg: number;
  divergenceDeg: number;
  speedHz: number;
  /** Scanner phase in radians, derived from song time and setup. */
  phase: number;
}

/** Resolved fixture state at one instant, in real-world units. */
export interface FixtureState {
  fixtureId: string;
  kind: FixtureKind;
  /** 0..1, already including clip fades. */
  intensity: number;
  color: { r: number; g: number; b: number };
  panDeg: number;
  tiltDeg: number;
  /** Beam full-angle spread in degrees (the zoom result). */
  spreadDeg: number;
  focus: number;
  /** 0 means no strobing. Phase is derived from song time by the renderer. */
  strobeHz: number;
  rotation: number;
  /** Laser beam state, present only for laser fixtures. */
  laser?: LaserState;
  /** True when the fixture is contributing any light this frame. */
  active: boolean;
}
