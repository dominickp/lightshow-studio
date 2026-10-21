import type {
  Clip,
  ControllableAttribute,
  Easing,
  FixtureDefaults,
  FixturePlacement,
  FixtureState,
  Keyframe,
  LaserLimits,
  LaserSetup,
  LaserState,
  Show,
  StrobeSettings,
  SweepSettings,
} from './types';

const DEFAULTS: Record<ControllableAttribute, number> = {
  dimmer: 0,
  red: 1,
  green: 1,
  blue: 1,
  white: 0,
  pan: 0.5,
  tilt: 0.5,
  zoom: 0,
  focus: 0.5,
  strobe: 0,
  rotation: 0,
};

const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  sine: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
  step: (t) => (t < 1 ? 0 : 1),
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Laser setup when a project omits it or a profile has no limits block. */
export const DEFAULT_LASER_SETUP: LaserSetup = {
  beams: 8,
  pattern: 'fan',
  fanDeg: 40,
  divergenceDeg: 1.2,
  speedHz: 0.5,
  phaseDeg: 0,
};

const FALLBACK_LASER_LIMITS: LaserLimits = {
  maxBeams: 32,
  patterns: ['fan', 'sweep', 'tunnel', 'wave', 'lattice', 'dots'],
  fanDeg: [0, 120],
};

const TWO_PI = Math.PI * 2;

/**
 * Default pulse shape. A real strobe is close to a square wave, so the
 * ramps are short: enough to avoid the hard edge on camera and in haze,
 * but not so long that the flash reads as a dimmer pulse.
 */
const DEFAULT_STROBE: Required<Omit<StrobeSettings, 'hz'>> = {
  attack: 0.05,
  release: 0.18,
  depth: 0,
};

/** Share of one cycle the lamp is lit. The rest is the off gap. */
export const STROBE_DUTY = 0.5;
/**
 * Normalized strobe gate at `phase` (0..1 through one cycle).
 *
 * The lamp is lit for the first `STROBE_DUTY` of the cycle, with an optional
 * attack ramp at the leading edge and a release ramp at the trailing edge.
 * `depth` is the floor between flashes, so a value above 0 gives a shimmer
 * rather than a full blackout.
 */
export function strobeGate(
  phase: number,
  settings: StrobeSettings = {},
): number {
  const attack = clamp01(settings.attack ?? DEFAULT_STROBE.attack);
  const release = clamp01(settings.release ?? DEFAULT_STROBE.release);
  const depth = clamp01(settings.depth ?? DEFAULT_STROBE.depth);
  const p = phase - Math.floor(phase);

  let shape = 0;
  if (p < STROBE_DUTY) {
    const attackEnd = Math.min(attack, STROBE_DUTY);
    const releaseStart = STROBE_DUTY - Math.min(release, STROBE_DUTY - attackEnd);
    if (p < attackEnd) shape = attackEnd <= 0 ? 1 : p / attackEnd;
    else if (p >= releaseStart) shape = (STROBE_DUTY - p) / (STROBE_DUTY - releaseStart);
    else shape = 1;
  }

  return clamp01(depth + (1 - depth) * shape);
}

/**
 * Default pan/tilt sweep. These match the original hand-written sweep
 * keyframes (pan 0.15..0.85, tilt 0.42..0.66), so clips authored before
 * `sweep` existed keep their look.
 */
export const DEFAULT_SWEEP: Required<Omit<SweepSettings, 'hz'>> = {
  phase: 0,
  panCenter: 0.5,
  panRange: 0.35,
  tiltCenter: 0.54,
  tiltRange: 0.12,
};

/**
 * One sample of the movement wave, -1..1.
 *
 * The cycle starts at the trough rather than the centre so a sweep with no
 * phase offset and no explicit rate reproduces the legacy keyframes exactly.
 */
export function sweepWave(cycles: number): number {
  return -Math.cos(TWO_PI * cycles);
}

