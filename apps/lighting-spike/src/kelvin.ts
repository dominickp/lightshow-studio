/**
 * Kelvin → sRGB approximation (Tanner Helland's algorithm, no dependency).
 * Used both for white-temperature swatch fills and for the evaluator's
 * white-channel tint, so 2700 K looks warm and 10000 K cool everywhere.
 */

export const MIN_KELVIN = 2000;
export const MAX_KELVIN = 10000;

/** Temperature in kelvin to a linear sRGB triple in the 0..1 range. */
export function kelvinToRgb(kelvin: number): [number, number, number] {
  const t = Math.min(Math.max(kelvin, MIN_KELVIN), MAX_KELVIN) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  const channel = (value: number): number =>
    Math.round(Math.min(255, Math.max(0, value))) / 255;
  return [channel(r), channel(g), channel(b)];
}

const toHex = (value: number): string =>
  Math.round(value * 255).toString(16).padStart(2, '0');

/** Kelvin as a CSS color string (same triple as `kelvinToRgb`). */
export function kelvinToCss(kelvin: number): string {
  const [r, g, b] = kelvinToRgb(kelvin);
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Build a CSS gradient covering the kelvin range for slider tracks. */
export function kelvinGradient(stops = 12): string {
  const points: string[] = [];
  for (let i = 0; i < stops; i += 1) {
    const kelvin = MIN_KELVIN + ((MAX_KELVIN - MIN_KELVIN) * i) / (stops - 1);
    points.push(`${kelvinToCss(kelvin)} ${(i / (stops - 1)) * 100}%`);
  }
  return `linear-gradient(to right, ${points.join(', ')})`;
}
