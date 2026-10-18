/** Waveform peaks, one min/max pair per horizontal bucket. */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
}

export interface Timeline {
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

const LOOP_FILL = 'rgba(122, 209, 255, 0.07)';
const LOOP_EDGE = 'rgba(122, 209, 255, 0.55)';
const WAVE = 'rgba(122, 209, 255, 0.42)';
const WAVE_OUTSIDE = 'rgba(122, 209, 255, 0.16)';
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

    const loopX0 = this.timeToX(timeline.loopStartSec);
    const loopX1 = this.timeToX(timeline.loopEndSec);
    ctx.fillStyle = LOOP_FILL;
    ctx.fillRect(loopX0, 0, Math.max(1, loopX1 - loopX0), height);

    this.paintTicks(ctx, timeline);

    const peaks = this.peaks;
    if (peaks !== null) {
      const buckets = peaks.min.length;
      const mid = height / 2;
      const scale = height / 2 - 2;

      for (let x = 0; x < width; x += 1) {
        const bucket = Math.min(buckets - 1, Math.floor((x / width) * buckets));
        const lo = peaks.min[bucket] ?? 0;
        const hi = peaks.max[bucket] ?? 0;
        const top = mid - hi * scale;
        const bottom = mid - lo * scale;
        const inLoop = x >= loopX0 && x <= loopX1;
        ctx.fillStyle = inLoop ? WAVE : WAVE_OUTSIDE;
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
    if (timeline.bpm === null || timeline.bpm <= 0) return;

    const beatSec = 60 / timeline.bpm;
    const spacing = (beatSec / timeline.durationSec) * this.width;
    if (spacing < 2.5) return;

    const firstIndex = Math.ceil(-timeline.firstBeatSec / beatSec);
    const lastIndex = Math.floor((timeline.durationSec - timeline.firstBeatSec) / beatSec);

    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const t = timeline.firstBeatSec + index * beatSec;
      const isBar = ((index % timeline.beatsPerBar) + timeline.beatsPerBar) % timeline.beatsPerBar === 0;
      const x = Math.round((t / timeline.durationSec) * this.width);
      ctx.fillStyle = isBar ? BAR_TICK : BEAT_TICK;
      ctx.fillRect(x, isBar ? 0 : this.height - 6, 1, isBar ? this.height : 6);
    }
  }

  private timeToX(songSec: number): number {
    const duration = this.timeline?.durationSec ?? 0;
    if (duration <= 0) return 0;
    return (songSec / duration) * this.width;
  }

  private xToTime(x: number): number {
    const duration = this.timeline?.durationSec ?? 0;
    if (this.width <= 0 || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, (x / this.width) * duration));
  }
}
