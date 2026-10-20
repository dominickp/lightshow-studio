import type { FixturePlacement } from '@dmxsim/show-model';
import { clamp } from '../lib/math';
import { escapeHtml } from '../lib/html';
import type { Cue, CueTimeline } from './types';

export const kindLabel = (kind: string): string =>
  kind.split('-').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');

export const capabilitySummary = (fixture: FixturePlacement): string => {
  const caps = fixture.profile.capabilities;
  return [
    caps.dimmer ? 'Dim' : null,
    caps.color ? 'Color' : null,
    caps.panTilt ? 'Pan/Tilt' : null,
    caps.strobe ? 'Strobe' : null,
  ].filter((value) => value !== null).join(' · ');
};

export const trackColor = (fixture: FixturePlacement): string => {
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

function clipMarkup(cue: Cue, pixelsPerSecond: number): string {
  const left = cue.startSec * pixelsPerSecond;
  const width = (cue.endSec - cue.startSec) * pixelsPerSecond;
  return `<div class="arrangement-clip" data-cue-id="${cue.id}" data-start-px="${left}" data-end-px="${left + width}" style="left:${left}px;width:${width}px" title="${cue.action}">
            <span class="clip-resize start"></span><span class="clip-resize end"></span>
          </div>`;
}

export interface RowsMarkupInput {
  fixtures: readonly FixturePlacement[];
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
  const rows = fixtures.map((fixture) => {
    const selected = fixture.id === activeFixtureId;
    const hidden = hiddenFixtureIds.has(fixture.id);
    const clips = cues
      .filter((cue) => cue.fixtureId === fixture.id)
      .map((cue) => clipMarkup(cue, pixelsPerSecond))
      .join('');
    const label = escapeHtml(labelFor(fixture));
    const subtitle = escapeHtml(subtitleFor(fixture));
    return `<div class="fixture-row${selected ? ' selected' : ''}${hidden ? ' hidden' : ''}" data-fixture-id="${escapeHtml(fixture.id)}">
        <button type="button" class="track-name" title="${escapeHtml(fixture.profile.name)}">
          <span class="track-indicator" style="--track-color:${trackColor(fixture)}"></span>
          <span class="track-copy"><b>${label}</b><small>${subtitle}</small></span>
          <span class="track-visibility" role="button" tabindex="0" aria-pressed="${hidden}" aria-label="${hidden ? 'Show' : 'Hide'} ${label} in the 3D scene" title="${hidden ? 'Show' : 'Hide'} in the scene">${hidden ? '◌' : '◉'}</span>
        </button>
        <div class="fixture-lane" style="width:${secondsWidth}px;${gridStyle}">
          ${loop}${clips}
        </div>
      </div>`;
  }).join('');
  return `${rows}<span class="arrangement-playhead global" aria-hidden="true"></span>`;
}
