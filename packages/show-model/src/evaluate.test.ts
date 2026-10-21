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

  it('moves pan on a sweep wave and honours an explicit rate', () => {
    // hz: 1 means a full cycle per second regardless of the 10 s clip length.
    const sweeping = clip({ sweep: { hz: 1 } });
    // The cycle starts at the trough (centre - range), like the legacy shape.
    expect(evaluateFixture(fixture, [sweeping], 10).panDeg).toBeCloseTo(-270 + 0.15 * 540, 5);
    // A quarter cycle later it is at the centre.
    expect(evaluateFixture(fixture, [sweeping], 10.25).panDeg).toBeCloseTo(0, 5);
    // Half a cycle later it is at the peak.
    expect(evaluateFixture(fixture, [sweeping], 10.5).panDeg).toBeCloseTo(0.85 * 540 - 270, 5);
  });

  it('offsets grouped heads with a phase instead of letting them align', () => {
    const aligned = clip({ sweep: { hz: 1, phase: 0 } });
    const offset = clip({ id: 'clip-2', sweep: { hz: 1, phase: 0.5 } });
    const at = evaluateFixture(fixture, [aligned], 10).panDeg;
    const against = evaluateFixture(fixture, [offset], 10).panDeg;
    // A half-cycle phase puts one head at the opposite end of the swing.
    expect(Math.abs(at - against)).toBeGreaterThan(300);
    // Both clips stay on the same wave: the offset one reaches the same value
    // half a cycle later.
    expect(evaluateFixture(fixture, [offset], 10.5).panDeg).toBeCloseTo(at, 5);
  });

  it('keeps the sweep speed when the clip length changes', () => {
    const short = clip({ endSec: 11, sweep: { hz: 0.5 } });
    const long = clip({ endSec: 19, sweep: { hz: 0.5 } });
    expect(evaluateFixture(fixture, [short], 10.5).panDeg)
      .toBeCloseTo(evaluateFixture(fixture, [long], 10.5).panDeg, 5);
  });

  it('falls back to one cycle across the clip when no rate is given', () => {
    const legacy = clip({ sweep: {} });
    const state = evaluateFixture(fixture, [legacy], 15);
    // Halfway through a 10 s clip is the peak of the single cycle.
    expect(state.panDeg).toBeCloseTo(0.85 * 540 - 270, 5);
  });

  it('holds a static aim on pan and tilt for the whole clip', () => {
    const aimed = clip({ aim: { pan: 0.5, tilt: 0.75 } });
    expect(evaluateFixture(fixture, [aimed], 10).tiltDeg).toBeCloseTo(67.5);
    expect(evaluateFixture(fixture, [aimed], 19).tiltDeg).toBeCloseTo(67.5);
    expect(evaluateFixture(fixture, [aimed], 15).panDeg).toBeCloseTo(0);
  });

  it('lets a static aim win over authored pan/tilt keyframes', () => {
    const aimed = clip({
      aim: { pan: 0.25, tilt: 0.5 },
      attributes: {
        pan: [{ at: 0, value: 0.9 }],
        tilt: [{ at: 0, value: 0.9 }],
      },
    });
    const state = evaluateFixture(fixture, [aimed], 15);
    expect(state.panDeg).toBeCloseTo(0.25 * 540 - 270, 5);
    expect(state.tiltDeg).toBeCloseTo(0);
  });

  it('travels from the start aim to the end aim and then holds', () => {
    // Tilt 0.25 -> 0.75 across a 10 s clip: a slow descent over the crowd.
    const descending = clip({ aim: { pan: 0.5, tilt: 0.25, toTilt: 0.75 } });
    const start = evaluateFixture(fixture, [descending], 10).tiltDeg;
    const middle = evaluateFixture(fixture, [descending], 15).tiltDeg;
    const end = evaluateFixture(fixture, [descending], 20).tiltDeg;
    const after = evaluateFixture(fixture, [descending], 19.999).tiltDeg;

    expect(start).toBeCloseTo(-67.5, 5);
    expect(end).toBeCloseTo(67.5, 5);
    // Sine easing puts the midpoint at the middle of the travel, not at an end.
    expect(middle).toBeCloseTo(0, 5);
    expect(after).toBeCloseTo(end, 3);
    // Pan did not move: only the tilt was given an end pose.
    expect(evaluateFixture(fixture, [descending], 15).panDeg).toBeCloseTo(0, 5);
  });

  it('honours an explicit travel time and then holds', () => {
    const quick = clip({ aim: { pan: 0.5, tilt: 0.25, toTilt: 0.75, travelSec: 2 } });
    // The move finishes at 12 s and stays put for the rest of the 10 s clip.
    expect(evaluateFixture(fixture, [quick], 12).tiltDeg).toBeCloseTo(67.5, 5);
    expect(evaluateFixture(fixture, [quick], 17).tiltDeg).toBeCloseTo(67.5, 5);
    expect(evaluateFixture(fixture, [quick], 11).tiltDeg).toBeLessThan(67.5);
  });

  it('eases the travel with the requested curve', () => {
    const linear = clip({ aim: { pan: 0.5, tilt: 0, toTilt: 1, easing: 'linear' } });
    // Halfway through the clip a linear travel has crossed half the range.
    expect(evaluateFixture(fixture, [linear], 15).tiltDeg).toBeCloseTo(0, 5);
    // `tilt: 0` maps to -135 and `toTilt: 1` to +135, so half is 0.
    const snapped = clip({ aim: { pan: 0.5, tilt: 0, toTilt: 1, easing: 'step' } });
    // `step` holds the start pose for the whole travel and snaps at its end.
    expect(evaluateFixture(fixture, [snapped], 19.9).tiltDeg).toBeCloseTo(-135, 5);
    expect(evaluateFixture(fixture, [snapped], 20).tiltDeg).toBeCloseTo(135, 5);
  });

  it('lets an explicit sweep override a static aim on the same clip', () => {
    const both = clip({ aim: { pan: 0.5, tilt: 0.5 }, sweep: { hz: 1 } });
    const sweeping = clip({ sweep: { hz: 1 } });
    expect(evaluateFixture(fixture, [both], 10).panDeg)
      .toBeCloseTo(evaluateFixture(fixture, [sweeping], 10).panDeg, 5);
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
