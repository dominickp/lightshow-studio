import { WindowedCanvas } from './canvas-window';

/** Waveform peaks, one min/max pair per horizontal bucket. */
interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

interface Timeline {
  durationSec: number;
  loopStartSec: number;
  loopEndSec: number;
  firstBeatSec: number;
  bpm: number | null;
  beatsPerBar: number;
}

export function computePeaks(buffer: AudioBuffer, buckets: number): Peaks {
  const count = Math.max(1, buckets);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));

  const samples = buffer.length;
  const min = new Float32Array(count);
  const max = new Float32Array(count);

  for (let b = 0; b < count; b += 1) {
    const start = Math.floor((b * samples) / count);
    const end = Math.max(start + 1, Math.floor(((b + 1) * samples) / count));
    let lo = 0;
    let hi = 0;

    for (const channel of channels) {
      for (let i = start; i < end && i < samples; i += 1) {
        const v = channel[i] ?? 0;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }

    min[b] = lo;
    max[b] = hi;
  }

  return { min, max };
}

// The strip is at its normal dark tone everywhere; the loop region uses the
// inverted treatment: a deeper-black fill and slightly dimmer waveform,
// marked by accent edge lines.
const BACKGROUND = '#080b11';
const LOOP_FILL = 'rgba(0, 0, 0, 0.3)';
const LOOP_EDGE = 'rgba(122, 209, 255, 0.75)';
const WAVE = 'rgba(122, 209, 255, 0.26)';
const WAVE_IN_LOOP = 'rgba(122, 209, 255, 0.16)';
const OUTSIDE_LIFT = 'rgba(255, 255, 255, 0.025)';
const BEAT_TICK = 'rgba(255, 255, 255, 0.05)';
const BAR_TICK = 'rgba(255, 255, 255, 0.13)';

/**
 * Canvas transport strip: waveform, beat/bar ticks and loop region.
 *
 * The strip is painted as a window of the timeline (see `WindowedCanvas`), so
 * it is repainted only when the window, the zoom or the peaks change.
 * Scrolling - including follow-mode playback - runs no canvas code, and the
 * playhead is a DOM element.
 */
