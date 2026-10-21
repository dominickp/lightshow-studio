/** Clamp `value` into the inclusive `[min, max]` range. */
export const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));
