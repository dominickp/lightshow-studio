/**
 * Import-time tempo analysis for a song the user brings into the studio.
 *
 * There is no offline authoring step for a user's own track, so the app has to
 * guess the beat grid from the audio itself. The estimator is deliberately
 * compact rather than a general-purpose music analyser, but it is tuned against
 * a corpus of real tracks rather than one hand-measured song (see
 * `audio-analysis.corpus.test.ts`).
 *
 * Tempo detection is inherently ambiguous: a half-time feel is genuinely both
 * 90 and 180 BPM, and a busy triplet subdivision supports 3:2 as well as 1:1.
 * So the analyser does not pretend to one answer. It returns a ranked list of
 * metrical relatives (`candidates`), and the import dialog offers them as
 * one-click alternatives with the fields still free to edit.
 *
 * All of the maths runs on frame envelopes, so the expensive part is a single
 * pass over the samples. Call it from the decoded `AudioBuffer` so the app can
 * reuse the decode that playback already needs.
 */

export interface TempoCandidate {
  bpm: number;
  /** Time of the first beat, in `[0, beat length)`. */
  offsetSec: number;
  /**
   * Relation to the winning estimate: `1` is the winner itself, `2` is double
   * time, `0.5` half time, and so on. `0` marks a tempo the scan found in the
   * audio that is not a simple multiple of the winner.
   */
  relation: number;
}

export interface TempoAnalysis {
  /** Best tempo guess, or `null` when the audio has no usable pulse at all. */
  bpm: number | null;
  /** Time of the first beat, in `[0, beat length)`. */
  offsetSec: number;
  /** 0–1 confidence used to warn the user about a weak result. */
  confidence: number;
  /**
   * Best guess first, then its metrical relatives that fit the editable BPM
   * range. Empty when no tempo was found.
   */
  candidates: TempoCandidate[];
}

/**
 * Search range. Real material spans torch songs (~50 BPM) to hardcore
 * (~240 BPM); the old 60–200 window could not represent either end, which is
 * why a 200 BPM track had no way to succeed.
 */
const MIN_SEARCH_BPM = 40;
const MAX_SEARCH_BPM = 250;
/** Coarse scan step, in BPM. Refinement narrows the winner to 0.01. */
const COARSE_STEP = 0.5;
/** The BPM field in the dialog accepts this range. */
const MIN_BPM = 40;
const MAX_BPM = 300;

/**
 * Frame size / hop for the onset envelope (~5.8 ms hop at 44.1 kHz).
 *
 * A short window matters more than frequency resolution here: a transient must
 * land in one or two frames, not smear across four, or the detected beat phase
 * is biased early by half a window.
 */
const FRAME = 512;
const HOP = 256;

/** Low-pass cutoff for the kick/bass band. */
const LOW_BAND_HZ = 150;

/** Metrical relatives offered as alternatives, the winner itself excluded. */
const RELATIONS = [2, 0.5, 3, 1 / 3, 4, 1 / 4, 1.5, 0.75, 2 / 3, 2.5] as const;

/** Total number of one-click options shown in the dialog, winner included. */
const CANDIDATE_LIMIT = 9;

/**
 * Longest stretch of audio used for the search. Tempo is assumed constant, so
 * 90 seconds is ample evidence and keeps a long DJ set from taking seconds to
 * analyse. The window starts slightly in, because intros are often quiet or
 * free-time and would only dilute the pulse.
 */
const ANALYSIS_SEC = 60;
const ANALYSIS_START_FRACTION = 0.08;

/**
 * How much the kick band steers the beat phase.
 *
 * It is the more reliable witness for *which* pulse is the beat: on produced
 * music the loudest broadband onsets are often hi-hats on the offbeat, while
 * the low band only fires on the kick. When it has a clear pulse of its own it
 * outvotes the broadband envelope; when it is mostly noise it barely counts.
 */
function lowPhaseWeight(low: Float32Array, periodFrames: number): number {
  return phaseContrast(low, periodFrames).contrast > 0.3 ? 3 : 0.6;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value));

const log2 = (value: number): number => Math.log(value) / Math.LN2;

/**
 * Weak preference for ordinary song tempos, used only to break octave ties the
 * audio itself cannot settle. It is a prior, not a constraint: a strong enough
 * pulse at 200 BPM still beats a weak one at 100.
 */
