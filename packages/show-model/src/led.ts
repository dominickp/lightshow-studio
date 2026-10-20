/**
 * LED wall content model.
 *
 * A wall is a *surface*, not a fixture: it has no DMX personality and cannot
 * be evaluated by `evaluateFixture`. Its clips carry a procedural look plus
 * the parameters that look needs, so the same data can be rendered live or
 * exported later. Everything here is renderer-agnostic (ADR-006); the TSL
 * graphs that turn a look into pixels live in the app.
 */

export const LED_LOOK_KINDS = [
  'solid',
  'gradient',
  'wave',
  'radial',
  'noise',
  'grid',
  'scan',
  /** Accepted for older v3 projects; not exposed in the editor. */
  'dots',
  'blackout',
] as const;

export type LedLookKind = (typeof LED_LOOK_KINDS)[number];

export const LED_SYNCS = ['none', 'beat', 'bar'] as const;

/** Which part of the beat grid modulates the look's speed. */
export type LedSync = (typeof LED_SYNCS)[number];

/**
 * One procedural look instance. Values are deliberately physical/visual, not
 * normalised DMX values: a wall is media, and "speed 0.4 Hz" is more useful to
 * a user than "channel 137".
 */
export interface LedLookState {
  kind: LedLookKind;
  /** 1-4 sRGB hex stops, `#rrggbb`. */
  colors: string[];
  /** Cycles per second multiplier. */
  speed: number;
  /** Spatial frequency multiplier. */
  scale: number;
  /** Pattern rotation in degrees. */
  angleDeg: number;
  /** Edge softness / blur, 0..1. */
  softness: number;
  /** Output level, 0..1. */
  intensity: number;
  /** Deterministic variation, so noise/grid looks are reproducible. */
  seed: number;
  sync: LedSync;
}

/** Physical + calibration properties of one wall. */
export interface LedSurface {
  id: string;
  name: string;
  /** Panel dimensions in metres. */
  widthM: number;
  heightM: number;
  /** Centre height and depth in world metres. */
  y: number;
  z: number;
  /** LED pitch in millimetres (3.9 = P3.9). */
  pitchMm: number;
  /** Share of each pixel cell that is dark gap, 0..1. */
  gap: number;
  /** Panel brightness multiplier. */
  brightness: number;
  /** Emitted floor level when the look is black, 0..1. */
  blackLevel: number;
  /** Display gamma applied to the look output. */
  gamma: number;
  /** How strongly the wall lights the room, 0..1. */
  emit: number;
}

/** A look playing on a wall over a time range. */
export interface LedSurfaceClip {
  id: string;
  surfaceId: string;
  startSec: number;
  endSec: number;
  look: LedLookState;
  /** Blend weight against whatever is underneath, 0..1. */
  opacity: number;
  fadeInSec?: number;
}

/** Wall geometry declared by a venue template. */
export interface LedWallFeature {
  width: number;
  height: number;
  y: number;
  z: number;
}

/** Calibration defaults for a new wall. */
export const DEFAULT_LED_SURFACE: Omit<LedSurface, 'id' | 'name' | 'widthM' | 'heightM' | 'y' | 'z'> = {
  pitchMm: 10,
  /** Dark share of a diode cell; a quarter-cell gap keeps the grid legible. */
  gap: 0.25,
  brightness: 1,
  blackLevel: 0.015,
  gamma: 2.2,
  emit: 0.35,
};

const LOOK_DEFAULTS: Record<LedLookKind, Omit<LedLookState, 'kind'>> = {
  solid: { colors: ['#397cff'], speed: 0, scale: 1, angleDeg: 0, softness: 0.2, intensity: 1, seed: 1, sync: 'none' },
  gradient: {
    colors: ['#1b0b4d', '#ff2d95'],
    speed: 0.15,
    scale: 1,
    angleDeg: 20,
    softness: 0.5,
    intensity: 1,
    seed: 7,
    sync: 'none',
  },
  wave: { colors: ['#071033', '#16d9cc'], speed: 0.4, scale: 1.4, angleDeg: 0, softness: 0.45, intensity: 1, seed: 3, sync: 'beat' },
  radial: { colors: ['#ff3d9a', '#12041f'], speed: 0.5, scale: 1, angleDeg: 0, softness: 0.35, intensity: 1, seed: 5, sync: 'beat' },
  noise: { colors: ['#0a1030', '#397cff', '#f2f6ff'], speed: 0.25, scale: 2.2, angleDeg: 0, softness: 0.6, intensity: 1, seed: 41, sync: 'none' },
  grid: { colors: ['#02040a', '#c2a4ff'], speed: 0.2, scale: 1.2, angleDeg: 0, softness: 0.15, intensity: 1, seed: 11, sync: 'bar' },
  scan: { colors: ['#05060c', '#ff8a18'], speed: 0.8, scale: 1, angleDeg: 90, softness: 0.25, intensity: 1, seed: 2, sync: 'beat' },
  dots: { colors: ['#05060c', '#ffffff', '#397cff'], speed: 0.3, scale: 1.6, angleDeg: 0, softness: 0.1, intensity: 1, seed: 19, sync: 'beat' },
  blackout: { colors: ['#000000'], speed: 0, scale: 1, angleDeg: 0, softness: 0, intensity: 0, seed: 0, sync: 'none' },
};

/** A fresh look of `kind`, using the authored defaults. */
export function defaultLedLook(kind: LedLookKind = 'gradient'): LedLookState {
  return { kind, ...LOOK_DEFAULTS[kind], colors: [...LOOK_DEFAULTS[kind].colors] };
}

/** Build the persisted wall record for a venue feature. */
export function ledSurfaceFromFeature(
  feature: LedWallFeature,
  id = 'led-main',
  name = 'LED Wall',
): LedSurface {
  return {
    id,
    name,
    widthM: feature.width,
    heightM: feature.height,
    y: feature.y,
    z: feature.z,
    ...DEFAULT_LED_SURFACE,
  };
}
