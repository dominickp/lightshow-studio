import { describe, expect, it } from 'vitest';
import type * as THREE from 'three/webgpu';
import { ledGrid, mediaAspect } from './looks';
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

const fakeTexture = (image: unknown): THREE.Texture => ({ image }) as THREE.Texture;

describe('media aspect', () => {
  it('falls back to 16:9 when the video has not loaded metadata yet', () => {
    // A cued `VideoTexture` exists before its `<video>` reports dimensions; an
    // aspect of 0 collapses the sampling in Y and smears one column across
    // the wall, so this must never divide by zero.
    expect(mediaAspect(fakeTexture({ videoWidth: 0, videoHeight: 0 }))).toBeCloseTo(16 / 9);
    expect(mediaAspect(fakeTexture(null))).toBeCloseTo(16 / 9);
    expect(mediaAspect(null)).toBeCloseTo(16 / 9);
  });

  it('uses the decoded dimensions once they are available', () => {
    expect(mediaAspect(fakeTexture({ videoWidth: 480, videoHeight: 320 }))).toBeCloseTo(1.5);
  });
});
