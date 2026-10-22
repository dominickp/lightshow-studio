import { describe, expect, it } from 'vitest';
import {
  barBeatLabel,
  barLengthSec,
  defaultClipLength,
  formatClock,
  showTime,
  snapDelta,
  snapTime,
  snapTimeToBar,
  snapTimeToGrid,
} from './time';
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

  it('keeps the song start as a snap position before the first beat', () => {
    expect(snapTime(timeline, 0)).toBe(0);
    expect(snapTime(timeline, 0.1)).toBe(0);
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

describe('snapTimeToGrid', () => {
  it('snaps inside the lead-in instead of collapsing to zero', () => {
    // The start-of-song rule belongs to clip placement, not playhead scrubbing.
    expect(snapTimeToGrid(timeline, 0.1)).toBeCloseTo(0.125);
  });

  it('rounds to the nearest sixteenth note', () => {
    expect(snapTimeToGrid(timeline, 1.31)).toBeCloseTo(1.25);
  });

  it('clamps to the song bounds', () => {
    expect(snapTimeToGrid(timeline, -5)).toBe(0);
    expect(snapTimeToGrid(timeline, 500)).toBe(100);
  });

  it('clamps without snapping when there is no tempo', () => {
    expect(snapTimeToGrid({ ...timeline, bpm: null }, 3.333)).toBe(3.333);
    expect(snapTimeToGrid(null, 3.333)).toBe(3.333);
  });
});

describe('barLengthSec', () => {
  it('is one bar at the project tempo', () => {
    expect(barLengthSec(timeline)).toBeCloseTo(2);
  });

  it('falls back to one second without a beat grid', () => {
    expect(barLengthSec(null)).toBe(1);
    expect(barLengthSec({ ...timeline, bpm: null })).toBe(1);
  });
});

describe('snapTimeToBar', () => {
  it('snaps loop edges to whole measures', () => {
    // 120 BPM, 4/4 → 2 s bars offset by the 0.25 s first beat.
    expect(snapTimeToBar(timeline, 2.4)).toBeCloseTo(2.25);
    expect(snapTimeToBar(timeline, 4.4)).toBeCloseTo(4.25);
  });

  it('rounds to whole seconds without a beat grid', () => {
    expect(snapTimeToBar({ ...timeline, bpm: null }, 2.6)).toBe(3);
  });

  it('leaves the time alone with no timeline', () => {
    expect(snapTimeToBar(null, 2.6)).toBe(2.6);
  });
});

describe('formatClock', () => {
  it('renders m:ss.d with a padded seconds field', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(65.25)).toBe('1:05.3');
  });

  it('clamps negative times to zero', () => {
    expect(formatClock(-3)).toBe('0:00.0');
  });
});

describe('barBeatLabel', () => {
  it('reports bar.beat from the first beat', () => {
    // 0.25 s is bar 1 beat 1; 0.75 s is beat 2.
    expect(barBeatLabel(timeline, 0.25)).toBe('1.1');
    expect(barBeatLabel(timeline, 0.75)).toBe('1.2');
    expect(barBeatLabel(timeline, 2.25)).toBe('2.1');
  });

  it('falls back to the clock without a beat grid', () => {
    expect(barBeatLabel({ ...timeline, bpm: null }, 2.25)).toBe('0:02.3');
  });
});

describe('showTime', () => {
  it('wraps song time into the loop range', () => {
    const loop = { startSec: 10, endSec: 20 };
    expect(showTime(loop, 12)).toBe(12);
    expect(showTime(loop, 22)).toBe(12);
    expect(showTime(loop, 2)).toBe(12);
  });

  it('survives a zero-length loop', () => {
    // The 1 ms floor keeps the modulo finite, so the result is just past start.
    expect(showTime({ startSec: 5, endSec: 5 }, 9)).toBeCloseTo(5, 2);
  });
});