export class WaveformStrip {
  private readonly windowed: WindowedCanvas;
  private peaks: Peaks | null = null;
  private timeline: Timeline | null = null;
  /** Horizontal zoom in CSS px per song second. */
  private pixelsPerSecond = 0;
  private dragging = false;
  private paintQueued = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSeek: (songSec: number) => void,
  ) {
    this.windowed = new WindowedCanvas(
      canvas,
      (ctx, start, width, height) => this.paintLayer(ctx, start, width, height),
    );

    canvas.addEventListener('pointerdown', (event) => {
      this.dragging = true;
      canvas.setPointerCapture(event.pointerId);
      this.onSeek(this.xToTime(event.offsetX));
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.onSeek(this.xToTime(event.offsetX));
    });
    const end = (event: PointerEvent): void => {
      this.dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  setPeaks(peaks: Peaks): void {
    this.peaks = peaks;
  }

  setTimeline(timeline: Timeline): void {
    this.timeline = timeline;
  }

  /**
   * Point the strip at the visible part of the timeline. The canvas is a
   * window of the timeline placed in its own coordinate space, so this only
   * repaints when the viewport scrolled out of the painted window (or the
   * zoom changed). A full-song canvas would exceed the browser's maximum
   * canvas dimension at high zoom, which used to render blank.
   */
  setViewport(viewportWidth: number, pixelsPerSecond: number, scrollLeft: number): void {
    this.pixelsPerSecond = pixelsPerSecond;
    const duration = this.timeline?.durationSec ?? 0;
    this.windowed.show(viewportWidth, pixelsPerSecond, scrollLeft, duration * pixelsPerSecond);
  }

  /** Repaint the static strip. Call on resize, zoom, peaks or timeline changes. */
  paint(): void {
    this.windowed.repaint();
  }

  /** Coalesced repaint for high-frequency inputs such as slider/loop drags. */
  requestPaint(): void {
    if (this.paintQueued) return;
    this.paintQueued = true;
    requestAnimationFrame(() => {
      this.paintQueued = false;
      this.paint();
    });
  }

  private paintLayer(
    ctx: CanvasRenderingContext2D,
    start: number,
    width: number,
    height: number,
  ): void {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, width, height);

    const timeline = this.timeline;
    if (timeline === null) return;

    const pps = this.pixelsPerSecond;
    const worldWidth = timeline.durationSec * pps;
    const loopX0 = this.timeToX(timeline.loopStartSec, start);
    const loopX1 = this.timeToX(timeline.loopEndSec, start);
    // The loop may sit outside the painted window, so clamp it to the canvas.
    const bandStart = Math.max(0, Math.min(width, loopX0));
    const bandEnd = Math.max(0, Math.min(width, loopX1));

    // Faint lift outside the loop so the loop band reads as recessed.
    ctx.fillStyle = OUTSIDE_LIFT;
    ctx.fillRect(0, 0, bandStart, height);
    ctx.fillRect(bandEnd, 0, Math.max(0, width - bandEnd), height);
    ctx.fillStyle = LOOP_FILL;
    ctx.fillRect(bandStart, 0, Math.max(0, bandEnd - bandStart), height);

    this.paintTicks(ctx, timeline, start, width, height);

    const peaks = this.peaks;
    if (peaks !== null && worldWidth > 0) {
      const buckets = peaks.min.length;
      const mid = height / 2;
      const scale = height / 2 - 2;

      let inLoopStyle = false;
      ctx.fillStyle = WAVE;
      for (let x = 0; x < width; x += 1) {
        const worldX = start + x;
        const bucket = Math.max(0, Math.min(buckets - 1, Math.floor((worldX / worldWidth) * buckets)));
        const lo = peaks.min[bucket] ?? 0;
        const hi = peaks.max[bucket] ?? 0;
        const top = mid - hi * scale;
        const bottom = mid - lo * scale;
        const inLoop = x >= bandStart && x <= bandEnd;
        if (inLoop !== inLoopStyle) {
          inLoopStyle = inLoop;
          ctx.fillStyle = inLoop ? WAVE_IN_LOOP : WAVE;
        }
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    }

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(height / 2) + 0.5);
    ctx.lineTo(width, Math.round(height / 2) + 0.5);
    ctx.stroke();

    ctx.fillStyle = LOOP_EDGE;
    if (loopX0 >= 0 && loopX0 <= width) ctx.fillRect(Math.round(loopX0), 0, 1, height);
    if (loopX1 >= 0 && loopX1 <= width) ctx.fillRect(Math.round(loopX1) - 1, 0, 1, height);
  }

  private paintTicks(
    ctx: CanvasRenderingContext2D,
    timeline: Timeline,
    start: number,
    width: number,
    height: number,
  ): void {
    const pps = this.pixelsPerSecond;
    if (timeline.bpm === null || timeline.bpm <= 0 || pps <= 0) return;

    const beatSec = 60 / timeline.bpm;
    const spacing = beatSec * pps;
    if (spacing < 2.5) return;

    const fromSec = start / pps;
    const toSec = (start + width) / pps;
    const firstIndex = Math.max(0, Math.ceil((fromSec - timeline.firstBeatSec) / beatSec));
    const lastIndex = Math.min(
      Math.floor((timeline.durationSec - timeline.firstBeatSec) / beatSec),
      Math.floor((toSec - timeline.firstBeatSec) / beatSec),
    );

    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const t = timeline.firstBeatSec + index * beatSec;
      const isBar = ((index % timeline.beatsPerBar) + timeline.beatsPerBar) % timeline.beatsPerBar === 0;
      const x = Math.round(t * pps - start);
      ctx.fillStyle = isBar ? BAR_TICK : BEAT_TICK;
      ctx.fillRect(x, isBar ? 0 : height - 6, 1, isBar ? height : 6);
    }
  }

  /** Canvas x for a song time inside the painted window. */
  private timeToX(songSec: number, start: number): number {
    if (this.pixelsPerSecond <= 0) return 0;
    return songSec * this.pixelsPerSecond - start;
  }

  /** Song time at a canvas x; pointer events give canvas-relative offsets. */
  private xToTime(x: number): number {
    const duration = this.timeline?.durationSec ?? 0;
    if (this.pixelsPerSecond <= 0 || duration <= 0) return 0;
    const songSec = (this.windowed.start + x) / this.pixelsPerSecond;
    return Math.max(0, Math.min(duration, songSec));
  }
}
