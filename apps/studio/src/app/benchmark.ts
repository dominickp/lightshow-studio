import { defaultLedLook, type FixturePlacement, type LedSurface } from '@dmxsim/show-model';
import type { Cue, CueAction } from '../arrangement/types';

/**
 * Reproducible render benchmark for the studio app.
 *
 * The scenario is **self-contained**: it builds its own cue set from whatever
 * rig is loaded instead of reading clips from the sample project, so editing
 * `resources/sample_projects/...` never invalidates a comparison. The rig does
 * change the numbers, so every result carries a `rigSignature` — runs with a
 * different signature are not comparable and the report script flags them.
 *
 * Cost is deliberately small: ~3.3 s of measurement (0.9 s warmup + 2.4 s
 * sampling). The orbit is sped up so that short window still sweeps most of
 * the frontal arc, which keeps the sample representative of a full orbit pass.
 */
export interface BenchmarkScenario {
  name: string;
  /** Song time the run starts at; the bar grid is only used for phase. */
  startSec: number;
  /** Length of the generated clip window, in seconds. */
  windowSec: number;
  /** Discarded after seeking; covers shader compile and texture upload. */
  warmupMs: number;
  /** Sampled window. 2.4 s is ~150 frames at 60 fps. */
  measureMs: number;
  /** Auto-orbit is on: camera motion changes what is culled each frame. */
  orbit: boolean;
  /** Multiplies the orbit's angular speed. */
  orbitSpeed: number;
}

export const BENCH_SCENARIO: BenchmarkScenario = {
  name: 'dense-demo',
  startSec: 90,
  windowSec: 8,
  warmupMs: 900,
  measureMs: 2400,
  orbit: true,
  orbitSpeed: 4,
};

/** Versioned workload: never compare fixed-size runs with legacy pane-sized runs. */
export const BENCH_RENDER = {
  protocol: 'fixed-720p-v1',
  width: 1280,
  height: 720,
  pixelRatio: 1,
} as const;

/** Shared by resize and adaptive-resolution paths, including during warmup. */
export function benchmarkRenderSize(active: boolean, width: number, height: number, pixelRatio: number) {
  return active ? BENCH_RENDER : { width, height, pixelRatio };
}

export interface FrameSample {
  frameMs: number;
  cpuMs: number;
  drawCalls: number;
  triangles: number;
}

/**
 * What the run executed on. Two machines can differ by 3x on the same build,
 * so the id gates comparisons: only runs with the same id are comparable.
 */
export interface MachineInfo {
  /** Short stable hash of GPU + core count + user agent. */
  id: string;
  gpu: string;
  cores: number;
  /** `navigator.deviceMemory` in GB, when the browser reports it. */
  memoryGb?: number;
  devicePixelRatio: number;
  /** CSS viewport the renderer draws into, e.g. `1280x720`. */
  viewport: string;
  userAgent: string;
}

/** FNV-1a, base36 — short enough to eyeball in a log line. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(6, '0');
}

/** Build the machine stamp; the id must depend only on stable hardware facts. */
export function machineInfo(input: {
  gpu: string;
  cores: number;
  memoryGb?: number;
  devicePixelRatio: number;
  viewport: string;
  userAgent: string;
}): MachineInfo {
  const { gpu, cores, memoryGb, devicePixelRatio, viewport, userAgent } = input;
  const info: MachineInfo = {
    id: shortHash(`${gpu}|${cores}|${userAgent}`),
    gpu,
    cores,
    devicePixelRatio,
    viewport,
    userAgent,
  };
  if (memoryGb !== undefined) info.memoryGb = memoryGb;
  return info;
}

