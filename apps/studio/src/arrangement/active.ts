import type { Cue } from './types';

/**
 * Cues grouped by lane key. A lane is a fixture id, or a surface id for wall
 * clips; both share the `Cue` record (see `SurfaceCueFields`).
 */
export type CueIndex = ReadonlyMap<string, readonly Cue[]>;

/** Group the arrangement's cues by the lane they belong to. */
export function indexCuesByLane(cues: readonly Cue[]): Map<string, Cue[]> {
  const index = new Map<string, Cue[]>();
  for (const cue of cues) {
    const list = index.get(cue.fixtureId);
    if (list === undefined) index.set(cue.fixtureId, [cue]);
    else list.push(cue);
  }
  return index;
}

/** Cues on one lane, in their authored order. Never `null`. */
export const cuesForLane = (index: CueIndex, laneId: string): readonly Cue[] =>
  index.get(laneId) ?? [];

/** Whether `timeSec` falls inside the cue, inclusive at both ends. */
const isCueActiveAt = (cue: Cue, timeSec: number): boolean =>
  timeSec >= cue.startSec && timeSec <= cue.endSec;

/**
 * Cues live at `timeSec`, keeping the input order. Used for "how many clips
 * are running" readouts and for the crossfade overlap test.
 */
export const activeCuesAt = (cues: readonly Cue[], timeSec: number): readonly Cue[] =>
  cues.filter((cue) => isCueActiveAt(cue, timeSec));

/**
 * Fixture cues live at `timeSec`. Surface clips are filtered out because they
 * drive a wall's look, not a light's DMX state.
 */
export const activeFixtureCuesAt = (
  cues: readonly Cue[],
  timeSec: number,
): readonly Cue[] =>
  cues.filter((cue) => cue.surfaceId === undefined && isCueActiveAt(cue, timeSec));

/**
 * End of the last cue still running at `timeSec`, or `null` when none is.
 * A fixture holding several overlapping clips keeps sounding until the
 * longest one ends.
 */
export function latestActiveEndSec(cues: readonly Cue[], timeSec: number): number | null {
  let endSec: number | null = null;
  for (const cue of cues) {
    if (!isCueActiveAt(cue, timeSec)) continue;
    if (endSec === null || cue.endSec > endSec) endSec = cue.endSec;
  }
  return endSec;
}