function tempoPrior(bpm: number): number {
  const value = log2(bpm / 120) / 0.7;
  return Math.exp(-0.5 * value * value);
}

/** Downmix an `AudioBuffer` to mono for analysis. */
function monoFromBuffer(buffer: AudioBuffer): Float32Array {
  const length = buffer.length;
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] = mono[i]! + (data[i] ?? 0);
  }
  const scale = 1 / buffer.numberOfChannels;
  for (let i = 0; i < length; i += 1) mono[i] = (mono[i] ?? 0) * scale;
  return mono;
}

/** Analyse a decoded buffer. */
export function analyzeAudioBuffer(buffer: AudioBuffer): TempoAnalysis {
  return analyzeTempo(monoFromBuffer(buffer), buffer.sampleRate);
}

/**
 * Estimate the beat grid of a mono signal.
 *
 * 1. Build two onset envelopes: a broadband one (first difference, which
 *    favours drum transients) and a kick-band one. The broadband envelope
 *    catches subdivisions; the low band identifies which pulse is the beat.
 * 2. Scan every candidate tempo, scoring the onset energy that falls on the
 *    best phase of that period. A grid that lines up with real accents scores
 *    high; one that falls between them does not.
 * 3. Refine the winner to 0.01 BPM and resolve its beat phase exactly.
 * 4. Emit the winner plus its metrical relatives, so the dialog can offer
 *    ×2 / ÷2 / ×3 / ÷3 instead of making the user type a number.
 */
export function analyzeTempo(samples: Float32Array, sampleRate: number): TempoAnalysis {
  const empty: TempoAnalysis = { bpm: null, offsetSec: 0, confidence: 0, candidates: [] };
  const window = analysisWindow(samples, sampleRate);
  const broad = onsetEnvelope(window);
  if (broad === null) return empty;
  const low = onsetEnvelope(lowPassed(window, sampleRate, LOW_BAND_HZ), false);
  if (low === null) return empty;

  const hopSec = HOP / sampleRate;
  /*
   * Squaring the envelope weights strong accents over quiet subdivisions. That
   * is what separates a downbeat from a busy offbeat hi-hat pattern, which is
   * otherwise the main source of 3:2 errors.
   *
   * Each band is then scaled to unit mean. Squaring leaves the peakier band
   * with a much larger average score, and without this the kick band's weight
   * would depend on how spiky the hats happened to be rather than on the
   * intended comparison.
   */
  const considered = [unitMean(sharpen(broad)), unitMean(sharpen(low))];

  const coarse = scan(considered, hopSec);
  if (coarse === null) return empty;

  const winner = refineGrid(
    considered[0]!,
    considered[1]!,
    coarse.peaks[0]!.bpm,
    hopSec,
    sampleRate,
    true,
  );
  const confidence = clamp(phaseContrast(broad, 60 / winner.bpm / hopSec).contrast, 0, 1);

  /*
   * Candidates come from two sources. The metrical relatives come first: they
   * are the answers users actually need (half time, double time, three against
   * two) and they are cheap to name. The scan peaks follow, covering tempos the
   * audio supports that a fixed list cannot express.
   */
  const seeds: { bpm: number; relation: number }[] = [];
  for (const relation of RELATIONS) {
    seeds.push({ bpm: winner.bpm * relation, relation });
  }
  for (const peak of coarse.peaks) {
    seeds.push({ bpm: peak.bpm, relation: 0 });
  }

  const candidates: TempoCandidate[] = [{ ...winner, relation: 1 }];
  for (const seed of seeds) {
    if (seed.bpm < MIN_BPM || seed.bpm > MAX_BPM) continue;
    if (seed.bpm === winner.bpm) continue;
    if (candidates.some((other) => Math.abs(other.bpm - seed.bpm) < 0.5)) continue;
    /*
     * Alternates get a lighter fit: their tempo still needs to be right to a
     * hundredth, but the importer refines up to eight of them, and a coarse
     * first stage is most of the cost saving.
     */
    candidates.push({
      ...refineGrid(considered[0]!, considered[1]!, seed.bpm, hopSec, sampleRate, false),
      relation: seed.relation,
    });
  }
  // Best guess stays first; the rest follow in the order they were seeded,
  // which is nearest-metrical-relative first, then scan strength.
  candidates.length = Math.min(candidates.length, CANDIDATE_LIMIT);
  candidates[0] = { ...winner, relation: 1 };

  return { bpm: winner.bpm, offsetSec: winner.offsetSec, confidence, candidates };
}

