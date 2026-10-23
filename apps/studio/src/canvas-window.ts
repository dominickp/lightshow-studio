/**
 * Windowed painting for the timeline's horizontally scrolling canvases.
 *
 * A song-wide canvas exceeds the browser's maximum canvas dimension on long
 * songs at high zoom, so the ruler and waveform are only as wide as the
 * visible axis. Pinning that canvas to the viewport (re-painting it on every
 * scroll frame) is what makes follow-mode playback expensive: each frame
 * redrew thousands of waveform columns and ruler ticks. Instead the canvas is
 * placed in the timeline's own coordinate space and painted as a window wider
 * than the viewport, so scrolling only moves the scroller. A repaint happens
 * when the viewport leaves the painted window, i.e. once per
 * `WINDOW_MARGIN_PX` of scrolling rather than once per frame.
 */

/** World px painted beyond each edge of the viewport. */
export const WINDOW_MARGIN_PX = 768;

export interface CanvasWindowRange {
  /** World x (CSS px from the timeline start) of the window's left edge. */
  start: number;
  /** Window width in CSS px. */
  width: number;
}

/**
 * Window of the timeline to paint so the viewport at `scrollLeft` is covered
 * with `margin` of slack on each side.
 *
 * Clamped to the timeline: a canvas that spills past the song's end would grow
 * the scroller's scrollable width, which changes the maximum scroll offset.
 */
export function windowFor(
  scrollLeft: number,
  viewportWidth: number,
  worldWidth: number,
  margin = WINDOW_MARGIN_PX,
): CanvasWindowRange {
  const world = Math.max(1, Math.ceil(worldWidth));
  const width = Math.min(world, Math.max(1, Math.ceil(viewportWidth)) + margin * 2);
  const start = Math.max(0, Math.min(Math.floor(scrollLeft) - margin, world - width));
  return { start, width };
}

/** Whether `range` already covers the viewport, so no repaint is needed. */
export function coversViewport(
  range: CanvasWindowRange,
  scrollLeft: number,
  viewportWidth: number,
  worldWidth: number,
): boolean {
  if (range.width <= 0) return false;
  if (scrollLeft < range.start) return false;
  const visibleRight = Math.min(scrollLeft + viewportWidth, Math.max(1, worldWidth));
  return visibleRight <= range.start + range.width;
}

/**
 * Paints a window of the timeline into `ctx`. `start` is the world x of the
 * canvas's left edge, so a world x maps to canvas x as `worldX - start`.
 */
export type CanvasPaint = (
  ctx: CanvasRenderingContext2D,
  start: number,
  width: number,
  height: number,
) => void;

/**
 * A canvas showing a slice of the scrolling timeline. See the module comment
 * for why it is windowed rather than pinned to the viewport.
 */
export class WindowedCanvas {
  private readonly ctx: CanvasRenderingContext2D;
  private viewportWidth = 0;
  private worldWidth = 0;
  private pixelsPerSecond = 0;
  private scrollLeft = 0;
  /** Painted window; `width === 0` means nothing has been painted yet. */
  private painted: CanvasWindowRange = { start: 0, width: 0 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly paint: CanvasPaint,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('2d canvas unavailable');
    this.ctx = ctx;
  }

  /** World x of the canvas's left edge, for pointer maths. */
  get start(): number {
    return this.painted.start;
  }

  /**
   * Point the canvas at the visible part of the timeline. Costs only a few
   * comparisons unless the viewport has scrolled out of the painted window or
   * the zoom/world size changed.
   */
  show(viewportWidth: number, pixelsPerSecond: number, scrollLeft: number, worldWidth: number): void {
    const changed = viewportWidth !== this.viewportWidth
      || pixelsPerSecond !== this.pixelsPerSecond
      || worldWidth !== this.worldWidth;
    this.viewportWidth = viewportWidth;
    this.pixelsPerSecond = pixelsPerSecond;
    this.worldWidth = worldWidth;
    this.scrollLeft = scrollLeft;
    if (changed || !coversViewport(this.painted, scrollLeft, viewportWidth, worldWidth)) this.repaint();
  }

  /** Repaint the current window. Call when the painted content changed. */
  repaint(): void {
    const height = this.canvas.clientHeight;
    if (this.viewportWidth <= 0 || height <= 0) return;

    const range = windowFor(this.scrollLeft, this.viewportWidth, this.worldWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(range.width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pixelWidth) this.canvas.width = pixelWidth;
    if (this.canvas.height !== pixelHeight) this.canvas.height = pixelHeight;

    const cssWidth = `${range.width}px`;
    if (this.canvas.style.width !== cssWidth) this.canvas.style.width = cssWidth;
    // Placing the canvas at the window's world offset keeps it inside the
    // scrolled content, so scrolling needs no JavaScript at all.
    const transform = `translate3d(${range.start}px, 0, 0)`;
    if (this.canvas.style.transform !== transform) this.canvas.style.transform = transform;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.painted = range;
    this.paint(this.ctx, range.start, range.width, height);
  }
}
