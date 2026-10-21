import { describe, expect, it } from 'vitest';
import { DEFAULT_LASER_SETUP, barToTime, evaluateFixture, evaluateFixtureStates, resolveLaser, secondsPerBeat, snapToGrid, strobeGate, timeToBeat } from './index';
import type { Clip, FixtureProfile, FixturePlacement, Show } from './index';

const profile: FixtureProfile = {
  id: 'test-head',
  name: 'Test Head',
  kind: 'moving-head',
  channels: ['pan', 'panFine', 'tilt', 'tiltFine', 'dimmer', 'red', 'green', 'blue', 'strobe'],
  capabilities: {
    dimmer: true,
    color: 'rgb',
    panTilt: true,
    zoom: false,
    focus: false,
    strobe: true,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [-270, 270],
    tiltDeg: [-135, 135],
    strobeHz: [1, 25],
  },
  beam: { spreadDeg: [6, 45], apertureDiameterM: 0.12, throwM: 12 },
};

const fixture: FixturePlacement = {
  id: 'fx-1',
  profile,
  position: { x: 0, y: 8, z: 0 },
  yawDeg: 0,
};

const clip = (overrides: Partial<Clip> = {}): Clip => ({
  id: 'clip-1',
  startSec: 10,
  endSec: 20,
  attributes: {
    dimmer: [{ at: 0, value: 0.25 }, { at: 1, value: 1 }],
    red: [{ at: 0, value: 1 }],
    green: [{ at: 0, value: 0 }],
    blue: [{ at: 0, value: 0 }],
  },
  ...overrides,
});

describe('beat grid', () => {
  it('converts beats and bars to seconds', () => {
    const grid = { bpm: 120, offsetSec: 0, beatsPerBar: 4 };
    expect(secondsPerBeat(grid)).toBeCloseTo(0.5);
    expect(barToTime(grid, 2)).toBeCloseTo(4);
    expect(timeToBeat(grid, 1.25)).toBeCloseTo(2.5);
  });

  it('snaps to the nearest grid division', () => {
    const grid = { bpm: 120, offsetSec: 0, beatsPerBar: 4 };
    expect(snapToGrid(grid, 0.13, 4)).toBeCloseTo(0.125);
    expect(snapToGrid(grid, 0.6, 4)).toBeCloseTo(0.625);
  });

  it('honours the audio offset', () => {
    const grid = { bpm: 120, offsetSec: 0.25, beatsPerBar: 4 };
    expect(timeToBeat(grid, 0.75)).toBeCloseTo(1);
  });
});

