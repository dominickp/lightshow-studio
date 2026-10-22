import type { FixturePlacement, LedSurface } from '@dmxsim/show-model';
import { lookSummary } from '../led/look-definitions';
import { clamp } from '../lib/math';
import { escapeHtml } from '../lib/html';
import type { Cue, CueTimeline } from './types';

export const kindLabel = (kind: string): string =>
  kind.split('-').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');

export const capabilitySummary = (fixture: FixturePlacement): string => {
  if (fixture.profile.kind === 'cryo-jet') return 'Cold spray';
  const caps = fixture.profile.capabilities;
  return [
    caps.dimmer ? 'Dim' : null,
    caps.color ? 'Color' : null,
    caps.panTilt ? 'Pan/Tilt' : null,
    caps.strobe ? 'Strobe' : null,
  ].filter((value) => value !== null).join(' · ');
};

const trackColor = (fixture: FixturePlacement): string => {
  if (fixture.profile.kind === 'cryo-jet') return '#b6f2ff';
  if (fixture.profile.capabilities.panTilt) return '#41a8ff';
  if (fixture.profile.capabilities.strobe) return '#ff7e53';
  return '#56d3aa';
};

/**
 * Beat width in pixels, or `null` when the timeline has no usable tempo.
 * Kept separate so the grid style and its mode always agree.
 */
function beatWidthFor(timeline: CueTimeline, pixelsPerSecond: number): number | null {
  return timeline.bpm !== null && timeline.bpm > 0
    ? (60 / timeline.bpm) * pixelsPerSecond
    : null;
}

export function gridModeFor(
  timeline: CueTimeline,
  pixelsPerSecond: number,
): 'none' | 'sixteenths' | 'beats' | 'bars' {
  const beatWidth = beatWidthFor(timeline, pixelsPerSecond);
  if (beatWidth === null) return 'none';
  if (beatWidth / 4 >= 6) return 'sixteenths';
  if (beatWidth >= 8) return 'beats';
  const barWidth = beatWidth * timeline.beatsPerBar;
  return barWidth >= 12 ? 'bars' : 'none';
}

export function gridStyleFor(timeline: CueTimeline, pixelsPerSecond: number): string {
  const beatWidth = beatWidthFor(timeline, pixelsPerSecond);
  if (beatWidth === null) return '';
  return `--sixteenth-width:${beatWidth / 4}px;--beat-width:${beatWidth}px;--bar-width:${beatWidth * timeline.beatsPerBar}px;--grid-offset-x:${timeline.firstBeatSec * pixelsPerSecond}px;`;
}

/**
 * Loop-marker geometry shared by `loopMarkup` (initial build) and the
 * incremental zoom update in `Arrangement.applyZoom`, so the two can never
 * disagree about where the loop band sits.
 */
export interface LoopGeometry {
  /** Left edge of the loop band in pixels, or `null` when there is no loop. */
  left: number | null;
  /** Width of the loop band in pixels (0 when there is no loop). */
  loopWidth: number;
  /** Width of the shaded region before the loop, in pixels. */
  beforeWidth: number;
  /** Width of the shaded region after the loop, in pixels. */
  afterWidth: number;
}

export function loopGeometry(
  timeline: CueTimeline,
  pixelsPerSecond: number,
  width: number,
): LoopGeometry {
  const start = timeline.loopStartSec;
  const end = timeline.loopEndSec;
  if (start === undefined || end === undefined || end <= start) {
    return { left: null, loopWidth: 0, beforeWidth: 0, afterWidth: 0 };
  }
  const left = clamp(start * pixelsPerSecond, 0, width);
  const right = clamp(end * pixelsPerSecond, 0, width);
  return {
    left,
    loopWidth: Math.max(0, right - left),
    beforeWidth: left,
    afterWidth: width - right,
  };
}

export function loopMarkup(
  timeline: CueTimeline,
  pixelsPerSecond: number,
  width: number,
): string {
  const start = timeline.loopStartSec;
  const end = timeline.loopEndSec;
  if (start === undefined || end === undefined || end <= start) return '';
  const left = clamp(start * pixelsPerSecond, 0, width);
  const right = clamp(end * pixelsPerSecond, 0, width);
  const before = left > 0 ? `<span class="lane-outside" style="left:0;width:${left}px"></span>` : '';
  const after = right < width ? `<span class="lane-outside" style="left:${right}px;width:${width - right}px"></span>` : '';
  return `${before}${after}<span class="lane-loop" style="left:${left}px;width:${Math.max(0, right - left)}px"></span>`;
}

/**
 * Rate without the unit, for the compact card label: `0.1`, `0.35`, `2`.
 * Two decimals keep a slow sweep distinguishable; trailing zeros are dropped.
 */
