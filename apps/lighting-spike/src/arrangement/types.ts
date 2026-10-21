import type { LedLookState, StrobeSettings } from '@dmxsim/show-model';

export type CueAction = 'hold' | 'fade' | 'pulse' | 'sweep' | 'strobe' | 'fire';

/**
 * Surface clips reuse the cue record so selection, history, gestures and
 * painting stay one path. For a surface cue `fixtureId` holds the surface id
 * (the lane key) and `surfaceId` marks which lane kind it belongs to.
 */
interface SurfaceCueFields {
  surfaceId?: string;
  look?: LedLookState;
  opacity?: number;
}

export const isSurfaceCue = (cue: { surfaceId?: string }): boolean => cue.surfaceId !== undefined;

/**
 * Per-cue color override. When present it wins over the `CUE_COLORS` entry
 * at `colorIndex` (which stays valid and is kept as a fallback + undo key).
 * `white` stores intent as color temperature; the channel split (white pin
 * vs tinted rgb) happens per fixture in `cueToClip`.
 */
export type CueColorOverride =
  | { kind: 'rgb'; r: number; g: number; b: number }
  | { kind: 'white'; cct: number };

export interface Cue extends SurfaceCueFields {
  id: string;
  /** Fixture id, or the surface id for a surface lane. */
  fixtureId: string;
  startSec: number;
  endSec: number;
  colorIndex: number;
  action: CueAction;
  /** Overrides the default 40 ms fade-in when the cue starts (seconds). */
  fadeInSec?: number;
  /** Overrides the default 80 ms fade-out when the cue ends (seconds). */
  fadeOutSec?: number;
  /** Pulse shape for the `strobe` action. */
  strobe?: StrobeSettings;
  /** Pulse speed for the `pulse` action, in Hz. */
  pulseHz?: number;
  /** Custom color when the cue was authored with the color picker. */
  colorOverride?: CueColorOverride;
}

export interface CueTimeline {
  durationSec: number;
  firstBeatSec: number;
  bpm: number | null;
  beatsPerBar: number;
  /** Playback loop region, when the transport is looping. Clips outside it cannot play. */
  loopStartSec?: number;
  loopEndSec?: number;
}

/**
 * `drop` is the authoring mode: dragging a lane draws a new clip. `select`
 * turns the lanes into a clipboard surface: click cards, marquee-drag, then
 * copy/paste or bulk delete without accidentally creating clips.
 */
export type TimelineMode = 'drop' | 'select';

/** One copied clip, positioned relative to the earliest clip in the copy. */
export interface ClipClipboardItem extends SurfaceCueFields {
  fixtureId: string;
  startSec: number;
  endSec: number;
  colorIndex: number;
  action: CueAction;
  fadeInSec?: number;
  fadeOutSec?: number;
  strobe?: StrobeSettings;
  pulseHz?: number;
  colorOverride?: CueColorOverride;
}

export interface CueSnapshot {
  cues: Cue[];
  selectedCueIds: string[];
}

export interface PastePlacement {
  item: ClipClipboardItem;
  fixtureId: string;
  startSec: number;
  endSec: number;
}
