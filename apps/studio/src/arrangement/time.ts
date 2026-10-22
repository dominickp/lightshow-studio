import { clamp } from '../lib/math';
import type { CueTimeline } from './types';

const gridDivisionSec = (timeline: CueTimeline): number | null =>
  timeline.bpm === null || timeline.bpm <= 0 ? null : 60 / timeline.bpm / 4;

/** Snap an absolute time to the sixteenth-note grid, clamped to the song. */
export function snapTime(timeline: CueTimeline | null, timeSec: number): number {
  if (timeline === null) return clamp(timeSec, 0, 0);
  const divisionSec = gridDivisionSec(timeline);
  if (divisionSec === null) return clamp(timeSec, 0, timeline.durationSec);
  // The transport rests at 0 before the first beat, so the song start is an
  // edit position in its own right. Snapping a clip dropped there to the first
  // beat would put it just after the resting playhead, leaving the stage (and
  // LED wall) dark until playback crossed that beat.
  if (timeSec <= timeline.firstBeatSec) return 0;
  return clamp(
    timeline.firstBeatSec
      + Math.round((timeSec - timeline.firstBeatSec) / divisionSec) * divisionSec,
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

/**
 * Plain sixteenth-note snapping for playhead and loop dragging.
 *
 * Unlike `snapTime`, this has no song-start special case: a position inside the
 * lead-in snaps to the nearest grid line instead of collapsing to 0, so
 * scrubbing the intro still moves in sixteenths.
 */
export function snapTimeToGrid(timeline: CueTimeline | null, timeSec: number): number {
  if (timeline === null) return timeSec;
  if (timeline.bpm === null || timeline.bpm <= 0) {
    return clamp(timeSec, 0, timeline.durationSec);
  }
  const divisionSec = 60 / timeline.bpm / 4;
  return clamp(
    timeline.firstBeatSec
      + Math.round((timeSec - timeline.firstBeatSec) / divisionSec) * divisionSec,
    0,
    timeline.durationSec,
  );
}

/** Default new-clip length: two beats, or two seconds without a tempo. */
export function defaultClipLength(timeline: CueTimeline | null): number {
  const bpm = timeline?.bpm;
  return bpm !== null && bpm !== undefined && bpm > 0 ? (60 / bpm) * 2 : 2;
}

/** One measure in seconds; falls back to a second when the song has no beat grid. */
export function barLengthSec(timeline: CueTimeline | null): number {
  if (timeline === null || timeline.bpm === null || timeline.bpm <= 0) return 1;
  return (60 / timeline.bpm) * Math.max(1, timeline.beatsPerBar);
}

/** Loop edges land on measure lines, so a drawn loop is always whole measures. */
export function snapTimeToBar(timeline: CueTimeline | null, timeSec: number): number {
  if (timeline === null) return timeSec;
  const clamped = Math.max(0, Math.min(timeline.durationSec, timeSec));
  if (timeline.bpm === null || timeline.bpm <= 0) return Math.round(clamped);
  const barSec = barLengthSec(timeline);
  const snapped = timeline.firstBeatSec
    + Math.round((clamped - timeline.firstBeatSec) / barSec) * barSec;
  return Math.max(0, Math.min(timeline.durationSec, snapped));
}

/** `m:ss.d` transport clock text. */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

/** `bar.beat` readout for the timeline tooltip. */
export function barBeatLabel(timeline: CueTimeline | null, timeSec: number): string {
  if (timeline === null || timeline.bpm === null || timeline.bpm <= 0) {
    return formatClock(timeSec);
  }
  const beatSec = 60 / timeline.bpm;
  const beat = (timeSec - timeline.firstBeatSec) / beatSec;
  const beatsPerBar = Math.max(1, timeline.beatsPerBar);
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = Math.floor(((beat % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1;
  return `${bar}.${beatInBar}`;
}

/** Loop range in seconds; choreography stays on this grid even when the audio
 * does not loop. */
export interface LoopRange {
  startSec: number;
  endSec: number;
}

/** Map an absolute song time into the loop range (wrapping). */
export function showTime(loop: LoopRange, songSec: number): number {
  const length = Math.max(0.001, loop.endSec - loop.startSec);
  return loop.startSec + (((songSec - loop.startSec) % length) + length) % length;
}
