import { MOVING_HEAD, PAR, STROBE, WASH, LASER } from '@dmxsim/fixtures';
import type { Clip, FixturePlacement, Keyframe, Show, Vec3 } from '@dmxsim/show-model';
import { secondsPerBar, secondsPerBeat } from '@dmxsim/show-model';

/**
 * A hand-authored 16-bar loop. Doubles as the fixture for the
 * "choreography is data" architecture: the renderer only sees fixture states.
 * Clips are authored at absolute song time, starting on the loop's first
 * downbeat, so `evaluateFixtureStates(show, songTime)` stays pure (ADR-002).
 */

export const DEMO_BARS = 16;

interface Timing {
  beat: number;
  bar: number;
  /** Song time of the loop's first downbeat. */
  origin: number;
}

type Rgb = readonly [number, number, number];

const PALETTE: readonly Rgb[] = [
  [0.08, 0.35, 1.0], // blue
  [0.55, 0.08, 1.0], // violet
  [1.0, 0.1, 0.5], // magenta
  [0.05, 0.85, 0.8], // cyan
  [1.0, 0.42, 0.05], // amber
  [1.0, 0.08, 0.08], // red
];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const colorAttributes = (rgb: Rgb): Clip['attributes'] => ({
  red: [{ at: 0, value: rgb[0] }],
  green: [{ at: 0, value: rgb[1] }],
  blue: [{ at: 0, value: rgb[2] }],
});

const constAttr = (value: number): Keyframe[] => [{ at: 0, value }];

function fixture(
  id: string,
  profile: FixturePlacement['profile'],
  position: Vec3,
  yawDeg = 0,
  pitchOffsetDeg?: number,
): FixturePlacement {
  return { id, profile, position, yawDeg, ...(pitchOffsetDeg === undefined ? {} : { pitchOffsetDeg }) };
}

function movingHeadClips(index: number, of: number, timing: Timing): Clip[] {
  const clips: Clip[] = [];

  for (let seg = 0; seg < DEMO_BARS / 2; seg += 1) {
    const start = timing.origin + seg * 2 * timing.bar;
    const end = start + 2 * timing.bar;
    const dir = (seg + index) % 2 === 0 ? 1 : -1;
    const center = 0.5 + (index / Math.max(1, of - 1) - 0.5) * 0.08;
    const width = 0.13 + ((index + seg) % 3) * 0.03;

    const pan: Keyframe[] = [
      { at: 0, value: clamp01(center - dir * width) },
      { at: 0.5, value: clamp01(center + dir * width) },
      { at: 1, value: clamp01(center - dir * width) },
    ];

    const baseTilt = 0.6 + (index % 3) * 0.03;
    const tilt: Keyframe[] = [
      { at: 0, value: baseTilt },
      { at: 0.25, value: baseTilt + 0.13 },
      { at: 0.5, value: baseTilt - 0.05 },
      { at: 0.75, value: baseTilt + 0.13 },
      { at: 1, value: baseTilt },
    ];

    const beats = 8;
    const dimmer: Keyframe[] = [];
    for (let b = 0; b < beats; b += 1) {
      dimmer.push({ at: b / beats, value: b % 2 === 0 ? 1 : 0.5 + ((index + b) % 2) * 0.12 });
    }
    dimmer.push({ at: 1, value: 1 });

    const color = PALETTE[(seg + Math.floor(index / 2)) % PALETTE.length] ?? PALETTE[0]!;

    clips.push({
      id: `mh-${index}-${seg}`,
      startSec: start,
      endSec: end,
      easing: 'sine',
      attributes: {
        dimmer,
        pan,
        tilt,
        zoom: constAttr(0.1 + ((index + seg) % 4) * 0.04),
        ...colorAttributes(color),
      },
    });
  }

  return clips;
}

function washClips(index: number, timing: Timing): Clip[] {
  const clips: Clip[] = [];

  for (let seg = 0; seg < DEMO_BARS / 2; seg += 1) {
    const start = timing.origin + seg * 2 * timing.bar;
    const end = start + 2 * timing.bar;
    const dir = seg % 2 === 0 ? 1 : -1;
    const color = PALETTE[(seg + 3 + index) % PALETTE.length] ?? PALETTE[0]!;

    clips.push({
      id: `wash-${index}-${seg}`,
      startSec: start,
      endSec: end,
      easing: 'sine',
      attributes: {
        dimmer: [
          { at: 0, value: 0.08 },
          { at: 0.2, value: 0.55 },
          { at: 0.65, value: 0.3 },
          { at: 1, value: 0.08 },
        ],
        pan: [
          { at: 0, value: dir > 0 ? 0.32 : 0.68 },
          { at: 1, value: dir > 0 ? 0.68 : 0.32 },
        ],
        tilt: constAttr(0.55),
        zoom: constAttr(0.68),
        ...colorAttributes(color),
      },
    });
  }

  return clips;
}

function strobeClips(index: number, timing: Timing): Clip[] {
  const clips: Clip[] = [];

  for (let b = 0; b < DEMO_BARS; b += 1) {
    const start = timing.origin + b * timing.bar;
    clips.push({
      id: `strobe-${index}-${b}`,
      startSec: start,
      endSec: start + timing.beat * 0.18,
      easing: 'step',
      fadeOutSec: 0.035,
      attributes: {
        dimmer: constAttr(1),
        strobe: constAttr(0.75),
        red: constAttr(1),
        green: constAttr(1),
        blue: constAttr(1),
      },
    });
  }

  return clips;
}