const compactRate = (hz: number): string =>
  String(Math.round(hz * 100) / 100);

/**
 * Text drawn on a clip card and used as its hover title.
 *
 * Sweeps carry their speed and start-angle offset because two clips that look
 * identical on the timeline can still move out of step. The format is compact
 * (`sweep 0.1/25%`) so the card text fits in the same space as before. Other
 * actions stay as the bare action name. A sweep without an explicit rate
 * reports the legacy one-cycle-across-the-clip speed.
 */
export function cueCardLabel(cue: Cue): string {
  if (cue.action !== 'sweep') return cue.action;
  const length = Math.max(0.001, cue.endSec - cue.startSec);
  const hz = cue.sweep?.hz ?? 1 / length;
  const offset = Math.round((cue.sweep?.phase ?? 0) * 100);
  const rate = compactRate(hz);
  return offset > 0 ? `sweep ${rate}/${offset}%` : `sweep ${rate}`;
}

function clipMarkup(cue: Cue, pixelsPerSecond: number): string {
  const left = cue.startSec * pixelsPerSecond;
  const width = (cue.endSec - cue.startSec) * pixelsPerSecond;
  const title = cue.look === undefined ? cueCardLabel(cue) : lookSummary(cue.look);
  return `<div class="arrangement-clip" data-cue-id="${cue.id}" data-start-px="${left}" data-end-px="${left + width}" style="left:${left}px;width:${width}px" title="${escapeHtml(title)}">
            <span class="clip-resize start"></span><span class="clip-resize end"></span>
          </div>`;
}

export interface RowsMarkupInput {
  fixtures: readonly FixturePlacement[];
  surfaces: readonly LedSurface[];
  cues: readonly Cue[];
  timeline: CueTimeline;
  pixelsPerSecond: number;
  activeFixtureId: string | null;
  hiddenFixtureIds: ReadonlySet<string>;
  labelFor: (fixture: FixturePlacement) => string;
  subtitleFor: (fixture: FixturePlacement) => string;
}

/** Build the lane rows as one HTML string; `renderRows` owns measuring and DOM wiring. */
export function buildRowsMarkup(input: RowsMarkupInput): string {
  const {
    fixtures,
    surfaces,
    cues,
    timeline,
    pixelsPerSecond,
    activeFixtureId,
    hiddenFixtureIds,
    labelFor,
    subtitleFor,
  } = input;
  const secondsWidth = timeline.durationSec * pixelsPerSecond;
  const gridStyle = gridStyleFor(timeline, pixelsPerSecond);
  const loop = loopMarkup(timeline, pixelsPerSecond, secondsWidth);

  const row = (
    id: string,
    title: string,
    label: string,
    subtitle: string,
    indicator: string,
    laneClass: string,
  ): string => {
    const selected = id === activeFixtureId;
    const hidden = hiddenFixtureIds.has(id);
    const clips = cues
      .filter((cue) => cue.fixtureId === id)
      .map((cue) => clipMarkup(cue, pixelsPerSecond))
      .join('');
    return `<div class="fixture-row${laneClass}${selected ? ' selected' : ''}${hidden ? ' hidden' : ''}" data-fixture-id="${escapeHtml(id)}">
        <button type="button" class="track-name" title="${escapeHtml(title)}">
          <span class="track-indicator" style="--track-color:${indicator}"></span>
          <span class="track-copy"><b>${escapeHtml(label)}</b><small>${escapeHtml(subtitle)}</small></span>
          <span class="track-visibility" role="button" tabindex="0" aria-pressed="${hidden}" aria-label="${hidden ? 'Show' : 'Hide'} ${escapeHtml(label)} in the 3D scene" title="${hidden ? 'Show' : 'Hide'} in the scene">${hidden ? '◌' : '◉'}</span>
        </button>
        <div class="fixture-lane" style="width:${secondsWidth}px;${gridStyle}">
          ${loop}${clips}
        </div>
      </div>`;
  };

  const surfaceRows = surfaces.map((surface) =>
    row(
      surface.id,
      'LED wall',
      surface.name,
      `${surface.widthM.toFixed(1)} × ${surface.heightM.toFixed(1)} m · P${surface.pitchMm.toFixed(1)}`,
      '#a06bff',
      ' surface-row',
    ),
  ).join('');

  const fixtureRows = fixtures.map((fixture) =>
    row(
      fixture.id,
      fixture.profile.name,
      labelFor(fixture),
      subtitleFor(fixture),
      trackColor(fixture),
      '',
    ),
  ).join('');

  return `${surfaceRows}${fixtureRows}<span class="arrangement-playhead global" aria-hidden="true"></span>`;
}
