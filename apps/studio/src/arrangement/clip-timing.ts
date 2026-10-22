import { DEFAULT_AIM, DEFAULT_SWEEP } from '@dmxsim/show-model';
import type { FixturePlacement, SweepSettings } from '@dmxsim/show-model';
import { clamp } from '../lib/math';
import type { Cue } from './types';

/**
 * Pure timing maths for the clip popover: rates, sweeps and aims. Everything
 * here is a function of the cue and its fixture profile, so it can be unit
 * tested without a DOM.
 */

/** Rate range used when the selected fixture's profile declares none. */
const FALLBACK_STROBE_HZ: [number, number] = [1, 30];

/** One decimal only when the rate is not a whole number, so 8 Hz stays "8". */
export const formatHz = (hz: number): string => {
  const rounded = Math.round(hz * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} Hz`;
};

/** The rate a strobe cue plays at, including the legacy channel fallback. */
export const strobeRateFor = (cue: Cue, fixture: FixturePlacement | null): number => {
  const [min, max] = fixture?.profile.limits.strobeHz ?? FALLBACK_STROBE_HZ;
  return cue.strobe?.hz ?? min + (max - min) * 0.78;
};

export const cueLength = (cue: Cue): number => Math.max(0.001, cue.endSec - cue.startSec);

/** Normalized 0..1 <-> degrees within a profile's physical limits. */
export const normFromDeg = (deg: number, range: readonly [number, number]): number =>
  clamp((deg - range[0]) / Math.max(1e-9, range[1] - range[0]), 0, 1);
export const degFromNorm = (norm: number, range: readonly [number, number]): number =>
  range[0] + clamp(norm, 0, 1) * (range[1] - range[0]);

/** Pan/tilt limits used when no fixture is selected. */
export const FALLBACK_PAN_TILT = { panDeg: [-270, 270], tiltDeg: [-135, 135] } as const;

/** Fully resolved sweep settings for a cue; absent fields use the defaults. */
export const sweepFor = (cue: Cue): Required<Omit<SweepSettings, 'hz'>> & { hz?: number } =>
  ({ ...DEFAULT_SWEEP, ...(cue.sweep ?? {}) });

/** Movement rate: explicit Hz, else the legacy one cycle across the clip. */
export const sweepRateFor = (cue: Cue): number => cue.sweep?.hz ?? 1 / cueLength(cue);

/** Rate range: strobes follow the profile; a pulse is just a dimmer pattern. */
export const rateBounds = (cue: Cue, fixture: FixturePlacement | null): [number, number] =>
  cue.action === 'strobe'
    ? fixture?.profile.limits.strobeHz ?? FALLBACK_STROBE_HZ
    : [0.5, 20];

/** Sweep rate bounds, in cycles per second. */
export const SWEEP_RATE_BOUNDS: [number, number] = [0.05, 4];

/** Summary shown on the single toolbar button. */
export const timingSummary = (cue: Cue, fixture: FixturePlacement | null): string => {
  if (cue.action === 'strobe') return `Strobe ${formatHz(strobeRateFor(cue, fixture))} ▾`;
  if (cue.action === 'pulse') return `Pulse ${formatHz(cue.pulseHz ?? 4 / cueLength(cue))} ▾`;
  if (cue.action === 'aim') {
    const aim = cue.aim ?? DEFAULT_AIM;
    const limits = fixture?.profile.limits ?? FALLBACK_PAN_TILT;
    const panDeg = Math.round(degFromNorm(aim.pan, limits.panDeg));
    const tiltDeg = Math.round(degFromNorm(aim.tilt, limits.tiltDeg));
    const toPanDeg = Math.round(degFromNorm(aim.toPan ?? aim.pan, limits.panDeg));
    const toTiltDeg = Math.round(degFromNorm(aim.toTilt ?? aim.tilt, limits.tiltDeg));
    const travels = toPanDeg !== panDeg || toTiltDeg !== tiltDeg;
    return travels
      ? `Aim ${panDeg}° / ${tiltDeg}° → ${toPanDeg}° / ${toTiltDeg}°`
      : `Aim ${panDeg}° / ${tiltDeg}° ▾`;
  }
  if (cue.action === 'sweep') {
    const phase = Math.round((cue.sweep?.phase ?? 0) * 100);
    return `Sweep ${formatHz(sweepRateFor(cue))}${phase > 0 ? ` · ${phase}%` : ''} ▾`;
  }
  return 'Fades ▾';
};