/** Resolved laser setup plus the scanner phase at `timeSec`. */
export function resolveLaser(
  setup: LaserSetup | undefined,
  limits: LaserLimits | undefined,
  timeSec: number,
  rotation: number,
): LaserState {
  const merged = { ...DEFAULT_LASER_SETUP, ...setup };
  const limits2 = limits ?? FALLBACK_LASER_LIMITS;
  const maxBeams = Math.max(1, Math.round(limits2.maxBeams));
  const [fanMin, fanMax] = limits2.fanDeg;
  const fanDeg = Math.min(fanMax, Math.max(fanMin, merged.fanDeg));
  const beams = Math.min(maxBeams, Math.max(1, Math.round(merged.beams)));
  const divergenceDeg = Math.max(0, merged.divergenceDeg);
  const speedHz = Math.max(0, merged.speedHz);
  const phase = TWO_PI * (speedHz * timeSec + rotation + merged.phaseDeg / 360);

  return {
    beams,
    pattern: merged.pattern,
    fanDeg,
    divergenceDeg,
    speedHz,
    phase: ((phase % TWO_PI) + TWO_PI) % TWO_PI,
  };
}

function sampleKeyframes(keyframes: Keyframe[], t01: number, ease: (t: number) => number): number {
  const first = keyframes[0];
  if (first === undefined) return 0;
  if (t01 <= first.at) return first.value;

  for (let i = 1; i < keyframes.length; i += 1) {
    const a = keyframes[i - 1];
    const b = keyframes[i];
    if (a === undefined || b === undefined) continue;
    if (t01 <= b.at) {
      const span = b.at - a.at;
      if (span <= 1e-9) return b.value;
      const f = ease((t01 - a.at) / span);
      return a.value + (b.value - a.value) * f;
    }
  }

  return keyframes[keyframes.length - 1]?.value ?? 0;
}

function fadeEnvelope(clip: Clip, timeSec: number): number {
  let env = 1;
  const fadeIn = clip.fadeInSec ?? 0;
  const fadeOut = clip.fadeOutSec ?? 0;

  if (fadeIn > 0) env = Math.min(env, (timeSec - clip.startSec) / fadeIn);
  if (fadeOut > 0) env = Math.min(env, (clip.endSec - timeSec) / fadeOut);

  return clamp01(env);
}

function resolveAttributes(
  clips: readonly Clip[],
  timeSec: number,
  defaults?: FixtureDefaults,
): {
  values: Record<ControllableAttribute, number>;
  fade: number;
  hasActiveClip: boolean;
  strobe?: StrobeSettings;
} {
  const values: Record<ControllableAttribute, number> = { ...DEFAULTS };

  // Setup values are the starting point: a clip that does not animate an
  // attribute leaves the fixture's stored default in place (ADR-010).
  if (defaults !== undefined) {
    for (const [attribute, value] of Object.entries(defaults)) {
      if (value === undefined) continue;
      values[attribute as ControllableAttribute] = clamp01(value);
    }
  }

  let fade = 1;
  let hasActiveClip = false;
  let strobe: StrobeSettings | undefined;

  for (const clip of clips) {
    if (timeSec < clip.startSec || timeSec > clip.endSec) continue;
    if (clip.endSec <= clip.startSec) continue;
    hasActiveClip = true;
    if (clip.strobe !== undefined) strobe = clip.strobe;

    const span = clip.endSec - clip.startSec;
    const t01 = clamp01((timeSec - clip.startSec) / span);
    const ease = EASINGS[clip.easing ?? 'linear'];
    const dimmerEnvelope = clip.attributes.dimmer;

    for (const [attribute, keyframes] of Object.entries(clip.attributes)) {
      if (keyframes === undefined || keyframes.length === 0) continue;
      values[attribute as ControllableAttribute] = clamp01(sampleKeyframes(keyframes, t01, ease));
    }

    /* A sweep is evaluated from song time rather than baked keyframes, so its
     * rate is independent of the clip length and its phase can offset grouped
     * fixtures. It wins over any authored pan/tilt envelope. */
    if (clip.sweep !== undefined) {
      const sweep = clip.sweep;
      const hz = sweep.hz !== undefined && sweep.hz > 0 ? sweep.hz : 1 / span;
      const cycles = (timeSec - clip.startSec) * hz + (sweep.phase ?? 0);
      const wave = sweepWave(cycles);
      values.pan = clamp01((sweep.panCenter ?? DEFAULT_SWEEP.panCenter)
        + (sweep.panRange ?? DEFAULT_SWEEP.panRange) * wave);
      values.tilt = clamp01((sweep.tiltCenter ?? DEFAULT_SWEEP.tiltCenter)
        + (sweep.tiltRange ?? DEFAULT_SWEEP.tiltRange) * wave);
    }

    if (dimmerEnvelope !== undefined && dimmerEnvelope.length > 0) {
      fade = fadeEnvelope(clip, timeSec);
    }
  }

  return { values, fade, hasActiveClip, ...(strobe === undefined ? {} : { strobe }) };
}

