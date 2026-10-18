import type {
  Clip,
  ControllableAttribute,
  Easing,
  FixturePlacement,
  FixtureState,
  Keyframe,
  Show,
} from './types';

const DEFAULTS: Record<ControllableAttribute, number> = {
  dimmer: 0,
  red: 1,
  green: 1,
  blue: 1,
  white: 0,
  pan: 0.5,
  tilt: 0.5,
  zoom: 0.15,
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
): { values: Record<ControllableAttribute, number>; fade: number; hasActiveClip: boolean } {
  const values: Record<ControllableAttribute, number> = { ...DEFAULTS };
  let fade = 1;
  let hasActiveClip = false;

  for (const clip of clips) {
    if (timeSec < clip.startSec || timeSec > clip.endSec) continue;
    if (clip.endSec <= clip.startSec) continue;
    hasActiveClip = true;

    const span = clip.endSec - clip.startSec;
    const t01 = clamp01((timeSec - clip.startSec) / span);
    const ease = EASINGS[clip.easing ?? 'linear'];
    const dimmerEnvelope = clip.attributes.dimmer;

    for (const [attribute, keyframes] of Object.entries(clip.attributes)) {
      if (keyframes === undefined || keyframes.length === 0) continue;
      values[attribute as ControllableAttribute] = clamp01(sampleKeyframes(keyframes, t01, ease));
    }

    if (dimmerEnvelope !== undefined && dimmerEnvelope.length > 0) {
      fade = fadeEnvelope(clip, timeSec);
    }
  }

  return { values, fade, hasActiveClip };
}

const lerpRange = (n: number, range: readonly [number, number]): number =>
  range[0] + (range[1] - range[0]) * n;

/** Attribute values for one fixture at one instant. Never mutates the show. */
export function evaluateFixture(
  fixture: FixturePlacement,
  clips: readonly Clip[],
  timeSec: number,
): FixtureState {
  const { values, fade, hasActiveClip } = resolveAttributes(clips, timeSec);
  const { profile } = fixture;
  const caps = profile.capabilities;

  const intensity = hasActiveClip ? (caps.dimmer ? values.dimmer * fade : fade) : 0;
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
  const strobe = caps.strobe ? values.strobe : 0;

  return {
    fixtureId: fixture.id,
    kind: profile.kind,
    intensity,
    color,
    panDeg: lerpRange(panNorm, profile.limits.panDeg),
    tiltDeg: lerpRange(tiltNorm, profile.limits.tiltDeg) + (fixture.pitchOffsetDeg ?? 0),
    spreadDeg: lerpRange(zoomNorm, profile.beam.spreadDeg),
    focus: caps.focus ? values.focus : 0.5,
    strobeHz: strobe > 0.001 ? lerpRange(strobe, profile.limits.strobeHz) : 0,
    rotation: caps.rotation ? values.rotation : 0,
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
