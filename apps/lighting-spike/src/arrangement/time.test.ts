import { describe, expect, it } from 'vitest';
import { defaultClipLength, snapDelta, snapTime } from './time';
import type { CueTimeline } from './types';

const timeline: CueTimeline = {
  durationSec: 100,
  firstBeatSec: 0.25,
  bpm: 120,
  beatsPerBar: 4,
};

describe('snapTime', () => {
  it('rounds to the nearest sixteenth note, offset by the first beat', () => {
    // 120 BPM → 0.5 s per beat → 0.125 s per sixteenth.
    expect(snapTime(timeline, 1.31)).toBeCloseTo(1.25);
    expect(snapTime(timeline, 1.39)).toBeCloseTo(1.375);
  });

  it('clamps to the song bounds', () => {
    expect(snapTime(timeline, -5)).toBe(0);
    expect(snapTime(timeline, 500)).toBe(100);
  });

  it('clamps without snapping when there is no tempo', () => {
    expect(snapTime({ ...timeline, bpm: null }, 3.333)).toBe(3.333);
    expect(snapTime(null, 3.333)).toBe(0);
  });
});

describe('snapDelta', () => {
  it('rounds a movement delta to the grid', () => {
    expect(snapDelta(timeline, 0.3)).toBeCloseTo(0.25);
    expect(snapDelta(timeline, 0.2)).toBeCloseTo(0.25);
  });

  it('leaves the delta alone without a tempo', () => {
    expect(snapDelta(null, 0.3)).toBe(0.3);
    expect(snapDelta({ ...timeline, bpm: 0 }, 0.3)).toBe(0.3);
  });
});

describe('defaultClipLength', () => {
  it('is two beats at the project tempo', () => {
    expect(defaultClipLength(timeline)).toBeCloseTo(1);
  });

  it('falls back to two seconds without a tempo', () => {
    expect(defaultClipLength(null)).toBe(2);
    expect(defaultClipLength({ ...timeline, bpm: null })).toBe(2);
  });
});
