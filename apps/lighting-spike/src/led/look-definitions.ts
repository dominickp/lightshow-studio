import {
  defaultLedLook,
  ledMediaLabel,
  type LedLookKind,
  type LedLookState,
  type LedSync,
} from '@dmxsim/show-model';

export type LookParamSpec =
  | {
      kind: 'slider';
      key: 'speed' | 'scale' | 'angleDeg' | 'softness' | 'intensity';
      label: string;
      min: number;
      max: number;
      step: number;
      unit?: string;
      /** Suggested value when a clip is created. */
    }
  | { kind: 'palette'; key: 'colors'; label: string; min: number; max: number }
  | { kind: 'seed'; key: 'seed'; label: string }
  | { kind: 'select'; key: 'sync'; label: string; options: readonly { value: LedSync; label: string }[] };

export interface LookDefinition {
  kind: LedLookKind;
  label: string;
  /** One-glyph identity used on clip cards and the generator grid. */
  glyph: string;
  /** Short description for the picker. */
  hint: string;
  /** Parameters this generator exposes, in inspector order. */
  params: LookParamSpec[];
  defaults: LedLookState;
}

const MOTION: LookParamSpec[] = [
  { kind: 'slider', key: 'speed', label: 'Speed', min: 0, max: 2, step: 0.01, unit: 'Hz' },
  { kind: 'slider', key: 'scale', label: 'Scale', min: 0.2, max: 4, step: 0.05 },
  { kind: 'slider', key: 'angleDeg', label: 'Angle', min: -180, max: 180, step: 1, unit: '°' },
  { kind: 'slider', key: 'softness', label: 'Softness', min: 0, max: 1, step: 0.01 },
  { kind: 'slider', key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01 },
];

const PALETTE: LookParamSpec = { kind: 'palette', key: 'colors', label: 'Palette', min: 1, max: 4 };
const SEED: LookParamSpec = { kind: 'seed', key: 'seed', label: 'Seed' };
const SYNC: LookParamSpec = {
  kind: 'select',
  key: 'sync',
  label: 'Sync',
  options: [
    { value: 'none', label: 'Free' },
    { value: 'beat', label: 'Beat' },
    { value: 'bar', label: 'Bar' },
  ],
};

const definition = (
  kind: LedLookKind,
  label: string,
  glyph: string,
  hint: string,
  params: LookParamSpec[],
): LookDefinition => ({
  kind,
  label,
  glyph,
  hint,
  params,
  defaults: defaultLedLook(kind),
});

/**
 * The v1 catalogue. Nine generators with shared sliders produce a very large
 * look space; the point is to avoid hand-authoring hundreds of clips.
 */
export const LOOK_DEFINITIONS: readonly LookDefinition[] = [
  definition('solid', 'Solid', '■', 'One even colour across the wall', [PALETTE, ...MOTION.slice(4)]),
  definition('gradient', 'Gradient drift', '▤', 'Two-to-four colour ramp that breathes', [PALETTE, ...MOTION, SYNC]),
  definition('wave', 'Linear wave', '≈', 'Rolling bands across the wall', [PALETTE, ...MOTION, SYNC]),
  definition('radial', 'Radial pulse', '◎', 'Rings travelling out from the centre', [PALETTE, ...MOTION, SYNC]),
  definition('noise', 'Noise field', '▨', 'Organic cloud that churns over time', [PALETTE, ...MOTION, SEED, SYNC]),
  definition('grid', 'Grid / tunnel', '▦', 'Bright architectural lines moving through a dark field', [PALETTE, ...MOTION, SEED, SYNC]),
  definition('scan', 'Scan bars', '☰', 'Sharp horizontal sweeps', [PALETTE, ...MOTION, SYNC]),
  definition('blackout', 'Blackout', '◼', 'Wall off', [{ kind: 'slider', key: 'intensity', label: 'Intensity', min: 0, max: 1, step: 0.01 }, SYNC]),
];

const LEGACY_LOOKS: readonly LookDefinition[] = [
  definition('solid', 'Solid (legacy)', '■', 'Older single-colour look', [PALETTE, ...MOTION.slice(4)]),
  definition('dots', 'Dots (legacy)', '⁙', 'Older point-field look; rendered as scan bars', [PALETTE, ...MOTION, SEED, SYNC]),
];

/**
 * Media is not a generator: its picker lives in the media section, because a
 * bare `media` look with no source would render black.
 */
export const MEDIA_LOOK: LookDefinition = definition(
  'media',
  'Media',
  '▶',
  'Video or still image mapped onto the panel',
  [MOTION[4]!, SYNC],
);

export const LOOK_BY_KIND: ReadonlyMap<LedLookKind, LookDefinition> = new Map(
  [...LOOK_DEFINITIONS, ...LEGACY_LOOKS, MEDIA_LOOK].map((look) => [look.kind, look]),
);

export function lookDefinition(kind: LedLookKind): LookDefinition {
  return LOOK_BY_KIND.get(kind) ?? LOOK_DEFINITIONS[0]!;
}

/** `Gradient drift · 0.15 Hz` — enough to tell two clips apart at card width. */
export function lookSummary(look: LedLookState): string {
  const def = lookDefinition(look.kind);
  if (look.kind === 'blackout') return def.label;
  if (look.kind === 'media') {
    return ledMediaLabel(look.media) ?? def.label;
  }
  const unit = look.sync === 'beat' ? 'cycles/beat' : look.sync === 'bar' ? 'cycles/bar' : 'Hz';
  const speed = look.speed > 0 ? ` · ${look.speed.toFixed(2)} ${unit}` : '';
  return `${def.label}${speed}`;
}

/** Palette presets offered inside the look editor. */
export const PALETTE_PRESETS: readonly { name: string; colors: string[] }[] = [
  { name: 'Violet / magenta', colors: ['#1b0b4d', '#ff2d95'] },
  { name: 'Ice', colors: ['#04121f', '#16d9cc', '#f2f6ff'] },
  { name: 'Amber', colors: ['#080500', '#ff8a18', '#ffe6a8'] },
  { name: 'Mono', colors: ['#05060c', '#f2f6ff'] },
  { name: 'Spectrum', colors: ['#ff2f2f', '#ff8a18', '#16d9cc', '#8c35ff'] },
];
