import type { FixturePlacement } from '@dmxsim/show-model';
import { resolveCueColor, textOnColor, toneClipColor, truncateLabel } from './colors';
import type { Cue, TimelineMode } from './types';

export const HIDDEN_ROW_OPACITY = 0.32;

export interface PastePlacementView {
  fixtureId: string;
  startSec: number;
  endSec: number;
}

export interface ClipOverlayState {
  width: number;
  height: number;
  pixelsPerSecond: number;
  scrollLeft: number;
  visibleFixtures: readonly FixturePlacement[];
  cues: readonly Cue[];
  hiddenFixtureIds: ReadonlySet<string>;
  selectedCueIds: ReadonlySet<string>;
  hoveredCueId: string | null;
  preview: { fixtureId: string; startSec: number; endSec: number } | null;
  pastePreview: { anchorSec: number; targetFixtureId: string | null } | null;
  pointerTimeSec: number | null;
  pointerFixtureId: string | null;
  mode: TimelineMode;
  gestureActive: boolean;
  canPaste: boolean;
  clipboardLength: number;
  snap: (timeSec: number) => number;
  resolvePastePlacements: (
    atSec: number,
    targetFixtureId: string | null,
  ) => readonly PastePlacementView[];
}

interface ClipRectStyle {
  fill: string;
  stroke: string;
  lineWidth?: number;
  dash?: readonly number[];
  /** Extra translucent fill drawn before the stroke (hover feedback). */
  highlight?: string;
}

/** One round-rect card; shared by clips, previews and paste ghost bands. */
function paintRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  style: ClipRectStyle,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, Math.max(2, width), height, 4);
  ctx.fillStyle = style.fill;
  ctx.fill();
  if (style.highlight !== undefined) {
    ctx.fillStyle = style.highlight;
    ctx.fill();
  }
  if (style.dash !== undefined) ctx.setLineDash([...style.dash]);
  ctx.lineWidth = style.lineWidth ?? 1;
  ctx.strokeStyle = style.stroke;
  ctx.stroke();
  if (style.dash !== undefined) ctx.setLineDash([]);
}

/** Paint authored clips plus the preview/paste guides into the shared overlay. */
export function paintClipOverlay(ctx: CanvasRenderingContext2D, state: ClipOverlayState): void {
  const {
    width,
    height,
    pixelsPerSecond: pps,
    scrollLeft,
    visibleFixtures,
  } = state;
  const rowHeight = height / Math.max(1, visibleFixtures.length);
  const byFixture = new Map<string, Cue[]>();
  for (const cue of state.cues) {
    const list = byFixture.get(cue.fixtureId);
    if (list === undefined) byFixture.set(cue.fixtureId, [cue]);
    else list.push(cue);
  }

  const rowY = (index: number): number => index * rowHeight + 4;
  const rowH = Math.max(2, rowHeight - 8);

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textBaseline = 'middle';

  for (const [index, fixture] of visibleFixtures.entries()) {
    const cues = byFixture.get(fixture.id);
    if (cues === undefined) continue;
    // Row content is dimmed via CSS, but clips live in this shared canvas.
    ctx.globalAlpha = state.hiddenFixtureIds.has(fixture.id) ? HIDDEN_ROW_OPACITY : 1;
    const y = rowY(index);
    for (const cue of cues) {
      const x = cue.startSec * pps - scrollLeft;
      const w = (cue.endSec - cue.startSec) * pps;
      if (x + w < 0 || x > width) continue;
      const color = resolveCueColor(cue);
      const selected = state.selectedCueIds.has(cue.id);
      paintRect(ctx, x, y, w, rowH, {
        fill: toneClipColor(color.rgb),
        highlight: cue.id === state.hoveredCueId ? 'rgba(255, 255, 255, 0.18)' : undefined,
        stroke: selected ? '#ffffff' : 'rgba(255, 255, 255, 0.22)',
        lineWidth: selected ? 1.5 : 1,
      });
      // Labels truncate to the card width instead of disappearing; the
      // text color follows the fill's luminance so bright fills stay
      // readable.
      if (w >= 20) {
        ctx.fillStyle = textOnColor(color.rgb);
        ctx.fillText(
          truncateLabel(cue.action, w - 12),
          x + 6,
          y + rowH / 2,
          Math.max(1, w - 12),
        );
      }
    }
  }
  ctx.globalAlpha = 1;

  const preview = state.preview;
  if (preview !== null) {
    const index = visibleFixtures.findIndex((fixture) => fixture.id === preview.fixtureId);
    if (index >= 0) {
      paintRect(
        ctx,
        preview.startSec * pps - scrollLeft,
        rowY(index),
        Math.max(2, (preview.endSec - preview.startSec) * pps),
        rowH,
        { fill: 'rgba(122, 209, 255, 0.18)', stroke: 'rgba(122, 209, 255, 0.9)', dash: [4, 3] },
      );
    }
  }

  // Select-mode paste target: a subtle grid-aligned line plus a band on the
  // hovered track, so "here" is visible before right-clicking.
  if (state.pastePreview === null
    && state.mode === 'select'
    && !state.gestureActive
    && state.canPaste
    && state.pointerTimeSec !== null
    && state.pointerFixtureId !== null) {
    const hoverIndex = visibleFixtures.findIndex((fixture) => fixture.id === state.pointerFixtureId);
    const hoverX = state.snap(state.pointerTimeSec) * pps - scrollLeft;
    if (hoverIndex >= 0) {
      ctx.fillStyle = 'rgba(122, 209, 255, 0.06)';
      ctx.fillRect(0, hoverIndex * rowHeight, width, rowHeight);
    }
    ctx.beginPath();
    ctx.setLineDash([2, 5]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(122, 209, 255, 0.38)';
    ctx.moveTo(hoverX, 0);
    ctx.lineTo(hoverX, height);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const pastePreview = state.pastePreview;
  if (pastePreview !== null && state.clipboardLength > 0) {
    const anchorX = state.snap(pastePreview.anchorSec) * pps - scrollLeft;
    // A dashed vertical guide makes the paste time unambiguous even when
    // the copied block is thin or its tracks are scrolled out of view.
    ctx.beginPath();
    ctx.setLineDash([3, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(122, 209, 255, 0.55)';
    ctx.moveTo(anchorX, 0);
    ctx.lineTo(anchorX, height);
    ctx.stroke();
    ctx.setLineDash([]);

    for (const placement of state.resolvePastePlacements(
      pastePreview.anchorSec,
      pastePreview.targetFixtureId,
    )) {
      const index = visibleFixtures.findIndex((fixture) => fixture.id === placement.fixtureId);
      if (index < 0) continue;
      const x = placement.startSec * pps - scrollLeft;
      const w = Math.max(2, (placement.endSec - placement.startSec) * pps);
      if (x + w < 0 || x > width) continue;
      paintRect(ctx, x, rowY(index), w, rowH, {
        fill: 'rgba(122, 209, 255, 0.12)',
        stroke: 'rgba(122, 209, 255, 0.95)',
        dash: [5, 4],
        lineWidth: 1.2,
      });
    }
  }
}