function laserClips(index: number, timing: Timing): Clip[] {
  const clips: Clip[] = [];

  for (let seg = 0; seg < DEMO_BARS; seg += 1) {
    const start = timing.origin + seg * timing.bar;
    const end = start + timing.bar;
    const steps = 32;
    const pan: Keyframe[] = [];
    const tilt: Keyframe[] = [];

    for (let s = 0; s <= steps; s += 1) {
      const at = s / steps;
      const wave = Math.sin((at * Math.PI * 2 + seg * 0.7 + index * 1.9) * 2);
      pan.push({ at, value: clamp01(0.5 + wave * 0.32) });
      tilt.push({ at, value: 0.58 + Math.sin(at * Math.PI * 4 + seg) * 0.1 });
    }

    const color = seg % 4 < 2 ? ([0.05, 1.0, 0.35] as const) : ([0.1, 0.5, 1.0] as const);

    clips.push({
      id: `laser-${index}-${seg}`,
      startSec: start,
      endSec: end,
      attributes: {
        dimmer: [
          { at: 0, value: 0.9 },
          { at: 0.07, value: 0.25 },
          { at: 0.2, value: 0.95 },
          { at: 0.9, value: 0.75 },
        ],
        pan,
        tilt,
        ...colorAttributes(color),
      },
    });
  }

  return clips;
}

function parClips(index: number, timing: Timing): Clip[] {
  const clips: Clip[] = [];

  for (let b = 0; b < DEMO_BARS; b += 1) {
    const start = timing.origin + b * timing.bar;
    const color = b % 2 === 0 ? PALETTE[4]! : PALETTE[2]!;

    clips.push({
      id: `par-${index}-${b}`,
      startSec: start,
      endSec: start + timing.bar,
      easing: 'sine',
      attributes: {
        dimmer: [
          { at: 0, value: 0.95 },
          { at: 0.22, value: 0.25 },
          { at: 1, value: 0.3 },
        ],
        zoom: constAttr(0.45),
        ...colorAttributes(color),
      },
    });
  }

  return clips;
}

export function createDemoShow(startSec: number, bpm: number): Show {
  const grid = { bpm, offsetSec: startSec, beatsPerBar: 4 };
  const timing: Timing = { beat: secondsPerBeat(grid), bar: secondsPerBar(grid), origin: startSec };
  const fixtures: FixturePlacement[] = [];
  const tracks: Show['tracks'] = [];

  const add = (placement: FixturePlacement, clips: Clip[]) => {
    fixtures.push(placement);
    tracks.push({
      id: `track-${placement.id}`,
      name: placement.id,
      fixtureIds: [placement.id],
      clips,
    });
  };

  const frontHeads = 10;
  for (let i = 0; i < frontHeads; i += 1) {
    const x = -8.1 + (16.2 * i) / (frontHeads - 1);
    add(
      fixture(`mh-front-${i}`, MOVING_HEAD, { x, y: 7.4, z: 1.6 }, (i / (frontHeads - 1) - 0.5) * 24),
      movingHeadClips(i, frontHeads, timing),
    );
  }

  const rearHeads = 6;
  for (let i = 0; i < rearHeads; i += 1) {
    const x = -6.4 + (12.8 * i) / (rearHeads - 1);
    add(
      fixture(`mh-rear-${i}`, MOVING_HEAD, { x, y: 7.4, z: -5.6 }, (i / (rearHeads - 1) - 0.5) * -30),
      movingHeadClips(i + frontHeads, frontHeads + rearHeads, timing),
    );
  }

  const washes = 6;
  for (let i = 0; i < washes; i += 1) {
    const x = -7 + (14 * i) / (washes - 1);
    add(fixture(`wash-${i}`, WASH, { x, y: 7.5, z: -2.0 }, (i / (washes - 1) - 0.5) * 20), washClips(i, timing));
  }

  const strobes = 4;
  for (let i = 0; i < strobes; i += 1) {
    const x = i < 2 ? -9.2 : 9.2;
    const z = i % 2 === 0 ? 2.4 : -1.0;
    add(fixture(`strobe-${i}`, STROBE, { x, y: 6.6, z }, 0), strobeClips(i, timing));
  }

  const lasers = 2;
  for (let i = 0; i < lasers; i += 1) {
    add(fixture(`laser-${i}`, LASER, { x: i === 0 ? -1.4 : 1.4, y: 7.5, z: -5.6 }, 0), laserClips(i, timing));
  }

  const pars = 4;
  const parX = [-7.5, -3.2, 3.2, 7.5];
  for (let i = 0; i < pars; i += 1) {
    add(fixture(`par-${i}`, PAR, { x: parX[i]!, y: 0.7, z: -2.6 }, 0, 168), parClips(i, timing));
  }

  return {
    version: 1,
    name: `Spike — ${DEMO_BARS} bar loop`,
    beatGrid: grid,
    fixtures,
    tracks,
  };
}
