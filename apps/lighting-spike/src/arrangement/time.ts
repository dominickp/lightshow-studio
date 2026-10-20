import { clamp } from '../lib/math';
import type { CueTimeline } from './types';

const gridDivisionSec = (timeline: CueTimeline): number | null =>
  timeline.bpm === null || timeline.bpm <= 0 ? null : 60 / timeline.bpm / 4;

/** Snap an absolute time to the sixteenth-note grid, clamped to the song. */
export function snapTime(timeline: CueTimeline | null, timeSec: number): number {
  if (timeline === null) return clamp(timeSec, 0, 0);
  const divisionSec = gridDivisionSec(timeline);
  if (divisionSec === null) return clamp(timeSec, 0, timeline.durationSec);
  return clamp(
    timeline.firstBeatSec + Math.round((timeSec - timeline.firstBeatSec) / divisionSec) * divisionSec,
    0,
    timeline.durationSec,
  );
}

/** Snap a movement delta (rather than an absolute time) to the grid. */
export function snapDelta(timeline: CueTimeline | null, deltaSec: number): number {
  if (timeline === null) return deltaSec;
  const divisionSec = gridDivisionSec(timeline);
  return divisionSec === null ? deltaSec : Math.round(deltaSec / divisionSec) * divisionSec;
}

/** Default new-clip length: two beats, or two seconds without a tempo. */
export function defaultClipLength(timeline: CueTimeline | null): number {
  const bpm = timeline?.bpm;
  return bpm !== null && bpm !== undefined && bpm > 0 ? (60 / bpm) * 2 : 2;
}
