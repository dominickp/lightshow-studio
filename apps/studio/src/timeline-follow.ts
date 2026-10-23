/**
 * Horizontal follow geometry for the arrangement timeline.
 *
 * The timeline is a native scroll container: the sticky track labels stay at
 * `scrollLeft`, and the time axis starts right after them. These helpers are
 * pure so the follow behaviour can be unit tested without DOM or audio.
 */

/**
 * Scroll offset that centres `songTimeSec` in the time axis.
 *
 * Clamping to the scrollable range gives the end behaviour for free: at the
 * start the playhead travels from the left edge to the middle before the view
 * moves at all, and at the end it leaves the middle again for the right edge.
 * When the song is zoomed to fit, `maxScroll` is zero and nothing scrolls.
 */
export function followScrollLeft(
  songTimeSec: number,
  pixelsPerSecond: number,
  axisWidth: number,
  maxScroll: number,
): number {
  const centre = songTimeSec * pixelsPerSecond - Math.max(1, axisWidth) / 2;
  return Math.min(Math.max(0, maxScroll), Math.max(0, centre));
}

/**
 * Smallest step. Playback-sized gaps (a fraction of a pixel per frame) are
 * still followed exactly because the step never exceeds the gap itself; wider
 * gaps then move at least this far per frame, so the ease always reaches the
 * target instead of crawling the last few pixels.
 */
const MIN_STEP_PX = 24;
/** Ceiling per frame, so a long jump slides instead of teleporting. */
const MAX_STEP_PX = 400;
const CATCH_UP = 0.25;

/**
 * Move `current` towards `target`.
 *
 * Playback-sized gaps snap straight to the target. Bigger gaps - pressing play
 * after scrolling somewhere else, or a seek - ease in over a few frames, so the
 * timeline pans into place instead of jumping.
 */
export function smoothFollowScrollLeft(current: number, target: number): number {
  const gap = target - current;
  const distance = Math.abs(gap);
  if (distance <= 0.5) return target;
  const step = Math.min(distance, MAX_STEP_PX, Math.max(MIN_STEP_PX, distance * CATCH_UP));
  return current + Math.sign(gap) * step;
}