interface Bucket {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface BenchmarkResult {
  scenario: string;
  startedAt: string;
  /** Frames sampled after warmup. */
  frames: number;
  measuredMs: number;
  /** Derived from `frameMs` percentiles: 1000 / ms, one decimal. */
  fps: Bucket;
  frameMs: Bucket;
  cpuMs: Bucket;
  /** Frames slower than 2x the median — the tail (jank) signal. */
  longFrames: number;
  /**
   * Frames over 50 ms — a visible hitch (3+ vsyncs at 60 Hz). A 2x-median rule
   * alone flags ordinary display jitter, so stutters use a fixed floor.
   */
  stutterFrames: number;
  longFrameRatio: number;
  drawCalls: number;
  triangles: number;
  backend: string;
  resolutionScale: number;
  /** Absent on legacy runs whose workload followed the IDE pane size. */
  render?: { protocol: string; width: number; height: number; pixelRatio: number };
  fixtureCount: number;
  /** Hardware the run executed on; different ids are not comparable. */
  machine: MachineInfo;
  /** `fixtureCount / kinds`, e.g. `34:moving-head-9,wash-12`-style summary. */
  rigSignature: string;
  options: {
    startSec: number;
    warmupMs: number;
    measureMs: number;
    orbit: boolean;
    orbitSpeed: number;
  };
  /** Conditions that make this run less trustworthy, e.g. audio never started. */
  warnings?: string[];
}

/** Compatibility key shared by the report and tests; legacy runs stay separate. */
export function benchmarkComparisonKey(run: {
  machine?: MachineInfo;
  render?: BenchmarkResult['render'];
  backend: string;
  scenario: string;
  rigSignature: string;
  resolutionScale?: number;
  options?: BenchmarkResult['options'];
}): string | null {
  if (run.machine === undefined) return null;
  const render = run.render;
  return JSON.stringify([
    run.machine.id, run.backend, run.scenario, run.rigSignature,
    render === undefined
      ? ['legacy', run.machine.viewport, run.machine.devicePixelRatio, run.resolutionScale]
      : [render.protocol, render.width, render.height, render.pixelRatio],
    run.options === undefined ? null : [
      run.options.startSec, run.options.warmupMs, run.options.measureMs,
      run.options.orbit, run.options.orbitSpeed,
    ],
  ]);
}

/** Options accepted by `window.__dmxsim.benchmark(options)`. */
export interface BenchmarkOptions {
  startSec?: number;
  measureMs?: number;
  warmupMs?: number;
  orbit?: boolean;
  orbitSpeed?: number;
}

/** Nearest-rank percentile over an unsorted array. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank]!;
}

const round = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const bucket = (values: readonly number[]): Bucket => ({
  p50: round(percentile(values, 0.5), 2),
  p95: round(percentile(values, 0.95), 2),
  p99: round(percentile(values, 0.99), 2),
  max: round(Math.max(0, ...values), 2),
});

const mean = (values: readonly number[]): number =>
  values.length === 0 ? 0 : round(values.reduce((total, value) => total + value, 0) / values.length, 0);

/** Collapse a rig into a stable string so incomparable runs are obvious. */
export function rigSignature(fixtures: readonly FixturePlacement[]): string {
  const kinds = new Map<string, number>();
  for (const fixture of fixtures) {
    const kind = fixture.profile.kind;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const parts = [...kinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => `${kind}:${count}`);
  return `${fixtures.length}|${parts.join(',')}`;
}

/** Actions that exercise the expensive paths without firing cue audio. */
function benchActions(fixture: FixturePlacement): CueAction[] {
  const caps = fixture.profile.capabilities;
  if (caps.panTilt) return ['sweep', 'sweep', 'pulse'];
  if (caps.strobe) return ['strobe', 'pulse', 'hold'];
  if (caps.dimmer) return ['pulse', 'fade', 'hold'];
  return ['hold'];
}

/**
 * Build a dense, deterministic clip set: 1.2 s clips every 0.8 s, so roughly
 * 1.5 clips overlap per fixture — about the density of the shipped demo's
 * busiest section, but independent of it.
 */
export function buildBenchCues(
  fixtures: readonly FixturePlacement[],
  startSec: number,
  windowSec: number,
): Cue[] {
  const stride = 0.8;
  const length = 1.2;
  // Keep every clip inside the window so the last one cannot outlive the run.
  const count = Math.max(1, Math.floor(Math.max(0, windowSec - length) / stride) + 1);
  const cues: Cue[] = [];
  fixtures.forEach((fixture, fixtureIndex) => {
    const actions = benchActions(fixture);
    for (let index = 0; index < count; index += 1) {
      const clipStart = startSec + index * stride;
      cues.push({
        id: `bench-${fixtureIndex}-${index}`,
        fixtureId: fixture.id,
        startSec: clipStart,
        endSec: clipStart + length,
        colorIndex: (fixtureIndex * 3 + index) % 7,
        action: actions[index % actions.length]!,
        fadeInSec: 0,
      });
    }
  });
  return cues;
}

/** One LED-wall clip per surface covering the measured window. */
export function buildBenchSurfaceCues(
  surfaces: readonly LedSurface[],
  startSec: number,
  windowSec: number,
): Cue[] {
  return surfaces.map((surface, index) => ({
    id: `bench-surface-${index}`,
    fixtureId: surface.id,
    surfaceId: surface.id,
    startSec,
    endSec: startSec + windowSec,
    colorIndex: index % 7,
    action: 'hold',
    look: defaultLedLook(index % 2 === 0 ? 'gradient' : 'radial'),
    fadeInSec: 0,
    opacity: 1,
  }));
}

/**
 * Collects frame samples around a warmup window and turns them into a result.
 * Pure timing logic, so it can be unit tested without a browser.
 */
export class BenchmarkRecorder {
  private startedAt = 0;
  private samples: FrameSample[] = [];

  constructor(
    private readonly warmupMs: number,
    private readonly measureMs: number,
  ) {}

  start(now: number): void {
    this.startedAt = now;
    this.samples = [];
  }

  /** Feed one rendered frame; returns true once the sample window closes. */
  sample(sample: FrameSample, now: number): boolean {
    // Strictly after warmup: the boundary frame is still part of the warmup.
    if (now - this.startedAt <= this.warmupMs) return false;
    this.samples.push(sample);
    return now - this.startedAt >= this.warmupMs + this.measureMs;
  }

  get count(): number {
    return this.samples.length;
  }

  summarize(meta: {
    scenario: string;
    startedAt: string;
    backend: string;
    resolutionScale: number;
    fixtureCount: number;
    machine: MachineInfo;
    rigSignature: string;
    options: BenchmarkResult['options'];
  }): BenchmarkResult {
    const frameMsValues = this.samples.map((sample) => sample.frameMs);
    const cpuMsValues = this.samples.map((sample) => sample.cpuMs);
    const median = percentile(frameMsValues, 0.5);
    const longFrames = frameMsValues.filter((ms) => ms > median * 2).length;
    const stutterFrames = frameMsValues.filter((ms) => ms > 50).length;
    const frameMs = bucket(frameMsValues);
    const measured = frameMsValues.reduce((total, ms) => total + ms, 0);

    return {
      scenario: meta.scenario,
      startedAt: meta.startedAt,
      frames: this.samples.length,
      measuredMs: round(measured, 0),
      fps: {
        p50: round(1000 / Math.max(1e-6, frameMs.p50), 1),
        p95: round(1000 / Math.max(1e-6, frameMs.p95), 1),
        p99: round(1000 / Math.max(1e-6, frameMs.p99), 1),
        max: round(1000 / Math.max(1e-6, frameMs.max), 1),
      },
      frameMs,
      cpuMs: bucket(cpuMsValues),
      longFrames,
      stutterFrames,
      longFrameRatio: this.samples.length === 0 ? 0 : round(longFrames / this.samples.length, 3),
      drawCalls: mean(this.samples.map((sample) => sample.drawCalls)),
      triangles: mean(this.samples.map((sample) => sample.triangles)),
      backend: meta.backend,
      resolutionScale: meta.resolutionScale,
      fixtureCount: meta.fixtureCount,
      machine: meta.machine,
      rigSignature: meta.rigSignature,
      options: meta.options,
    };
  }
}
