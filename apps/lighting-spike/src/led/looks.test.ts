import { describe, expect, it } from 'vitest';
import { ledGrid } from './looks';
import { ledSurfaceFromFeature } from '@dmxsim/show-model';

const wall = () => ledSurfaceFromFeature({ width: 13.5, height: 6.2, y: 4.9, z: -11.85 });

describe('LED matrix resolution', () => {
  it('uses a legible matrix at the default 10 mm pitch', () => {
    expect(ledGrid(wall())).toEqual({ x: 50, y: 23 });
  });

  it('reduces the simulated diode count as physical pitch increases', () => {
    expect(ledGrid({ ...wall(), pitchMm: 20 })).toEqual({ x: 25, y: 11 });
  });

  it('shows more diodes at a denser physical pitch', () => {
    expect(ledGrid({ ...wall(), pitchMm: 3.9 })).toEqual({ x: 128, y: 59 });
  });

  it('caps dense matrices without changing their aspect ratio', () => {
    const grid = ledGrid({ ...wall(), pitchMm: 1 });
    expect(grid.x).toBe(256);
    expect(grid.y).toBe(118);
  });
});
