import { kelvinToCss, kelvinToRgb } from '../kelvin';
import type { Cue } from './types';

export const CUE_COLORS = [
  { name: 'blue', css: '#397cff', rgb: [0.08, 0.35, 1] },
  { name: 'violet', css: '#8c35ff', rgb: [0.55, 0.08, 1] },
  { name: 'magenta', css: '#ff3d9a', rgb: [1, 0.24, 0.6] },
  { name: 'cyan', css: '#16d9cc', rgb: [0.05, 0.85, 0.8] },
  { name: 'amber', css: '#ff8a18', rgb: [1, 0.42, 0.05] },
  { name: 'red', css: '#ff2f2f', rgb: [1, 0.08, 0.08] },
  { name: 'white', css: '#f2f6ff', rgb: [1, 1, 1] },
] as const;

/** The color a cue actually renders with: palette entry or override. */
export function resolveCueColor(cue: Cue): {
  css: string;
  rgb: readonly [number, number, number];
  name: string;
} {
  const override = cue.colorOverride;
  if (override?.kind === 'rgb') {
    const toCss = (value: number): string => Math.round(value * 255).toString(16).padStart(2, '0');
    return {
      css: `#${toCss(override.r)}${toCss(override.g)}${toCss(override.b)}`,
      rgb: [override.r, override.g, override.b],
      name: 'custom',
    };
  }
  if (override?.kind === 'white') {
    return {
      css: kelvinToCss(override.cct),
      rgb: kelvinToRgb(override.cct),
      name: `${Math.round(override.cct / 100) / 10}k`,
    };
  }
  const color = CUE_COLORS[cue.colorIndex % CUE_COLORS.length] ?? CUE_COLORS[0];
  return { css: color.css, rgb: color.rgb, name: color.name };
}

/**
 * Relative luminance (sRGB, rough) for contrast decisions on clip fills.
 * `rgb` is the 0..1 channel triple the fill was drawn with.
 */
export const textOnColor = (rgb: readonly [number, number, number] | readonly number[]): string => {
  const [r, g, b] = rgb;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // Saturated hues read poorly with pure white even at high luminance, so
  // require a fairly bright fill before inverting to dark text.
  return luminance > 0.6 ? 'rgba(8, 12, 18, 0.88)' : 'rgba(255, 255, 255, 0.94)';
};

/**
 * Tone a clip fill down for the timeline: blend ~45% toward the dock
 * background so saturated cards stay muted against the dark UI.
 * Swatches and the 3D rendering keep the full-intensity color.
 */
const TONE_BG: readonly [number, number, number] = [0x0e / 255, 0x14 / 255, 0x1c / 255];
const TONE_STRENGTH = 0.45;
export const toneClipColor = (rgb: readonly [number, number, number] | readonly number[]): string => {
  const mix = (channel: number, bg: number): number =>
    Math.round((channel * (1 - TONE_STRENGTH) + bg * TONE_STRENGTH) * 255);
  const [r, g, b] = rgb;
  return `rgb(${mix(r, TONE_BG[0])}, ${mix(g, TONE_BG[1])}, ${mix(b, TONE_BG[2])})`;
};

/**
 * Same tone-down for a CSS `#rrggbb` color, for gradient stops in painted
 * look cards: opaque fills with muted colors instead of translucent fills.
 */
export const toneCssColor = (css: string): string => {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex === null) return css;
  const value = Number.parseInt(hex[1] ?? '000000', 16);
  const mix = (channel: number, bg: number): number =>
    Math.round(channel * (1 - TONE_STRENGTH) + bg * TONE_STRENGTH);
  const r = mix((value >> 16) & 0xff, TONE_BG[0] * 255);
  const g = mix((value >> 8) & 0xff, TONE_BG[1] * 255);
  const b = mix(value & 0xff, TONE_BG[2] * 255);
  return `rgb(${r}, ${g}, ${b})`;
};

/**
 * Truncate a label with an ellipsis to roughly fit `maxWidthPx` at the clip
 * label font size. Small clips keep a shortened label instead of none.
 */
export const truncateLabel = (text: string, maxWidthPx: number): string => {
  if (maxWidthPx <= 0) return '';
  // ~5.4px per glyph at 9px monospace; one ellipsis glyph costs the same.
  const glyphPx = 5.4;
  const fit = Math.floor(maxWidthPx / glyphPx);
  if (text.length <= fit) return text;
  if (fit <= 1) return '…';
  return `${text.slice(0, fit - 1)}…`;
};
