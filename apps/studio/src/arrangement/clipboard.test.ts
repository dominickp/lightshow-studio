import { describe, expect, it } from 'vitest';
import { MOVING_HEAD, STROBE, WASH } from '@dmxsim/fixtures';
import type { FixturePlacement } from '@dmxsim/show-model';
import { defaultLedLook } from '@dmxsim/show-model';
import {
  canMoveCueToLane,
  canPasteOn,
  clipboardAnchor,
  copySelection,
  isCompatible,
  pastePlacements,
} from './clipboard';
import type { ClipClipboardItem, Cue } from './types';

const fixture = (id: string, profile = MOVING_HEAD): FixturePlacement => ({
  id,
  profile,
  position: { x: 0, y: 0, z: 0 },
  yawDeg: 0,
});

const cue = (overrides: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  fixtureId: 'a',
  startSec: 0,
  endSec: 1,
  colorIndex: 0,
  action: 'hold',
  ...overrides,
});

const item = (overrides: Partial<ClipClipboardItem> = {}): ClipClipboardItem => ({
  fixtureId: 'a',
  startSec: 0,
  endSec: 1,
  colorIndex: 0,
  action: 'hold',
  ...overrides,
});

const snap = (timeSec: number): number => timeSec;

describe('copySelection', () => {
  it('normalises the earliest clip to zero and preserves relative timing', () => {
    const copied = copySelection([
      cue({ id: 'a', startSec: 4, endSec: 5 }),
      cue({ id: 'b', startSec: 6.5, endSec: 8, fixtureId: 'b' }),
    ]);
    expect(copied.map((entry) => [entry.startSec, entry.endSec])).toEqual([[0, 1], [2.5, 4]]);
  });

  it('keeps optional fields and does not mutate the input', () => {
    const input = [cue({ fadeInSec: 0.2, colorOverride: { kind: 'white', cct: 3200 } })];
    const copied = copySelection(input);
    expect(copied[0]).toMatchObject({
      fadeInSec: 0.2,
      colorOverride: { kind: 'white', cct: 3200 },
    });
    expect(input[0]!.startSec).toBe(0);
  });

  it('returns an empty list for an empty selection', () => {
    expect(copySelection([])).toEqual([]);
  });
});

describe('clipboardAnchor', () => {
  it('picks the earliest clip, breaking ties by track order', () => {
    const fixtures = [fixture('a'), fixture('b')];
    const anchor = clipboardAnchor([item({ fixtureId: 'b' }), item({ fixtureId: 'a' })], fixtures);
    expect(anchor?.item.fixtureId).toBe('a');
    expect(anchor?.fixtureIndex).toBe(0);
  });

  it('ignores clips whose fixture is no longer in the rig', () => {
    expect(clipboardAnchor([item({ fixtureId: 'gone' })], [fixture('a')])).toBeNull();
  });
});

describe('pastePlacements', () => {
  const fixtures = [fixture('a'), fixture('b')];

  it('keeps clips on their original tracks when no target is given', () => {
    const placements = pastePlacements({
      clipboard: [item({ startSec: 0, endSec: 1 }), item({ fixtureId: 'b', startSec: 1, endSec: 2 })],
      fixtures,
      durationSec: 60,
      atSec: 10,
      targetFixtureId: null,
      snap,
    });
    expect(placements.map((entry) => [entry.fixtureId, entry.startSec, entry.endSec])).toEqual([
      ['a', 10, 11],
      ['b', 11, 12],
    ]);
  });

  it('maps the whole block onto the target track by relative offset', () => {
    const placements = pastePlacements({
      clipboard: [item({ fixtureId: 'a', startSec: 0, endSec: 1 })],
      fixtures,
      durationSec: 60,
      atSec: 10,
      targetFixtureId: 'b',
      snap,
    });
    expect(placements[0]?.fixtureId).toBe('b');
  });

  it('skips clips whose action the mapped target cannot perform', () => {
    const placements = pastePlacements({
      clipboard: [item({ action: 'sweep' })],
      fixtures: [fixture('a'), fixture('strobe', STROBE)],
      durationSec: 60,
      atSec: 0,
      targetFixtureId: 'strobe',
      snap,
    });
    expect(placements).toEqual([]);
  });

  it('clamps the block inside the song and drops clips past its end', () => {
    const placements = pastePlacements({
      clipboard: [item({ startSec: 0, endSec: 1 })],
      fixtures,
      durationSec: 10,
      atSec: 12,
      targetFixtureId: null,
      snap,
    });
    // Past the end the block collapses to the last minimum-length sliver.
    expect(placements[0]).toMatchObject({ startSec: 9.9, endSec: 10 });

    const clamped = pastePlacements({
      clipboard: [item({ startSec: 0, endSec: 5 })],
      fixtures,
      durationSec: 10,
      atSec: 8,
      targetFixtureId: null,
      snap,
    });
    expect(clamped[0]).toMatchObject({ startSec: 8, endSec: 10 });
  });
});

describe('canPasteOn / isCompatible', () => {
  it('rejects an action the target profile does not support', () => {
    expect(isCompatible(item({ action: 'sweep' }), fixture('s', STROBE))).toBe(false);
    expect(canPasteOn('strobe', [item({ action: 'sweep' })], [fixture('a'), fixture('strobe', STROBE)]))
      .toBe(false);
  });

  it('accepts supported actions and color overrides on rgb fixtures', () => {
    expect(isCompatible(item({ action: 'strobe' }), fixture('s', STROBE))).toBe(true);
    expect(isCompatible(
      item({ colorOverride: { kind: 'rgb', r: 1, g: 0, b: 0 } }),
      fixture('w', WASH),
    )).toBe(true);
  });
});

describe('canMoveCueToLane', () => {
  const fixtureRows = [fixture('a'), fixture('b'), fixture('strobe', STROBE)];
  const wall = {
    id: 'wall-1',
    name: 'Wall',
    widthM: 3,
    heightM: 2,
    y: 2,
    z: -4,
    pitchMm: 3.9,
    gap: 0.1,
    brightness: 1,
    blackLevel: 0.02,
    gamma: 2.2,
    emit: 0.5,
  };

  it('allows a clip onto a fixture that supports its action', () => {
    expect(canMoveCueToLane(cue({ action: 'sweep' }), 'b', fixtureRows)).toBe(true);
    expect(canMoveCueToLane(cue({ action: 'sweep' }), 'strobe', fixtureRows)).toBe(false);
  });

  it('does not let a surface clip land on a fixture or vice versa', () => {
    const surfaceCue = cue({
      fixtureId: 'wall-1',
      surfaceId: 'wall-1',
      look: defaultLedLook('solid'),
    });
    expect(canMoveCueToLane(surfaceCue, 'a', fixtureRows, [wall])).toBe(false);
    expect(canMoveCueToLane(cue(), 'wall-1', fixtureRows, [wall])).toBe(false);
    expect(canMoveCueToLane(surfaceCue, 'wall-1', fixtureRows, [wall])).toBe(true);
  });
});
