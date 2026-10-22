import { describe, expect, it } from 'vitest';
import type { FixturePlacement } from '@dmxsim/show-model';
import {
  FALLBACK_PAN_TILT,
  SWEEP_RATE_BOUNDS,
  cueLength,
  degFromNorm,
  formatHz,
  normFromDeg,
  rateBounds,
  strobeRateFor,
  sweepFor,
  sweepRateFor,
  timingSummary,
} from './clip-timing';
import type { Cue } from './types';

const cue = (overrides: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  fixtureId: 'head-1',
  startSec: 0,
  endSec: 2,
  colorIndex: 0,
  action: 'hold',
  ...overrides,
});

/** Only the profile limits are read here, so the rest of the placement is not modelled. */
const fixtureWith = (strobeHz: [number, number]): FixturePlacement => ({
  profile: { limits: { panDeg: [-270, 270], tiltDeg: [-135, 135], strobeHz } },
}) as unknown as FixturePlacement;

describe('formatHz', () => {
  it('drops the decimal on whole rates and keeps one otherwise', () => {
    expect(formatHz(8)).toBe('8 Hz');
    expect(formatHz(7.5)).toBe('7.5 Hz');
    expect(formatHz(1 / 3)).toBe('0.3 Hz');
  });
});

describe('cueLength', () => {
  it('never returns zero, so it is safe as a divisor', () => {
    expect(cueLength(cue({ startSec: 4, endSec: 7 }))).toBe(3);
    expect(cueLength(cue({ startSec: 4, endSec: 4 }))).toBe(0.001);
  });
});

describe('strobeRateFor', () => {
  it('prefers an explicit rate on the cue', () => {
    expect(strobeRateFor(cue({ action: 'strobe', strobe: { hz: 12 } }), null)).toBe(12);
  });

  it('falls back to the profile range, biased toward the fast end', () => {
    // 78% of 1..30 → 23.62 Hz.
    expect(strobeRateFor(cue({ action: 'strobe' }), fixtureWith([1, 30]))).toBeCloseTo(23.62);
  });
});

describe('normFromDeg / degFromNorm', () => {
  const range: [number, number] = [-270, 270];

  it('maps the range ends to 0..1 and back', () => {
    expect(normFromDeg(-270, range)).toBe(0);
    expect(normFromDeg(270, range)).toBe(1);
    expect(degFromNorm(0.5, range)).toBe(0);
  });

  it('clamps values outside the physical range', () => {
    expect(normFromDeg(-500, range)).toBe(0);
    expect(normFromDeg(500, range)).toBe(1);
    expect(degFromNorm(-1, range)).toBe(-270);
    expect(degFromNorm(2, range)).toBe(270);
  });
});

describe('sweepFor', () => {
  it('fills every optional field from the defaults', () => {
    expect(sweepFor(cue({ action: 'sweep' }))).toEqual({
      phase: 0,
      panCenter: 0.5,
      panRange: 0.35,
      tiltCenter: 0.54,
      tiltRange: 0.12,
    });
  });

  it('keeps the cue overrides', () => {
    expect(sweepFor(cue({ action: 'sweep', sweep: { phase: 0.25, hz: 2 } }))).toMatchObject({
      phase: 0.25,
      hz: 2,
      panCenter: 0.5,
    });
  });
});

describe('sweepRateFor', () => {
  it('uses the explicit rate when present', () => {
    expect(sweepRateFor(cue({ sweep: { hz: 0.5 } }))).toBe(0.5);
  });

  it('otherwise plays one cycle per clip', () => {
    expect(sweepRateFor(cue({ startSec: 0, endSec: 4 }))).toBe(0.25);
  });
});

describe('rateBounds', () => {
  it('follows the profile for strobes', () => {
    expect(rateBounds(cue({ action: 'strobe' }), fixtureWith([2, 18]))).toEqual([2, 18]);
  });

  it('falls back to the generic strobe range with no fixture', () => {
    expect(rateBounds(cue({ action: 'strobe' }), null)).toEqual([1, 30]);
  });

  it('treats a pulse as a dimmer pattern rather than a strobe channel', () => {
    expect(rateBounds(cue({ action: 'pulse' }), fixtureWith([2, 18]))).toEqual([0.5, 20]);
  });
});

describe('timingSummary', () => {
  it('summarises a strobe at its resolved rate', () => {
    expect(timingSummary(cue({ action: 'strobe', strobe: { hz: 8 } }), null)).toBe('Strobe 8 Hz ▾');
  });

  it('summarises a pulse, defaulting to four hits across the clip', () => {
    expect(timingSummary(cue({ action: 'pulse', startSec: 0, endSec: 2 }), null)).toBe('Pulse 2 Hz ▾');
  });

  it('shows a sweep rate plus its phase offset only when set', () => {
    expect(timingSummary(cue({ action: 'sweep', sweep: { hz: 1 } }), null)).toBe('Sweep 1 Hz ▾');
    expect(timingSummary(cue({ action: 'sweep', sweep: { hz: 1, phase: 0.25 } }), null))
      .toBe('Sweep 1 Hz · 25% ▾');
  });

  it('marks an aim as travelling only when it ends somewhere else', () => {
    const fixed = cue({ action: 'aim' });
    expect(timingSummary(fixed, fixtureWith([1, 30]))).toBe('Aim 0° / 0° ▾');

    const travelling = cue({ action: 'aim', aim: { pan: 0.5, tilt: 0, toTilt: 1 } });
    // Tilt maps -135..135, so 0 → -135 and 1 → 135.
    expect(timingSummary(travelling, fixtureWith([1, 30]))).toBe('Aim 0° / -135° → 0° / 135°');
  });

  it('falls back to the shared pan/tilt range with no fixture', () => {
    const mid = cue({ action: 'aim', aim: { pan: 0.5, tilt: 0.5 } });
    expect(timingSummary(mid, null)).toBe('Aim 0° / 0° ▾');
    expect(FALLBACK_PAN_TILT.panDeg).toEqual([-270, 270]);
  });

  it('labels the fade actions generically', () => {
    expect(timingSummary(cue({ action: 'fade' }), null)).toBe('Fades ▾');
    expect(timingSummary(cue({ action: 'hold' }), null)).toBe('Fades ▾');
  });

  it('keeps sweep rates inside their bounds', () => {
    expect(SWEEP_RATE_BOUNDS).toEqual([0.05, 4]);
  });
});