describe('evaluateFixture', () => {
  it('returns silence outside every clip', () => {
    const state = evaluateFixture(fixture, [clip()], 5);
    expect(state.intensity).toBe(0);
    expect(state.active).toBe(false);
  });

  it('interpolates envelopes linearly', () => {
    const state = evaluateFixture(fixture, [clip()], 15);
    expect(state.intensity).toBeCloseTo(0.625);
    expect(state.color).toEqual({ r: 1, g: 0, b: 0 });
  });

  it('applies fade in and out to the dimmer', () => {
    const faded = clip({ fadeInSec: 2, fadeOutSec: 2 });
    expect(evaluateFixture(fixture, [faded], 11).intensity).toBeCloseTo(0.5 * 0.325, 5);
    expect(evaluateFixture(fixture, [faded], 19).intensity).toBeCloseTo(0.5 * 0.925, 5);
  });

  it('maps normalized values into physical units', () => {
    const centered = evaluateFixture(
      fixture,
      [clip({ attributes: { pan: [{ at: 0, value: 0.5 }], tilt: [{ at: 0, value: 0.75 }] } })],
      15,
    );
    expect(centered.panDeg).toBeCloseTo(0);
    expect(centered.tiltDeg).toBeCloseTo(67.5);

    const strobing = evaluateFixture(
      fixture,
      [clip({ attributes: { dimmer: [{ at: 0, value: 1 }], strobe: [{ at: 0, value: 0.5 }] } })],
      15,
    );
    expect(strobing.strobeHz).toBeCloseTo(13);
  });

  it('lets a later clip win per attribute', () => {
    const base = clip({ attributes: { dimmer: [{ at: 0, value: 0.2 }] } });
    const override = clip({ id: 'clip-2', startSec: 12, endSec: 14, attributes: { dimmer: [{ at: 0, value: 0.9 }] } });
    expect(evaluateFixture(fixture, [base, override], 13).intensity).toBeCloseTo(0.9);
    expect(evaluateFixture(fixture, [base, override], 11).intensity).toBeCloseTo(0.2);
  });

  it('shapes the strobe gate with attack and release ramps', () => {
    /* The lamp is lit for the first half of each cycle: a ramp up, a hold and
     * a ramp down, then the off gap. */
    expect(strobeGate(0.25, { attack: 0, release: 0 })).toBeCloseTo(1);
    expect(strobeGate(0.55, { attack: 0, release: 0 })).toBeCloseTo(0);
    expect(strobeGate(0.1, { attack: 0.2, release: 0 })).toBeCloseTo(0.5);
    expect(strobeGate(0.45, { attack: 0, release: 0.2 })).toBeCloseTo(0.25);
  });

  it('keeps a level between flashes when a depth is set', () => {
    expect(strobeGate(0.8, { depth: 0.3 })).toBeCloseTo(0.3);
    expect(strobeGate(0.2, { depth: 0.3 })).toBeCloseTo(1);
  });

  it('overrides the channel rate with an explicit strobe Hz', () => {
    const strobing = clip({
      attributes: { dimmer: [{ at: 0, value: 1 }], strobe: [{ at: 0, value: 0.5 }] },
      strobe: { hz: 8, attack: 0, release: 0 },
    });
    const on = evaluateFixture(fixture, [strobing], 15);
    expect(on.strobeHz).toBeCloseTo(8);
    expect(on.strobeLevel).toBeCloseTo(1);
    // Half a cycle later the lamp is in its off gap.
    const off = evaluateFixture(fixture, [strobing], 15 + 0.5 / 8);
    expect(off.strobeLevel).toBeCloseTo(0);
  });

  it('clamps an over-range strobe rate to the profile limits', () => {
    const strobing = clip({
      attributes: { dimmer: [{ at: 0, value: 1 }] },
      strobe: { hz: 200 },
    });
    expect(evaluateFixture(fixture, [strobing], 15).strobeHz).toBeCloseTo(25);
  });

  it('does not strobe when the clip has no strobe signal', () => {
    expect(evaluateFixture(fixture, [clip()], 15).strobeLevel).toBe(1);
  });
});

describe('fixture defaults', () => {
  const withDefaults: FixturePlacement = {
    ...fixture,
    defaults: {
      dimmer: 0.4,
      red: 0,
      green: 0,
      blue: 1,
      pan: 0.25,
      tilt: 0.75,
    },
  };

  it('holds the setup values when no clip is active', () => {
    const state = evaluateFixture(withDefaults, [clip()], 5);
    expect(state.intensity).toBeCloseTo(0.4);
    expect(state.color).toEqual({ r: 0, g: 0, b: 1 });
    expect(state.panDeg).toBeCloseTo(-135);
    expect(state.tiltDeg).toBeCloseTo(67.5);
    expect(state.active).toBe(true);
  });

  it('lets clip envelopes override the setup layer', () => {
    const state = evaluateFixture(withDefaults, [clip()], 15);
    expect(state.intensity).toBeCloseTo(0.625);
    expect(state.color).toEqual({ r: 1, g: 0, b: 0 });
  });

  it('applies the default level to clips that only set colour', () => {
    const colorOnly = clip({ attributes: { red: [{ at: 0, value: 1 }] } });
    expect(evaluateFixture(withDefaults, [colorOnly], 15).intensity).toBeCloseTo(0.4);
  });
});

