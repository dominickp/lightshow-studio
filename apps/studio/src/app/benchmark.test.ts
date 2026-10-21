import { describe, expect, it } from 'vitest';
import {
  BenchmarkRecorder,
  buildBenchCues,
  machineInfo,
  percentile,
  rigSignature,
  type FrameSample,
} from './benchmark';
import type { FixturePlacement } from '@dmxsim/show-model';

const fixture = (id: string, kind: string, capabilities: Record<string, boolean> = {}): FixturePlacement =>
  ({
    id,
    profile: {
      kind,
      capabilities: {
        dimmer: true,
        color: 'rgb',
        panTilt: false,
        zoom: false,
        focus: false,
        strobe: false,
        gobo: false,
        prism: false,
        rotation: false,
        ...capabilities,
      },
    },
  }) as unknown as FixturePlacement;

describe('percentile', () => {
  it('uses nearest rank and tolerates empty input', () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10], 0.95)).toBe(10);
    expect(percentile([4, 1, 3, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 1)).toBe(4);
  });
});

describe('rigSignature', () => {
  it('is stable regardless of fixture order', () => {
    const a = rigSignature([fixture('a', 'wash'), fixture('b', 'moving-head')]);
    const b = rigSignature([fixture('b', 'moving-head'), fixture('a', 'wash')]);
    expect(a).toBe(b);
    expect(a).toBe('2|moving-head:1,wash:1');
  });

  it('changes when the rig changes', () => {
    expect(rigSignature([fixture('a', 'wash')])).not.toBe(rigSignature([fixture('a', 'wash'), fixture('b', 'wash')]));
  });
});

describe('buildBenchCues', () => {
  it('creates the same cues every call, independent of project data', () => {
    const fixtures = [fixture('a', 'wash'), fixture('b', 'moving-head', { panTilt: true })];
    expect(buildBenchCues(fixtures, 90, 8)).toEqual(buildBenchCues(fixtures, 90, 8));
  });

  it('covers the window densely without firing cue audio', () => {
    const fixtures = [fixture('a', 'wash'), fixture('b', 'cryo-jet')];
    const cues = buildBenchCues(fixtures, 90, 8);
    expect(cues).toHaveLength(2 * 9);
    expect(cues.every((cue) => cue.action !== 'fire')).toBe(true);
    expect(cues.every((cue) => cue.startSec >= 90 && cue.endSec <= 98)).toBe(true);
  });

  it('picks actions the fixture supports', () => {
    const panTilt = buildBenchCues([fixture('a', 'moving-head', { panTilt: true })], 0, 4);
    expect(panTilt.some((cue) => cue.action === 'sweep')).toBe(true);
    const noCaps = buildBenchCues([fixture('a', 'unknown', { dimmer: false })], 0, 4);
    expect(noCaps.every((cue) => cue.action === 'hold')).toBe(true);
  });
});

describe('machineInfo', () => {
  const base = {
    gpu: 'Apple M1 Pro',
    cores: 10,
    devicePixelRatio: 2,
    viewport: '1512x800',
    userAgent: 'Mozilla/5.0',
  };

  it('gives the same id for the same hardware', () => {
    expect(machineInfo(base).id).toBe(machineInfo({ ...base }).id);
  });

  it('separates machines by GPU, cores and browser build', () => {
    const laptop = machineInfo(base).id;
    expect(machineInfo({ ...base, gpu: 'NVIDIA RTX 4070' }).id).not.toBe(laptop);
    expect(machineInfo({ ...base, cores: 16 }).id).not.toBe(laptop);
    expect(machineInfo({ ...base, userAgent: 'Firefox' }).id).not.toBe(laptop);
  });

  it('keeps viewport out of the id but reports it', () => {
    expect(machineInfo({ ...base, viewport: '800x600' }).id).toBe(machineInfo(base).id);
    expect(machineInfo({ ...base, viewport: '800x600' }).viewport).toBe('800x600');
  });
});

describe('BenchmarkRecorder', () => {
  const sample = (frameMs: number): FrameSample => ({
    frameMs,
    cpuMs: frameMs / 2,
    drawCalls: 100,
    triangles: 1000,
  });

  it('discards warmup frames and stops after the measure window', () => {
    const recorder = new BenchmarkRecorder(100, 200);
    recorder.start(0);
    let done = false;
    let now = 0;
    while (!done && now < 1000) {
      now += 10;
      done = recorder.sample(sample(10), now);
    }
    expect(done).toBe(true);
    // 0–100 ms warmup discarded, then 100–300 ms sampled.
    expect(recorder.count).toBe(20);
  });

  it('reports percentiles and counts stutters relative to the median', () => {
    const recorder = new BenchmarkRecorder(0, 100);
    recorder.start(0);
    const frames = [10, 10, 10, 10, 10, 10, 10, 10, 10, 60];
    frames.forEach((frameMs, index) => recorder.sample(sample(frameMs), (index + 1) * 10));
    const result = recorder.summarize({
      scenario: 'test',
      startedAt: '2026-01-01T00:00:00.000Z',
      backend: 'WebGL2',
      resolutionScale: 1,
      fixtureCount: 2,
      machine: machineInfo({
        gpu: 'Test GPU',
        cores: 8,
        devicePixelRatio: 1,
        viewport: '1280x720',
        userAgent: 'test',
      }),
      rigSignature: '2|wash:2',
      options: { startSec: 0, warmupMs: 0, measureMs: 100, orbit: true, orbitSpeed: 4 },
    });
    expect(result.frames).toBe(10);
    expect(result.frameMs.p50).toBe(10);
    expect(result.frameMs.max).toBe(60);
    expect(result.fps.p50).toBe(100);
    expect(result.longFrames).toBe(1);
    expect(result.stutterFrames).toBe(1);
    expect(result.longFrameRatio).toBe(0.1);
  });
});
