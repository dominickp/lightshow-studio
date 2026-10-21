const RESOLUTION_COOLDOWN_MS = 3000;

export interface PerfMonitorOptions {
  /** Re-apply the renderer pixel ratio/size for the current scale. */
  applyResolutionScale(now: number): void;
  isPlaying(): boolean;
  isHidden(): boolean;
  /** Clock used to seed the first frame; tests can supply a fixed one. */
  now?: () => number;
}

/**
 * Frame-time smoothing and adaptive resolution.
 *
 * Adaptive resolution is a GPU lever. Two rules keep it from misfiring:
 * - never resize while paused (a framebuffer reallocation reads as a flash,
 *   and there is no playback load to measure);
 * - only downscale when the main thread is not the bottleneck, because a
 *   CPU-paint-bound frame (e.g. Firefox with the timeline) cannot be fixed by
 *   rendering fewer pixels.
 */
export class PerfMonitor {
  private scale = 1;
  private smoothedFrameMs = 16.7;
  private smoothedCpuMs = 1;
  private lastFrame: number;
  private lastDeltaMs = 16.7;
  private lastStats = 0;
  private lastResolutionChange = 0;
  private autoResolution = true;

  constructor(private readonly options: PerfMonitorOptions) {
    this.lastFrame = (options.now ?? (() => performance.now()))();
  }

  get frameMs(): number {
    return this.smoothedFrameMs;
  }

  get resolutionScale(): number {
    return this.scale;
  }

  get autoResolutionEnabled(): boolean {
    return this.autoResolution;
  }

  /**
   * Turn adaptive resolution off while benchmarking: a silent downscale would
   * hide exactly the cost a benchmark is meant to expose. Turning it back on
   * also clears the cooldown so normal play can adapt immediately.
   */
  setAutoResolution(enabled: boolean): void {
    this.autoResolution = enabled;
    this.lastResolutionChange = 0;
  }

  /** Pin the scale to 100% and forget stale frame times. */
  resetScale(): void {
    this.scale = 1;
    this.smoothedFrameMs = 16.7;
    this.smoothedCpuMs = 1;
    this.lastResolutionChange = 0;
  }

  /** Feed a new animation frame; returns the frame delta in ms. */
  sampleFrame(now: number): number {
    const delta = now - this.lastFrame;
    this.lastFrame = now;
    this.lastDeltaMs = delta;
    this.smoothedFrameMs += (Math.min(delta, 100) - this.smoothedFrameMs) * 0.08;
    return delta;
  }

  sampleCpu(cpuMs: number): void {
    this.smoothedCpuMs += (cpuMs - this.smoothedCpuMs) * 0.08;
  }

  adjustResolution(now: number): void {
    if (!this.autoResolution) return;
    if (this.options.isHidden() || !this.options.isPlaying()) return;
    if (now - this.lastResolutionChange < RESOLUTION_COOLDOWN_MS) return;

    if (this.smoothedFrameMs < 13.2) {
      if (this.scale >= 1) return;
      this.scale = Math.min(1, this.scale + 0.1);
      this.apply(now);
      return;
    }
    if (this.smoothedFrameMs < 20.5) return;

    const gpuBound = this.smoothedCpuMs < this.lastDeltaMs * 0.5;
    if (!gpuBound || this.scale <= 0.55) return;
    this.scale = Math.max(0.55, this.scale - 0.1);
    this.apply(now);
  }

  /** True when the stats panel should refresh (throttled to 250 ms). */
  shouldRefreshStats(now: number): boolean {
    if (now - this.lastStats < 250) return false;
    this.lastStats = now;
    return true;
  }

  private apply(now: number): void {
    this.lastResolutionChange = now;
    this.options.applyResolutionScale(now);
  }
}
