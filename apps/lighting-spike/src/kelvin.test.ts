import { describe, expect, it } from 'vitest';
import { MAX_KELVIN, MIN_KELVIN, kelvinToCss, kelvinToRgb } from './kelvin';

describe('kelvinToRgb', () => {
  it('clamps to the supported range', () => {
    expect(kelvinToRgb(MIN_KELVIN - 500)).toEqual(kelvinToRgb(MIN_KELVIN));
    expect(kelvinToRgb(MAX_KELVIN + 500)).toEqual(kelvinToRgb(MAX_KELVIN));
  });

  it('renders warm white warmer than cool white', () => {
    const [warmR, , warmB] = kelvinToRgb(2700);
    const [coolR, , coolB] = kelvinToRgb(10000);
    expect(warmR).toBeGreaterThan(0.95);
    expect(warmB).toBeLessThan(0.6);
    expect(coolR).toBeLessThan(warmR);
    expect(coolB).toBeGreaterThan(warmB);
  });

  it('renders high kelvin cool', () => {
    const [r, , b] = kelvinToRgb(10000);
    expect(b).toBeGreaterThan(r);
  });

  it('produces valid css for the swatch fill', () => {
    expect(kelvinToCss(6500)).toMatch(/^#[0-9a-f]{6}$/);
  });
});
