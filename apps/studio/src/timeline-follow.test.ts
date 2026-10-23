import { describe, expect, it } from 'vitest';
import { followScrollLeft, smoothFollowScrollLeft } from './timeline-follow';

/** A 1000 px wide time axis at 50 px per second. */
const AXIS = 1000;
const PPS = 50;

describe('followScrollLeft', () => {
  it('keeps the view still until the playhead reaches the middle', () => {
    expect(followScrollLeft(0, PPS, AXIS, 5000)).toBe(0);
    expect(followScrollLeft(5, PPS, AXIS, 5000)).toBe(0);
    // 10 s * 50 px = 500 px = half the axis.
    expect(followScrollLeft(10, PPS, AXIS, 5000)).toBe(0);
  });

  it('locks the playhead to the middle after that', () => {
    expect(followScrollLeft(12, PPS, AXIS, 5000)).toBe(100);
    expect(followScrollLeft(20, PPS, AXIS, 5000)).toBe(500);
  });

  it('lets the playhead drift to the right edge at the end', () => {
    // maxScroll 5000 px; the axis centre sits 500 px before it.
    expect(followScrollLeft(110, PPS, AXIS, 5000)).toBe(5000);
    // Past the scroll limit the playhead keeps moving right on its own.
    expect(followScrollLeft(115, PPS, AXIS, 5000)).toBe(5000);
  });

  it('never scrolls when the song fits the viewport', () => {
    expect(followScrollLeft(0, PPS, AXIS, 0)).toBe(0);
    expect(followScrollLeft(15, PPS, AXIS, 0)).toBe(0);
  });

  it('treats a missing axis width as one pixel', () => {
    expect(Number.isFinite(followScrollLeft(1, PPS, 0, 5000))).toBe(true);
  });
});

describe('smoothFollowScrollLeft', () => {
  it('follows playback-sized gaps exactly', () => {
    expect(smoothFollowScrollLeft(100, 100.8)).toBe(100.8);
    expect(smoothFollowScrollLeft(100, 120)).toBe(120);
  });

  it('eases big gaps instead of jumping', () => {
    const step = smoothFollowScrollLeft(0, 1000);
    expect(step).toBeGreaterThan(0);
    expect(step).toBeLessThan(1000);
  });

  it('caps the step so long jumps stay smooth', () => {
    expect(smoothFollowScrollLeft(0, 100_000)).toBe(400);
  });

  it('eases backwards as well', () => {
    expect(smoothFollowScrollLeft(1000, 0)).toBe(750);
  });

  it('converges on the target', () => {
    let current = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      current = smoothFollowScrollLeft(current, 732);
    }
    expect(current).toBe(732);
  });
});
