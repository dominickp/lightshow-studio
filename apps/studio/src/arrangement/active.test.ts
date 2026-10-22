import { describe, expect, it } from 'vitest';
import {
  activeCuesAt,
  activeFixtureCuesAt,
  cuesForLane,
  indexCuesByLane,
  latestActiveEndSec,
} from './active';
import type { Cue } from './types';

const cue = (overrides: Partial<Cue> & Pick<Cue, 'id'>): Cue => ({
  fixtureId: 'head-1',
  startSec: 0,
  endSec: 2,
  colorIndex: 0,
  action: 'hold',
  ...overrides,
});

describe('indexCuesByLane', () => {
  it('groups cues by lane and keeps their order', () => {
    const index = indexCuesByLane([
      cue({ id: 'a' }),
      cue({ id: 'b', fixtureId: 'head-2' }),
      cue({ id: 'c' }),
    ]);

    expect(index.get('head-1')?.map((entry) => entry.id)).toEqual(['a', 'c']);
    expect(index.get('head-2')?.map((entry) => entry.id)).toEqual(['b']);
  });

  it('keys surface clips by the surface id they already store as fixtureId', () => {
    const index = indexCuesByLane([cue({ id: 'wall', fixtureId: 'wall-1', surfaceId: 'wall-1' })]);
    expect(index.get('wall-1')?.map((entry) => entry.id)).toEqual(['wall']);
  });
});

describe('cuesForLane', () => {
  it('returns an empty list for a lane with no cues', () => {
    expect(cuesForLane(indexCuesByLane([]), 'missing')).toEqual([]);
  });
});

describe('activeCuesAt', () => {
  it('includes both end points so a clip is live at its last frame', () => {
    const cues = [cue({ id: 'a', startSec: 1, endSec: 3 })];
    expect(activeCuesAt(cues, 0.99)).toHaveLength(0);
    expect(activeCuesAt(cues, 1)).toHaveLength(1);
    expect(activeCuesAt(cues, 3)).toHaveLength(1);
    expect(activeCuesAt(cues, 3.01)).toHaveLength(0);
  });

  it('returns every overlapping clip', () => {
    const cues = [
      cue({ id: 'a', startSec: 0, endSec: 4 }),
      cue({ id: 'b', startSec: 2, endSec: 6 }),
      cue({ id: 'c', startSec: 5, endSec: 7 }),
    ];
    expect(activeCuesAt(cues, 3).map((entry) => entry.id)).toEqual(['a', 'b']);
  });
});

describe('activeFixtureCuesAt', () => {
  it('ignores surface clips, which drive a wall look rather than a fixture', () => {
    const cues = [
      cue({ id: 'light' }),
      cue({ id: 'wall', surfaceId: 'wall-1' }),
    ];
    expect(activeFixtureCuesAt(cues, 1).map((entry) => entry.id)).toEqual(['light']);
  });
});

describe('latestActiveEndSec', () => {
  it('returns the end of the longest clip still running', () => {
    const cues = [
      cue({ id: 'short', startSec: 0, endSec: 2 }),
      cue({ id: 'long', startSec: 0, endSec: 5 }),
      cue({ id: 'later', startSec: 8, endSec: 9 }),
    ];
    expect(latestActiveEndSec(cues, 1)).toBe(5);
  });

  it('is null when nothing is running', () => {
    expect(latestActiveEndSec([cue({ id: 'a', startSec: 4, endSec: 5 })], 1)).toBeNull();
  });
});
