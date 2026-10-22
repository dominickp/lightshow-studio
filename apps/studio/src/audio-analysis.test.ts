import { describe, expect, it } from 'vitest';
import { analyzeTempo } from './audio-analysis';

const SAMPLE_RATE = 22050;

/** Short noise burst every `periodSec`, which is what the analyser looks for. */
function clickTrack(bpm: number, offsetSec: number, durationSec = 24): Float32Array {
  const samples = new Float32Array(Math.round(durationSec * SAMPLE_RATE));
  const period = 60 / bpm;
  const burst = Math.round(0.012 * SAMPLE_RATE);
  for (let beat = 0; beat * period + offsetSec < durationSec; beat += 1) {
    const start = Math.round((offsetSec + beat * period) * SAMPLE_RATE);
    for (let i = 0; i < burst && start + i < samples.length; i += 1) {
      // Decaying noise, so the transient has a sharp high-frequency edge.
      const decay = 1 - i / burst;
      samples[start + i] = (Math.random() * 2 - 1) * decay;
    }
  }
  return samples;
}

/**
 * Kick on every beat plus louder hi-hats on the offbeat. The broadband
 * envelope prefers the hats, so this guards the low-band phase choice.
 */
function kicksAndHats(bpm: number, offsetSec: number, durationSec = 24): Float32Array {
  const samples = new Float32Array(Math.round(durationSec * SAMPLE_RATE));
  const period = 60 / bpm;
  const add = (startSec: number, length: number, value: (t: number) => number): void => {
    const start = Math.round(startSec * SAMPLE_RATE);
    const count = Math.round(length * SAMPLE_RATE);
    for (let i = 0; i < count && start + i < samples.length; i += 1) {
      samples[start + i] = (samples[start + i] ?? 0) + value(i / SAMPLE_RATE);
    }
  };
  for (let beat = 0; offsetSec + beat * period < durationSec; beat += 1) {
    const at = offsetSec + beat * period;
    // 60 Hz body with a short decay: low-band energy, weak high-frequency edge.
    add(at, 0.16, (t) => 0.9 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.05));
    // Offbeat hat: louder in the broadband envelope than the kick.
    add(at + period / 2, 0.05, (t) => 1.4 * (Math.random() * 2 - 1) * Math.exp(-t / 0.012));
  }
  return samples;
}

describe('analyzeTempo', () => {
  it('finds a 120 BPM grid and its first beat', () => {
    const result = analyzeTempo(clickTrack(120, 0.05), SAMPLE_RATE);
    expect(result.bpm).not.toBeNull();
    expect(Math.abs(result.bpm! - 120)).toBeLessThan(1);
    expect(Math.abs(result.offsetSec - 0.05)).toBeLessThan(0.02);
  });

  it('locks the phase to the kick rather than louder offbeat hats', () => {
    const result = analyzeTempo(kicksAndHats(120, 0.1), SAMPLE_RATE);
    expect(Math.abs(result.bpm! - 120)).toBeLessThan(1);
    expect(Math.abs(result.offsetSec - 0.1)).toBeLessThan(0.03);
  });

  it('finds a 128 BPM grid with an off-zero offset', () => {
    const result = analyzeTempo(clickTrack(128, 0.31), SAMPLE_RATE);
    expect(Math.abs(result.bpm! - 128)).toBeLessThan(1);
    expect(Math.abs(result.offsetSec - 0.31)).toBeLessThan(0.02);
  });

  it('keeps a fast tempo inside the editable range', () => {
    const result = analyzeTempo(clickTrack(174, 0), SAMPLE_RATE);
    expect(result.bpm).not.toBeNull();
    expect(result.bpm!).toBeGreaterThanOrEqual(70);
    expect(result.bpm!).toBeLessThanOrEqual(180);
    // 174 and its half-time counterpart 87 both fit the click pattern; the
    // import dialog offers ×2 / ÷2 so either is one click from correct.
    expect([87, 174].some((tempo) => Math.abs(result.bpm! - tempo) < 1)).toBe(true);
  });

  it('reports no tempo for silence', () => {
    const result = analyzeTempo(new Float32Array(SAMPLE_RATE * 4), SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it('reports no tempo for a clip that is too short', () => {
    const result = analyzeTempo(new Float32Array(100), SAMPLE_RATE);
    expect(result.bpm).toBeNull();
  });
});
