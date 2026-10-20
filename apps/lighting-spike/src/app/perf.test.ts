import { describe, expect, it } from 'vitest';
import { PerfMonitor } from './perf';

function setup(options: { playing?: boolean; hidden?: boolean } = {}) {
  const changes: number[] = [];
  let playing = options.playing ?? true;
  let hidden = options.hidden ?? false;
  // The closure only reads `monitor` when it is invoked later.
  const monitor: PerfMonitor = new PerfMonitor({
    applyResolutionScale: () => changes.push(monitor.resolutionScale),
    isPlaying: () => playing,
    isHidden: () => hidden,
    now: () => 0,
  });
  return {
    monitor,
    changes,
    setPlaying: (value: boolean) => { playing = value; },
    setHidden: (value: boolean) => { hidden = value; },
  };
}

/** Feed frames of `frameMs` so the smoothed frame time crosses the threshold. */
function feed(monitor: PerfMonitor, frameMs: number, count = 10): number {
  let now = 0;
  for (let index = 0; index < count; index += 1) {
    now += frameMs;
    monitor.sampleFrame(now);
  }
  return now;
}

describe('PerfMonitor', () => {
  it('smooths frame samples enough to react to a slowdown', () => {
    const { monitor } = setup();
    feed(monitor, 33);
    expect(monitor.frameMs).toBeGreaterThan(20.5);
  });

  it('downscales only when the GPU, not the CPU, is the bottleneck', () => {
    const gpuBound = setup();
    feed(gpuBound.monitor, 33);
    gpuBound.monitor.sampleCpu(1);
    gpuBound.monitor.adjustResolution(5000);
    expect(gpuBound.monitor.resolutionScale).toBeCloseTo(0.9);
    expect(gpuBound.changes).toEqual([0.9]);

    const cpuBound = setup();
    feed(cpuBound.monitor, 33);
    // The CPU figure is an EMA too, so it needs more than one heavy sample.
    for (let index = 0; index < 20; index += 1) cpuBound.monitor.sampleCpu(30);
    cpuBound.monitor.adjustResolution(5000);
    expect(cpuBound.monitor.resolutionScale).toBe(1);
    expect(cpuBound.changes).toEqual([]);
  });

  it('does not resize while paused or hidden', () => {
    const paused = setup({ playing: false });
    feed(paused.monitor, 33);
    paused.monitor.sampleCpu(1);
    paused.monitor.adjustResolution(5000);
    expect(paused.monitor.resolutionScale).toBe(1);

    const hidden = setup({ hidden: true });
    feed(hidden.monitor, 33);
    hidden.monitor.sampleCpu(1);
    hidden.monitor.adjustResolution(5000);
    expect(hidden.monitor.resolutionScale).toBe(1);
  });

  it('honours the cooldown between resolution changes', () => {
    const { monitor, changes } = setup();
    feed(monitor, 33);
    monitor.sampleCpu(1);
    monitor.adjustResolution(5000);
    monitor.adjustResolution(6000);
    expect(changes).toEqual([0.9]);
  });

  it('recovers resolution once frames are fast again', () => {
    const { monitor } = setup();
    feed(monitor, 33);
    monitor.sampleCpu(1);
    monitor.adjustResolution(5000);
    expect(monitor.resolutionScale).toBeCloseTo(0.9);

    feed(monitor, 8, 12);
    monitor.adjustResolution(20_000);
    expect(monitor.resolutionScale).toBeCloseTo(1);
  });

  it('throttles stats refreshes to 250 ms', () => {
    const { monitor } = setup();
    expect(monitor.shouldRefreshStats(1000)).toBe(true);
    expect(monitor.shouldRefreshStats(1100)).toBe(false);
    expect(monitor.shouldRefreshStats(1250)).toBe(true);
  });
});
