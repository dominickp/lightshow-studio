import { describe, expect, it } from 'vitest';
import { MOVING_HEAD, WASH } from '@dmxsim/fixtures';
import type { FixturePlacement } from '@dmxsim/show-model';
import { buildRowsMarkup, gridModeFor, loopMarkup } from './markup';
import type { Cue, CueTimeline } from './types';

const fixture = (id: string, name?: string, profile = MOVING_HEAD): FixturePlacement => ({
  id,
  name,
  profile,
  position: { x: 0, y: 0, z: 0 },
  yawDeg: 0,
});

const timeline: CueTimeline = {
  durationSec: 20,
  firstBeatSec: 0,
  bpm: 120,
  beatsPerBar: 4,
  loopStartSec: 2,
  loopEndSec: 6,
};

const cue = (overrides: Partial<Cue> = {}): Cue => ({
  id: 'cue-1',
  fixtureId: 'a',
  startSec: 1,
  endSec: 2,
  colorIndex: 0,
  action: 'hold',
  ...overrides,
});

describe('gridModeFor', () => {
  it('steps through sixteenths, beats, bars and none as zoom falls', () => {
    expect(gridModeFor(timeline, 100)).toBe('sixteenths');
    expect(gridModeFor(timeline, 24)).toBe('beats');
    expect(gridModeFor(timeline, 8)).toBe('bars');
    expect(gridModeFor(timeline, 2)).toBe('none');
  });

  it('is none without a tempo', () => {
    expect(gridModeFor({ ...timeline, bpm: null }, 100)).toBe('none');
  });
});

describe('loopMarkup', () => {
  it('clamps the loop to the lane width', () => {
    const markup = loopMarkup(timeline, 48, 480);
    expect(markup).toContain('lane-loop');
    expect(markup).toContain('left:96px;width:192px');
  });

  it('omits the loop when the region is empty', () => {
    expect(loopMarkup({ ...timeline, loopEndSec: 2 }, 48, 480)).toBe('');
  });
});

describe('buildRowsMarkup', () => {
  const base = {
    fixtures: [fixture('a', 'Front')],
    surfaces: [],
    cues: [cue()],
    timeline,
    pixelsPerSecond: 48,
    activeFixtureId: null,
    hiddenFixtureIds: new Set<string>(),
    labelFor: (entry: FixturePlacement) => entry.name ?? entry.id,
    subtitleFor: () => 'Moving Head · Dim',
  };

  it('renders clips with their pixel geometry', () => {
    const markup = buildRowsMarkup(base);
    expect(markup).toContain('data-cue-id="cue-1"');
    expect(markup).toContain('data-start-px="48"');
    expect(markup).toContain('data-end-px="96"');
  });

  it('marks the active and hidden rows', () => {
    const markup = buildRowsMarkup({
      ...base,
      activeFixtureId: 'a',
      hiddenFixtureIds: new Set(['a']),
    });
    expect(markup).toContain('fixture-row selected hidden');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('escapes user-authored labels and ids', () => {
    const markup = buildRowsMarkup({
      ...base,
      fixtures: [fixture('a&b', '<b>Front</b>', WASH)],
    });
    expect(markup).toContain('data-fixture-id="a&amp;b"');
    expect(markup).toContain('&lt;b&gt;Front&lt;/b&gt;');
    expect(markup).not.toContain('<b>Front</b>');
  });

  it('only renders clips belonging to each row', () => {
    const markup = buildRowsMarkup({
      ...base,
      fixtures: [fixture('a'), fixture('b')],
      cues: [cue(), cue({ id: 'cue-2', fixtureId: 'b' })],
    });
    expect(markup.match(/data-cue-id="cue-1"/g)).toHaveLength(1);
    expect(markup).toContain('data-cue-id="cue-2"');
  });
});
