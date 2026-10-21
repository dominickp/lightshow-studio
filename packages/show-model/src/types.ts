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

/**
 * Pulse shaping for a strobing fixture.
 *
 * The strobe channel still sets the rate through `attributes.strobe`; these
 * settings describe the shape of each individual flash. All fractions are of
 * one pulse cycle, so the same shape sounds identical at any speed.
 */
export interface StrobeSettings {
  /** Explicit rate in Hz. Overrides the strobe-channel value when present. */
  hz?: number;
  /** Fraction of the cycle spent ramping up from `depth` to full. */
  attack?: number;
  /** Fraction of the cycle spent ramping back down to `depth`. */
  release?: number;
  /** Level held between flashes, 0 (blackout) .. 1 (no pulsing). */
  depth?: number;
}

/**
 * Movement shaping for a pan/tilt sweep.
 *
 * Like `StrobeSettings` this is evaluated against song time instead of being
 * baked into keyframes, so the movement rate is independent of how long the
 * clip is. Centres and ranges are normalized 0..1 like every other attribute,
 * so the profile's physical limits still apply.
 */
export interface SweepSettings {
  /** Movement cycles per second. Omitted keeps the legacy one cycle per clip. */
  hz?: number;
  /**
   * Starting point in the cycle, 0..1. Two clips with the same rate and
   * different phase stay deliberately out of step, which is how grouped heads
   * are offset from each other.
   */
  phase?: number;
  /** Pan centre, normalized 0..1. Defaults to 0.5. */
  panCenter?: number;
  /** Pan half-swing, normalized 0..1. Defaults to 0.35. */
  panRange?: number;
  /** Tilt centre, normalized 0..1. Defaults to 0.54. */
  tiltCenter?: number;
  /** Tilt half-swing, normalized 0..1. Defaults to 0.12. */
  tiltRange?: number;
}

/**
 * Where a clip points, and optionally how it travels there.
 *
 * Aim is the non-oscillating counterpart of a sweep: the head moves from one
 * pose to another once, then holds. With no end pose (or an end equal to the
 * start) the clip is a still pose. Values are normalized 0..1 like every other
 * attribute, so the profile's physical limits still apply.
 */
export interface AimSettings {
  /** Pan at the start of the travel, normalized 0..1. */
  pan: number;
  /** Tilt at the start of the travel, normalized 0..1. */
  tilt: number;
  /** Pan reached at the end of the travel. Omitted keeps `pan`. */
  toPan?: number;
  /** Tilt reached at the end of the travel. Omitted keeps `tilt`. */
  toTilt?: number;
  /**
   * Seconds the travel takes, measured from the clip start. Omitted stretches
   * the travel across the whole clip. `0` jumps straight to the end pose.
   */
  travelSec?: number;
  /** Shape of the travel. Omitted eases in and out, which suits a slow descent. */
  easing?: Easing;
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
  /** Pulse shaping for this clip. Only used when the clip strobes. */
  strobe?: StrobeSettings;
  /** Explicit pulse rate for a `pulse`-style dimmer envelope, in Hz. */
  pulseHz?: number;
  /** Fixed pan/tilt aim. Overrides `attributes.pan`/`tilt`; an explicit sweep wins. */
  aim?: AimSettings;
  /** Pan/tilt movement shaping. Overrides `attributes.pan`/`tilt` when present. */
  sweep?: SweepSettings;
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
  /** 0 means no strobing. */
  strobeHz: number;
  /**
   * Strobe gate at this instant, 0..1. `1` when the fixture is not strobing;
   * multiply `intensity` by this to get the emitted level. Computed in the
   * evaluator so every renderer and export agrees on the pulse shape.
   */
  strobeLevel: number;
  rotation: number;
  /** Laser beam state, present only for laser fixtures. */
  laser?: LaserState;
  /** True when the fixture is contributing any light this frame. */
  active: boolean;
}