/** A grid whose period and phase have been fitted to the onset envelopes. */
interface GridFit {
  bpm: number;
  offsetSec: number;
}

/**
 * The stretch of samples the search runs on, or the whole clip when it is
 * shorter than `ANALYSIS_SEC`.
 *
 * Returns a `subarray`, which shares the caller's memory: nothing is copied and
 * the original buffer is left untouched.
 */
function analysisWindow(samples: Float32Array, sampleRate: number): Float32Array {
  const maxLength = Math.round(ANALYSIS_SEC * sampleRate);
  if (samples.length <= maxLength) return samples;
  const start = Math.round(samples.length * ANALYSIS_START_FRACTION);
  return samples.subarray(start, Math.min(samples.length, start + maxLength));
}

/** Low-passed copy, used to see the kick/bass line separately from hats. */
function lowPassed(samples: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const smoothing = 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);
  const filtered = new Float32Array(samples.length);
  let state = 0;
  for (let i = 0; i < samples.length; i += 1) {
    state += smoothing * ((samples[i] ?? 0) - state);
    filtered[i] = state;
  }
  return filtered;
}

/**
 * Log-energy onset strength, normalised to zero mean and unit deviation so
 * scores do not depend on how loud the track was mastered.
 *
 * Returns `null` for clips too short to frame, or for silence: a flat envelope
 * carries no pulse and would otherwise produce a confident nonsense tempo.
 */
function onsetEnvelope(samples: Float32Array, highPass = true): Float32Array | null {
  if (samples.length < FRAME * 4) return null;
  const frameCount = Math.floor((samples.length - FRAME) / HOP) + 1;
  const logEnergy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * HOP;
    let energy = 0;
    if (highPass) {
      for (let i = 1; i < FRAME; i += 1) {
        const diff = (samples[start + i] ?? 0) - (samples[start + i - 1] ?? 0);
        energy += diff * diff;
      }
    } else {
      for (let i = 0; i < FRAME; i += 1) {
        const value = samples[start + i] ?? 0;
        energy += value * value;
      }
    }
    logEnergy[frame] = Math.log1p(energy / FRAME);
  }

  const onset = new Float32Array(frameCount);
  let total = 0;
  for (let frame = 1; frame < frameCount; frame += 1) {
    onset[frame] = Math.max(0, (logEnergy[frame] ?? 0) - (logEnergy[frame - 1] ?? 0));
    total += onset[frame] ?? 0;
  }
  if (total <= 1e-6) return null;

  // Remove the local mean so a loud section does not dominate the score.
  const smoothed = new Float32Array(frameCount);
  const radius = 24;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;
    let count = 0;
    for (let k = -radius; k <= radius; k += 1) {
      const index = frame + k;
      if (index < 0 || index >= frameCount) continue;
      sum += onset[index] ?? 0;
      count += 1;
    }
    smoothed[frame] = Math.max(0, (onset[frame] ?? 0) - sum / Math.max(1, count));
  }

  let mean = 0;
  for (let i = 0; i < frameCount; i += 1) mean += smoothed[i] ?? 0;
  mean /= Math.max(1, frameCount);
  let variance = 0;
  for (let i = 0; i < frameCount; i += 1) {
    const delta = (smoothed[i] ?? 0) - mean;
    variance += delta * delta;
  }
  const deviation = Math.sqrt(variance / Math.max(1, frameCount));
  if (deviation <= 1e-9) return null;
  for (let i = 0; i < frameCount; i += 1) {
    smoothed[i] = ((smoothed[i] ?? 0) - mean) / deviation;
  }
  return smoothed;
}

/** Emphasise strong accents: `max(0, x)²`. */
function sharpen(envelope: Float32Array): Float32Array {
  const result = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i += 1) {
    const value = envelope[i] ?? 0;
    result[i] = value > 0 ? value * value : 0;
  }
  return result;
}

