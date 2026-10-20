import type { FixturePlacement } from '@dmxsim/show-model';
import { actionsFor } from './capabilities';
import { MIN_CLIP_SEC } from './constants';
import { clamp } from '../lib/math';
import type {
  ClipClipboardItem,
  Cue,
  PastePlacement,
} from './types';

/**
 * Copy the selection, normalised so the earliest clip starts at 0. Pasting
 * keeps each clip on its own track and their relative timing.
 */
export function copySelection(selected: readonly Cue[]): ClipClipboardItem[] {
  if (selected.length === 0) return [];
  const origin = Math.min(...selected.map((cue) => cue.startSec));
  return selected.map((cue) => ({
    fixtureId: cue.fixtureId,
    startSec: cue.startSec - origin,
    endSec: cue.endSec - origin,
    colorIndex: cue.colorIndex,
    action: cue.action,
    ...(cue.fadeInSec === undefined ? {} : { fadeInSec: cue.fadeInSec }),
    ...(cue.colorOverride === undefined ? {} : { colorOverride: cue.colorOverride }),
  }));
}

/**
 * The topmost, earliest copied clip: it anchors the block when pasting onto
 * another track, so the clicked row becomes this clip's new row and the rest
 * keep their relative track offsets.
 */
export function clipboardAnchor(
  clipboard: readonly ClipClipboardItem[],
  fixtures: readonly FixturePlacement[],
): { item: ClipClipboardItem; fixtureIndex: number } | null {
  let anchor: { item: ClipClipboardItem; fixtureIndex: number } | null = null;
  for (const item of clipboard) {
    const fixtureIndex = fixtures.findIndex((fixture) => fixture.id === item.fixtureId);
    if (fixtureIndex < 0) continue;
    if (anchor === null
      || item.startSec < anchor.item.startSec
      || (item.startSec === anchor.item.startSec && fixtureIndex < anchor.fixtureIndex)) {
      anchor = { item, fixtureIndex };
    }
  }
  return anchor;
}

/**
 * Whether a copied clip's controls make sense on another fixture. Actions
 * map directly to capabilities (sweep needs pan/tilt, strobe needs strobe),
 * and a custom color needs a color-capable fixture.
 */
export function isCompatible(item: ClipClipboardItem, fixture: FixturePlacement): boolean {
  if (!actionsFor(fixture).includes(item.action)) return false;
  if (item.colorOverride !== undefined && !fixture.profile.capabilities.color) return false;
  return true;
}

export interface PasteContext {
  clipboard: readonly ClipClipboardItem[];
  fixtures: readonly FixturePlacement[];
  durationSec: number;
  atSec: number;
  targetFixtureId: string | null;
  snap: (timeSec: number) => number;
}

/**
 * Resolve where the clipboard lands. With no target, clips keep their
 * original tracks. With a target fixture, the animated anchor clip moves to
 * that row and every other clip keeps its relative track offset; targets
 * that cannot perform a clip's controls are skipped.
 */
export function pastePlacements(context: PasteContext): PastePlacement[] {
  const { clipboard, fixtures, durationSec, targetFixtureId, snap } = context;
  const anchorSec = snap(context.atSec);
  const anchor = targetFixtureId === null ? null : clipboardAnchor(clipboard, fixtures);
  const targetIndex = targetFixtureId === null
    ? -1
    : fixtures.findIndex((fixture) => fixture.id === targetFixtureId);
  const placements: PastePlacement[] = [];
  for (const item of clipboard) {
    let fixtureId = item.fixtureId;
    if (targetFixtureId !== null) {
      const sourceIndex = fixtures.findIndex((fixture) => fixture.id === item.fixtureId);
      const target = fixtures[targetIndex + (sourceIndex - (anchor?.fixtureIndex ?? sourceIndex))];
      if (target === undefined || !isCompatible(item, target)) continue;
      fixtureId = target.id;
    } else if (!fixtures.some((fixture) => fixture.id === fixtureId)) {
      continue;
    }
    const startSec = clamp(anchorSec + item.startSec, 0, Math.max(0, durationSec - MIN_CLIP_SEC));
    if (startSec >= durationSec) continue;
    const endSec = Math.min(durationSec, Math.max(startSec + MIN_CLIP_SEC, anchorSec + item.endSec));
    placements.push({ item, fixtureId, startSec, endSec });
  }
  return placements;
}

/** Whether "Paste here" is valid on a track: the anchor clip must fit it. */
export function canPasteOn(
  fixtureId: string,
  clipboard: readonly ClipClipboardItem[],
  fixtures: readonly FixturePlacement[],
): boolean {
  const fixture = fixtures.find((entry) => entry.id === fixtureId);
  const anchor = clipboardAnchor(clipboard, fixtures);
  return fixture !== undefined && anchor !== null && isCompatible(anchor.item, fixture);
}
