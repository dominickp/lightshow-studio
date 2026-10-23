import { describe, expect, it } from 'vitest';
import { coversViewport, WINDOW_MARGIN_PX, windowFor } from './canvas-window';

const VIEWPORT = 1000;
const WORLD = 10_000;

describe('windowFor', () => {
  it('covers the viewport with a margin on both sides', () => {
    const range = windowFor(4000, VIEWPORT, WORLD);
    expect(range.start).toBe(4000 - WINDOW_MARGIN_PX);
    expect(range.width).toBe(VIEWPORT + WINDOW_MARGIN_PX * 2);
    expect(range.start).toBeLessThan(4000);
    expect(range.start + range.width).toBeGreaterThan(5000);
  });

  it('starts at zero near the beginning of the timeline', () => {
    expect(windowFor(0, VIEWPORT, WORLD).start).toBe(0);
    expect(windowFor(120, VIEWPORT, WORLD).start).toBe(0);
  });

  it('never spills past the end of the timeline', () => {
    const range = windowFor(9500, VIEWPORT, WORLD);
    expect(range.start + range.width).toBeLessThanOrEqual(WORLD);
    expect(range.start + range.width).toBe(WORLD);
  });

  it('covers the whole song when it fits the viewport', () => {
    const range = windowFor(0, VIEWPORT, 600);
    expect(range.start).toBe(0);
    expect(range.width).toBe(600);
    expect(coversViewport(range, 0, VIEWPORT, 600)).toBe(true);
  });
});

describe('coversViewport', () => {
  it('accepts scrolling inside the painted window', () => {
    const range = windowFor(4000, VIEWPORT, WORLD);
    expect(coversViewport(range, 4100, VIEWPORT, WORLD)).toBe(true);
    expect(coversViewport(range, 4000 - WINDOW_MARGIN_PX + 10, VIEWPORT, WORLD)).toBe(true);
  });

  it('rejects a viewport that scrolled past either edge', () => {
    const range = windowFor(4000, VIEWPORT, WORLD);
    expect(coversViewport(range, 4000 - WINDOW_MARGIN_PX - 1, VIEWPORT, WORLD)).toBe(false);
    expect(coversViewport(range, 4000 + WINDOW_MARGIN_PX + 100, VIEWPORT, WORLD)).toBe(false);
  });

  it('rejects anything before the first paint', () => {
    expect(coversViewport({ start: 0, width: 0 }, 0, VIEWPORT, WORLD)).toBe(false);
  });

  it('keeps sub-pixel scroll offsets covered', () => {
    const range = windowFor(4000, VIEWPORT, WORLD);
    expect(coversViewport(range, 4000.5, VIEWPORT, WORLD)).toBe(true);
  });
});