const lerpRange = (n: number, range: readonly [number, number]): number =>
  range[0] + (range[1] - range[0]) * n;

/** Attribute values for one fixture at one instant. Never mutates the show. */
export function evaluateFixture(
  fixture: FixturePlacement,
  clips: readonly Clip[],
  timeSec: number,
): FixtureState {
  const { values, fade, hasActiveClip, strobe } = resolveAttributes(clips, timeSec, fixture.defaults);
  const { profile } = fixture;
  const caps = profile.capabilities;

  // A dimmer default is a real level: it lights the fixture even with no clip.
  // Fixtures without a dimmer only contribute while a clip is active.
  const intensity = caps.dimmer ? clamp01(values.dimmer * fade) : (hasActiveClip ? fade : 0);
  const hasColor = caps.color !== false;

  const white = caps.color === 'rgbw' ? values.white : 0;
  const color = {
    r: hasColor ? clamp01(values.red + white) : 1,
    g: hasColor ? clamp01(values.green + white) : 1,
    b: hasColor ? clamp01(values.blue + white) : 1,
  };

  const panNorm = caps.panTilt ? values.pan : 0.5;
  const tiltNorm = caps.panTilt ? values.tilt : 0.5;
  const zoomNorm = caps.zoom ? values.zoom : 0.5;

  /* The strobe channel sets a rate; an explicit per-clip Hz overrides it so a
   * clip can ask for "8 Hz" instead of an opaque channel percentage. */
  const strobeValue = caps.strobe ? values.strobe : 0;
  const [strobeMin, strobeMax] = profile.limits.strobeHz;
  const requestedHz = strobe?.hz ?? (strobeValue > 0.001 ? lerpRange(strobeValue, profile.limits.strobeHz) : 0);
  const strobeHz = requestedHz > 0.001
    ? Math.min(strobeMax, Math.max(strobeMin, requestedHz))
    : 0;
  const strobeLevel = strobeHz > 0 ? strobeGate(timeSec * strobeHz, strobe) : 1;

  const laser = profile.kind === 'laser'
    ? resolveLaser(fixture.laser, profile.laser, timeSec, caps.rotation ? values.rotation : 0)
    : undefined;

  return {
    fixtureId: fixture.id,
    kind: profile.kind,
    intensity,
    color,
    panDeg: lerpRange(panNorm, profile.limits.panDeg),
    // Animated tilt only. The mechanical mount angle is a transform applied by
    // the renderer between the fixture root and its pan axis (ADR-010), so it
    // must not consume the profile's tilt range here.
    tiltDeg: lerpRange(tiltNorm, profile.limits.tiltDeg),
    spreadDeg: lerpRange(zoomNorm, profile.beam.spreadDeg),
    focus: caps.focus ? values.focus : 0.5,
    strobeHz,
    strobeLevel,
    rotation: caps.rotation ? values.rotation : 0,
    ...(laser === undefined ? {} : { laser }),
    active: intensity > 0.001,
  };
}

/**
 * Pure, deterministic evaluation of the whole show at `timeSec`.
 * The renderer, scrubbing, and offline export all use this one function.
 */
export function evaluateFixtureStates(show: Show, timeSec: number): FixtureState[] {
  const states: FixtureState[] = [];

  for (const fixture of show.fixtures) {
    const clips: Clip[] = [];
    for (const track of show.tracks) {
      if (!track.fixtureIds.includes(fixture.id)) continue;
      clips.push(...track.clips);
    }
    states.push(evaluateFixture(fixture, clips, timeSec));
  }

  return states;
}
