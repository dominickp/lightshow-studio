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
 * The layer is painted only when its inputs change (resize, zoom, peaks,
 * timeline). The playhead is a DOM element, so playback does not copy a
 * song-wide canvas every frame.
 */
export class WaveformStrip {
  private readonly ctx: CanvasRenderingContext2D;
  private peaks: Peaks | null = null;
  private timeline: Timeline | null = null;
  private width = 0;
  private height = 0;
  /** Horizontal zoom in CSS px per song second. */
  private pixelsPerSecond = 0;
  /** Song time at the canvas's left edge. */
  private scrollLeft = 0;
  private dragging = false;
  private paintQueued = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onSeek: (songSec: number) => void,
  ) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('2d canvas unavailable');
    this.ctx = ctx;

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

    new ResizeObserver(() => this.paint()).observe(canvas);
  }

  setPeaks(peaks: Peaks): void {
    this.peaks = peaks;
  }

  setTimeline(timeline: Timeline): void {
    this.timeline = timeline;
  }

  /**
   * Point the strip at the visible part of the timeline. The canvas stays one
   * viewport wide (a full-song canvas at high zoom exceeds the browser's
   * maximum canvas dimension, which renders blank) and is shifted by the
   * scroller instead.
   */
  setViewport(viewportWidth: number, pixelsPerSecond: number, scrollLeft: number): void {
    this.pixelsPerSecond = pixelsPerSecond;
    this.scrollLeft = scrollLeft;
    this.canvas.style.width = `${Math.max(1, Math.round(viewportWidth))}px`;
    this.canvas.style.transform = `translate3d(${scrollLeft}px, 0, 0)`;
  }

  /** Repaint the static strip. Call on resize, zoom, peaks or timeline changes. */
  paint(): void {
    this.resize();
    this.paintLayer();
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

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);
    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }
    this.width = width;
    this.height = height;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private paintLayer(): void {
    const { width, height } = this;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#080b11';
    ctx.fillRect(0, 0, width, height);

    const timeline = this.timeline;
    if (timeline === null) return;

    const pps = this.pixelsPerSecond;
    const worldWidth = timeline.durationSec * pps;
    const loopX0 = this.timeToX(timeline.loopStartSec);
    const loopX1 = this.timeToX(timeline.loopEndSec);
    ctx.fillStyle = LOOP_FILL;
    ctx.fillRect(loopX0, 0, Math.max(1, loopX1 - loopX0), height);

    // Faint lift outside the loop so the loop band reads as recessed.
    ctx.fillStyle = OUTSIDE_LIFT;
    ctx.fillRect(0, 0, Math.max(0, loopX0), height);
    ctx.fillRect(Math.max(0, loopX1), 0, Math.max(0, width - loopX1), height);

    this.paintTicks(ctx, timeline);

    const peaks = this.peaks;
    if (peaks !== null && worldWidth > 0) {
      const buckets = peaks.min.length;
      const mid = height / 2;
      const scale = height / 2 - 2;

      let inLoopStyle = false;
      ctx.fillStyle = WAVE;
      for (let x = 0; x < width; x += 1) {
        const worldX = this.scrollLeft + x;
        const bucket = Math.max(0, Math.min(buckets - 1, Math.floor((worldX / worldWidth) * buckets)));
        const lo = peaks.min[bucket] ?? 0;
        const hi = peaks.max[bucket] ?? 0;
        const top = mid - hi * scale;
        const bottom = mid - lo * scale;
        const inLoop = x >= loopX0 && x <= loopX1;
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
    ctx.fillRect(Math.round(loopX0), 0, 1, height);
    ctx.fillRect(Math.round(loopX1) - 1, 0, 1, height);
  }

  private paintTicks(ctx: CanvasRenderingContext2D, timeline: Timeline): void {
    const pps = this.pixelsPerSecond;
    if (timeline.bpm === null || timeline.bpm <= 0 || pps <= 0) return;

    const beatSec = 60 / timeline.bpm;
    const spacing = beatSec * pps;
    if (spacing < 2.5) return;

    const fromSec = this.scrollLeft / pps;
    const toSec = (this.scrollLeft + this.width) / pps;
    const firstIndex = Math.max(0, Math.ceil((fromSec - timeline.firstBeatSec) / beatSec));
    const lastIndex = Math.min(
      Math.floor((timeline.durationSec - timeline.firstBeatSec) / beatSec),
      Math.floor((toSec - timeline.firstBeatSec) / beatSec),
    );

    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const t = timeline.firstBeatSec + index * beatSec;
      const isBar = ((index % timeline.beatsPerBar) + timeline.beatsPerBar) % timeline.beatsPerBar === 0;
      const x = Math.round(t * pps - this.scrollLeft);
      ctx.fillStyle = isBar ? BAR_TICK : BEAT_TICK;
      ctx.fillRect(x, isBar ? 0 : this.height - 6, 1, isBar ? this.height : 6);
    }
  }

  /** Screen x (inside the viewport-sized canvas) for a song time. */
  private timeToX(songSec: number): number {
    if (this.pixelsPerSecond <= 0) return 0;
    return songSec * this.pixelsPerSecond - this.scrollLeft;
  }

  private xToTime(x: number): number {
    const duration = this.timeline?.durationSec ?? 0;
    if (this.pixelsPerSecond <= 0 || duration <= 0) return 0;
    const songSec = (this.scrollLeft + x) / this.pixelsPerSecond;
    return Math.max(0, Math.min(duration, songSec));
  }
}