/** Scale an envelope so its mean is 1, making scores comparable across bands. */
function unitMean(envelope: Float32Array): Float32Array {
  let total = 0;
  for (let i = 0; i < envelope.length; i += 1) total += envelope[i] ?? 0;
  const mean = total / Math.max(1, envelope.length);
  if (mean <= 1e-9) return envelope;
  const result = new Float32Array(envelope.length);
  for (let i = 0; i < envelope.length; i += 1) result[i] = (envelope[i] ?? 0) / mean;
  return result;
}

/**
 * Mean onset energy on the grid `phase + k * period`.
 *
 * Samples are interpolated rather than rounded to the nearest frame. A transient
 * that falls between two frames would otherwise lose half its energy, which on
 * sparse material lets a 3:2 grid score as well as the true one.
 */
function gridScore(envelope: Float32Array, phase: number, periodFrames: number): number {
  const last = envelope.length - 1;
  let score = 0;
  let count = 0;
  for (let k = 0; ; k += 1) {
    const position = phase + k * periodFrames;
    if (position > last) break;
    const index = Math.floor(position);
    const fraction = position - index;
    const left = envelope[index] ?? 0;
    const right = index + 1 <= last ? (envelope[index + 1] ?? 0) : left;
    score += left + (right - left) * fraction;
    count += 1;
  }
  return count === 0 ? 0 : score / count;
}

/** Best phase for one period, and the onset energy it collects. */
function bestPhase(
  envelope: Float32Array,
  periodFrames: number,
  maxPhases = 32,
): { phase: number; score: number } {
  const phases = Math.max(8, Math.min(maxPhases, Math.round(periodFrames / 2)));
  const step = periodFrames / phases;
  let phase = 0;
  let score = -Infinity;
  for (let k = 0; k < phases; k += 1) {
    const candidate = k * step;
    const value = gridScore(envelope, candidate, periodFrames);
    if (value > score) {
      score = value;
      phase = candidate;
    }
  }
  /*
   * The coarse pass can miss a transient by most of one coarse step, and on
   * sharp material that costs half the energy: enough for a wrong tempo to
   * outscore the right one. Polish the winner within the step it was found in.
   */
  for (let delta = -step; delta <= step; delta += step / 8) {
    if (delta === 0) continue;
    const candidate = (((phase + delta) % periodFrames) + periodFrames) % periodFrames;
    const value = gridScore(envelope, candidate, periodFrames);
    if (value > score) {
      score = value;
      phase = candidate;
    }
  }
  return { phase, score };
}

/**
 * How much of the onset energy concentrates on one phase of the period, 0–1.
 * This is cheaper than `bestPhase` and is used for the reported confidence
 * because it compares every phase rather than only the sampled ones.
 */
function phaseContrast(
  envelope: Float32Array,
  periodFrames: number,
  bins = 48,
): { contrast: number; phase: number } {
  const sums = new Float64Array(bins);
  for (let i = 0; i < envelope.length; i += 1) {
    const value = envelope[i] ?? 0;
    if (value <= 0) continue;
    const bin = Math.min(bins - 1, Math.floor(((i % periodFrames) / periodFrames) * bins));
    sums[bin]! += value;
  }
  let total = 0;
  let bestBin = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    total += sums[bin]!;
    if (sums[bin]! > sums[bestBin]!) bestBin = bin;
  }
  const best = sums[bestBin]!;
  const contrast = best <= 1e-9 ? 0 : (best - total / bins) / best;
  return { contrast, phase: bestBin / bins };
}

/**
 * Coarse tempo search across the audible range.
 *
 * Every tempo is scored, then the strongest local maxima are returned rather
 * than just the single winner: those are the tempos the audio actually
 * supports, and they make useful alternatives when the winner is wrong.
 *
 * Returns `null` when nothing in the range scores at all.
 */
