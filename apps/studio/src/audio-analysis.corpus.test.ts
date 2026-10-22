import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeTempo } from './audio-analysis';

/**
 * Regression test against real recordings.
 *
 * Tempo detection used to be tuned against one hand-measured song, which hid
 * whole classes of failure: a 200 BPM track could not even be represented by
 * the old 60–200 BPM search range. These clips are short excerpts of real
 * tracks whose tempo is known from their chart data, and they span 50–240 BPM.
 *
 * They are small mono WAV files so the test needs no audio decoder and no
 * browser. See ADR-003 in `docs/agent_docs/decisions.md` for how the fixtures
 * were produced and how to extend them.
 */

interface Fixture {
  file: string;
  bpm: number;
  song: string;
}

const FIXTURES = join(__dirname, 'audio-analysis.fixtures');
const corpus = JSON.parse(
  readFileSync(join(FIXTURES, 'corpus.json'), 'utf8'),
) as Fixture[];

const SAMPLE_RATE = 22050;

/** Read a 16-bit mono PCM WAV file into samples in [-1, 1]. */
function readWav(path: string): Float32Array {
  const buffer = readFileSync(path);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a WAV file`);
  }
  let offset = 12;
  let dataStart = -1;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`${path} has no data chunk`);
  const count = Math.floor(dataLength / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = buffer.readInt16LE(dataStart + i * 2) / 32768;
  }
  return samples;
}

/** True when `detected` is within 2% of `truth` or a simple metrical relative. */
function matchesTempo(detected: number, truth: number): boolean {
  return [1, 2, 3, 4, 0.5, 1 / 3, 1 / 4].some(
    (relation) => Math.abs(detected - truth * relation) / (truth * relation) < 0.02,
  );
}

describe('tempo detection on real recordings', () => {
  for (const fixture of corpus) {
    it(`offers ${fixture.bpm} BPM for ${fixture.song}`, () => {
      const samples = readWav(join(FIXTURES, fixture.file));
      const result = analyzeTempo(samples, SAMPLE_RATE);

      // Never leave the user with nothing: a best guess is always produced.
      expect(result.bpm).not.toBeNull();
      expect(result.candidates.length).toBeGreaterThan(0);

      // The right tempo must at least be one click away in the dialog.
      const offered = result.candidates.some(
        (candidate) => Math.abs(candidate.bpm - fixture.bpm) / fixture.bpm < 0.02,
      );
      expect(offered, `candidates ${result.candidates.map((c) => c.bpm.toFixed(1)).join(', ')}`)
        .toBe(true);

      // A plausible first beat, so the grid is usable before any correction.
      expect(result.offsetSec).toBeGreaterThanOrEqual(0);
      expect(result.offsetSec).toBeLessThan(60 / (result.bpm ?? 1));
    }, 20_000);
  }

  it('guesses the tempo outright for most tracks', () => {
    const exact = corpus.filter((fixture) => {
      const result = analyzeTempo(readWav(join(FIXTURES, fixture.file)), SAMPLE_RATE);
      return result.bpm !== null && matchesTempo(result.bpm, fixture.bpm);
    }).length;
    /*
     * Octave and 3:2 ambiguity is real: a half-time feel is genuinely both 90
     * and 180 BPM. The bar is that the best guess is musically sensible for
     * the clear majority, not for every track.
     */
    expect(exact).toBeGreaterThanOrEqual(Math.ceil(corpus.length * 0.5));
  }, 120_000);

  it('reports no tempo for silence', () => {
    const result = analyzeTempo(new Float32Array(SAMPLE_RATE * 4), SAMPLE_RATE);
    expect(result.bpm).toBeNull();
    expect(result.candidates).toEqual([]);
  });
});
