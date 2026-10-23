/**
 * Offline analysis of the sample track, not import-time detection: an
 * onset-flux envelope plus a DP beat tracker put it at 130.00 BPM with the
 * first beat at 0.02 s. Bars 41–56 are a high-energy 16-bar window, so that
 * is the default loop.
 *
 * These values describe the demo bundle's song. The audio itself ships only
 * inside `koto-chill.dmxsim`, so the app never carries a second copy of it;
 * this module is just the metadata the generator and tests need.
 *
 * ADR-003 wants analysis to be a real, correctable import step. These numbers
 * are a hand-off placeholder until that exists.
 */
export const TRACK = {
  title: 'The Koto Chill',
  artist: 'zircon',
  bpm: 130,
  firstBeatSec: 0.02,
  beatsPerBar: 4,
  /** 1-based bar of the first downbeat in the loop. */
  loopStartBar: 41,
  loopBars: 16,
} as const;

const beatSec = 60 / TRACK.bpm;
const barSec = beatSec * TRACK.beatsPerBar;
export const loopStartSec = TRACK.firstBeatSec + (TRACK.loopStartBar - 1) * barSec;
export const loopEndSec = loopStartSec + TRACK.loopBars * barSec;