function scan(
  envelopes: Float32Array[],
  hopSec: number,
): { peaks: { bpm: number; score: number }[]; best: { bpm: number; score: number } } | null {
  const lags = Math.round((MAX_SEARCH_BPM - MIN_SEARCH_BPM) / COARSE_STEP) + 1;
  const tempos = new Float64Array(lags);
  const scores = new Float64Array(lags);
  let bestIndex = 0;
  let bestWeighted = -Infinity;
  for (let i = 0; i < lags; i += 1) {
    const bpm = MIN_SEARCH_BPM + i * COARSE_STEP;
    const periodFrames = 60 / bpm / hopSec;
    let score = 0;
    for (const envelope of envelopes) score += bestPhase(envelope, periodFrames).score;
    tempos[i] = bpm;
    scores[i] = score;
    const weighted = score * tempoPrior(bpm);
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestIndex = i;
    }
  }

  const peaks: { bpm: number; score: number }[] = [];
  // A peak must beat its neighbours 2% away, so the broad shoulders around one
  // tempo cannot fill the whole list.
  const reach = Math.max(1, Math.round(2 / COARSE_STEP));
  for (let i = 0; i < lags; i += 1) {
    const score = scores[i]!;
    let isPeak = true;
    for (let k = -reach; k <= reach; k += 1) {
      if (k === 0) continue;
      const other = i + k;
      if (other < 0 || other >= lags) continue;
      if (scores[other]! > score) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) peaks.push({ bpm: tempos[i]!, score });
  }
  if (peaks.length === 0) return null;
  peaks.sort((a, b) => b.score - a.score);

  const best = { bpm: tempos[bestIndex]!, score: scores[bestIndex]! };
  if (best.score <= 1e-6) return null;
  // The prior-weighted winner heads the list even if a raw peak outscored it.
  return { peaks: [best, ...peaks.filter((peak) => peak.bpm !== best.bpm)], best };
}

/**
 * Fit tempo and first beat around a candidate.
 *
 * The coarse scan is quantised to 0.5 BPM, far too loose for a grid that has to
 * stay aligned for several minutes, so the period is re-fitted at 0.01 BPM
 * against a sharp grid score. The phase search then lands the first beat on the
 * accent the kick band agrees with.
 */
function refineGrid(
  broad: Float32Array,
  low: Float32Array,
  initialBpm: number,
  hopSec: number,
  sampleRate: number,
  thorough: boolean,
): GridFit {
  let best: GridFit = { bpm: initialBpm, offsetSec: 0 };
  let bestScore = -Infinity;

  /*
   * Two stages. The coarse scan can be off by a couple of percent, so sweep
   * that band first at 0.2 BPM, then re-fit the winner at 0.01 BPM over a
   * narrow band. Searching the whole ±1% at 0.01 directly costs 200 grid
   * evaluations per candidate, which is where the importer used to stall.
   */
  const stage = (step: number, spread: number, phases: number): void => {
    for (let bpm = initialBpm * (1 - spread); bpm <= initialBpm * (1 + spread); bpm += step) {
      const periodFrames = 60 / bpm / hopSec;
      const weight = lowPhaseWeight(low, periodFrames);
      /*
       * Search around the best phase of both bands. The broadband envelope
       * often has no energy at all on the kick (the first difference removes
       * the low end), so starting only from its peak would never consider the
       * kick phase even though the kick band scores far higher there.
       */
      const anchors = [bestPhase(broad, periodFrames, phases).phase];
      const lowAnchor = bestPhase(low, periodFrames, phases).phase;
      if (Math.abs(lowAnchor - anchors[0]!) > 0.5) anchors.push(lowAnchor);
      const window = periodFrames / (phases * 6);
      for (const anchor of anchors) {
        for (let delta = -window * 2; delta <= window * 2; delta += window / 3) {
          const wrapped =
            (((anchor + delta) % periodFrames) + periodFrames) % periodFrames;
          const score =
            gridScore(broad, wrapped, periodFrames) +
            weight * gridScore(low, wrapped, periodFrames);
          if (score > bestScore) {
            bestScore = score;
            best = { bpm, offsetSec: wrapped * hopSec };
          }
        }
      }
    }
  };
  stage(0.2, 0.02, 10);
  initialBpm = best.bpm;
  stage(thorough ? 0.01 : 0.02, 0.002, thorough ? 24 : 12);

  /*
   * A frame is timestamped at its start, but a transient can sit anywhere in
   * that window. On average it arrives mid-window, so without this correction
   * every detected beat lands half a frame early (~4 ms at 44.1 kHz).
   */
  const periodSec = 60 / best.bpm;
  return {
    bpm: best.bpm,
    offsetSec: (best.offsetSec + FRAME / 2 / sampleRate) % periodSec,
  };
}