describe('mechanical mount angle', () => {
  it('does not consume the animated tilt range', () => {
    const upright: FixturePlacement = { ...fixture, pitchOffsetDeg: 0 };
    const uplight: FixturePlacement = { ...fixture, pitchOffsetDeg: 168 };

    // Same clip, same profile: the mount angle is a transform, so the tilt
    // value must be identical or an angled fixture loses part of its range.
    const tilt = [{ at: 0, value: 1 }];
    const uprightState = evaluateFixture(upright, [clip({ attributes: { tilt } })], 12);
    const uplightState = evaluateFixture(uplight, [clip({ attributes: { tilt } })], 12);
    expect(uplightState.tiltDeg).toBeCloseTo(uprightState.tiltDeg);
    expect(uplightState.tiltDeg).toBeCloseTo(135);
  });

  it('still reports full tilt travel at the limits', () => {
    const mounted: FixturePlacement = { ...fixture, pitchOffsetDeg: 168 };
    const low = evaluateFixture(mounted, [clip({ attributes: { tilt: [{ at: 0, value: 0 }] } })], 12);
    const high = evaluateFixture(mounted, [clip({ attributes: { tilt: [{ at: 0, value: 1 }] } })], 12);
    expect(low.tiltDeg).toBeCloseTo(-135);
    expect(high.tiltDeg).toBeCloseTo(135);
  });
});

describe('evaluateFixtureStates', () => {
  const show: Show = {
    version: 1,
    name: 'test',
    beatGrid: { bpm: 128, offsetSec: 0, beatsPerBar: 4 },
    fixtures: [fixture],
    tracks: [{ id: 'track-1', name: 'Track 1', fixtureIds: ['fx-1'], clips: [clip()] }],
  };

  it('evaluates every fixture in the show', () => {
    const states = evaluateFixtureStates(show, 15);
    expect(states).toHaveLength(1);
    expect(states[0]?.fixtureId).toBe('fx-1');
    expect(states[0]?.intensity).toBeCloseTo(0.625);
  });
});

describe('laser evaluation', () => {
  const limits = { maxBeams: 16, patterns: ['fan', 'tunnel'] as const, fanDeg: [0, 90] as [number, number] };

  it('falls back to the documented defaults', () => {
    const laser = resolveLaser(undefined, undefined, 0, 0);
    expect(laser).toEqual({
      beams: DEFAULT_LASER_SETUP.beams,
      pattern: DEFAULT_LASER_SETUP.pattern,
      fanDeg: DEFAULT_LASER_SETUP.fanDeg,
      divergenceDeg: DEFAULT_LASER_SETUP.divergenceDeg,
      speedHz: DEFAULT_LASER_SETUP.speedHz,
      // `phaseDeg` is setup, folded into the resolved phase.
      phase: 0,
    });
  });

  it('clamps beam count and fan width to the profile limits', () => {
    const laser = resolveLaser({ beams: 500, pattern: 'fan', fanDeg: 400, divergenceDeg: 1, speedHz: 0, phaseDeg: 0 }, limits, 0, 0);
    expect(laser.beams).toBe(16);
    expect(laser.fanDeg).toBe(90);

    const tiny = resolveLaser({ beams: 0, pattern: 'fan', fanDeg: -10, divergenceDeg: 1, speedHz: 0, phaseDeg: 0 }, limits, 0, 0);
    expect(tiny.beams).toBe(1);
    expect(tiny.fanDeg).toBe(0);
  });

  it('advances and wraps scanner phase, and offsets it by rotation', () => {
    const staticSetup = { ...DEFAULT_LASER_SETUP, speedHz: 1, phaseDeg: 0 };
    expect(resolveLaser(staticSetup, limits, 0, 0).phase).toBeCloseTo(0);
    expect(resolveLaser(staticSetup, limits, 0.5, 0).phase).toBeCloseTo(Math.PI);
    expect(resolveLaser(staticSetup, limits, 1, 0).phase).toBeCloseTo(0);
    expect(resolveLaser(staticSetup, limits, 0, 0.25).phase).toBeCloseTo(Math.PI / 2);
  });

  it('exposes laser state on laser fixtures only', () => {
    const laserFixture: FixturePlacement = {
      id: 'laser-1',
      profile: { ...profile, kind: 'laser', laser: limits },
      position: { x: 0, y: 8, z: 0 },
      yawDeg: 0,
      laser: { ...DEFAULT_LASER_SETUP, beams: 12 },
    };
    expect(evaluateFixture(laserFixture, [], 0).laser?.beams).toBe(12);
    expect(evaluateFixture(fixture, [], 0).laser).toBeUndefined();
  });
});
