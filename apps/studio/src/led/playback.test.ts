import { describe, expect, it } from 'vitest';
import { defaultLedLook } from '@dmxsim/show-model';
import type { Cue } from '../arrangement/types';
import { wallPlaybackLayers } from './playback';

const wallClip = (overrides: Partial<Cue> & Pick<Cue, 'id' | 'startSec' | 'endSec'>): Cue => ({
  fixtureId: 'wall-1',
  surfaceId: 'wall-1',
  colorIndex: 0,
  action: 'hold',
  look: defaultLedLook('gradient'),
  ...overrides,
});

describe('wallPlaybackLayers', () => {
  it('returns null when no clip is live, so the wall keeps its last look', () => {
    expect(wallPlaybackLayers([wallClip({ id: 'a', startSec: 2, endSec: 4 })], 1)).toBeNull();
    expect(wallPlaybackLayers([], 1)).toBeNull();
  });

  it('plays a lone clip at full opacity, with no fade from nothing', () => {
    const layers = wallPlaybackLayers([wallClip({ id: 'a', startSec: 0, endSec: 4 })], 0.01);
    expect(layers).toHaveLength(1);
    expect(layers?.[0]?.opacity).toBe(1);
  });

  it('crossfades from a clip that ends where the next one starts', () => {
    const layers = wallPlaybackLayers([
      wallClip({ id: 'a', startSec: 0, endSec: 4, look: defaultLedLook('wave') }),
      wallClip({ id: 'b', startSec: 4, endSec: 8, fadeInSec: 1, look: defaultLedLook('gradient') }),
    ], 4.5);

    expect(layers?.map((layer) => layer.look.kind)).toEqual(['wave', 'gradient']);
    expect(layers?.[0]?.opacity).toBeCloseTo(0.5);
    expect(layers?.[1]?.opacity).toBeCloseTo(0.5);
  });

  it('cuts rather than fades when the previous clip does not touch this one', () => {
    const layers = wallPlaybackLayers([
      wallClip({ id: 'a', startSec: 0, endSec: 2 }),
      wallClip({ id: 'b', startSec: 3, endSec: 8, fadeInSec: 1, look: defaultLedLook('wave') }),
    ], 3.1);

    expect(layers).toHaveLength(1);
    expect(layers?.[0]?.look.kind).toBe('wave');
    expect(layers?.[0]?.opacity).toBe(1);
  });

  it('scales the ramp by each clip\'s own opacity', () => {
    const layers = wallPlaybackLayers([
      wallClip({ id: 'a', startSec: 0, endSec: 4, opacity: 0.5 }),
      wallClip({ id: 'b', startSec: 4, endSec: 8, fadeInSec: 2, opacity: 0.8 }),
    ], 5);

    expect(layers?.[0]?.opacity).toBeCloseTo(0.5 * 0.5);
    expect(layers?.[1]?.opacity).toBeCloseTo(0.5 * 0.8);
  });

  it('picks the newest clip when several overlap', () => {
    const layers = wallPlaybackLayers([
      wallClip({ id: 'a', startSec: 0, endSec: 8, look: defaultLedLook('wave') }),
      wallClip({ id: 'b', startSec: 2, endSec: 8, look: defaultLedLook('gradient') }),
    ], 3);

    expect(layers?.at(-1)?.look.kind).toBe('gradient');
  });

  it('ignores clips without a look', () => {
    const clips = [
      wallClip({ id: 'a', startSec: 0, endSec: 4, look: undefined }),
      wallClip({ id: 'b', startSec: 0, endSec: 4 }),
    ];
    expect(wallPlaybackLayers(clips, 1)).toHaveLength(1);
  });

  it('is exclusive at the clip end, unlike a fixture cue', () => {
    expect(wallPlaybackLayers([wallClip({ id: 'a', startSec: 0, endSec: 4 })], 4)).toBeNull();
  });
});
