import type { BeatGrid } from './types';

export function secondsPerBeat(grid: BeatGrid): number {
  return 60 / grid.bpm;
}

export function secondsPerBar(grid: BeatGrid): number {
  return secondsPerBeat(grid) * grid.beatsPerBar;
}

/** Song-time -> fractional beat index (0 = first downbeat). */
export function timeToBeat(grid: BeatGrid, timeSec: number): number {
  return (timeSec - grid.offsetSec) / secondsPerBeat(grid);
}

/** Fractional beat index -> song time. */
export function beatToTime(grid: BeatGrid, beat: number): number {
  return grid.offsetSec + beat * secondsPerBeat(grid);
}

export function barToTime(grid: BeatGrid, bar: number): number {
  return beatToTime(grid, bar * grid.beatsPerBar);
}

/** Snap a song time to the nearest 1/divisions of a beat (e.g. 4 = 16th notes). */
export function snapToGrid(grid: BeatGrid, timeSec: number, divisions = 4): number {
  const beat = timeToBeat(grid, timeSec);
  return beatToTime(grid, Math.round(beat * divisions) / divisions);
}

/** Loop length in seconds for a whole number of bars. */
export function loopLength(grid: BeatGrid, bars: number): number {
  return secondsPerBar(grid) * bars;
}
