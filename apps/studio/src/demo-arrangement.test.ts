import { describe, expect, it } from 'vitest';
import { evaluateFixture } from '@dmxsim/show-model';
import type { Cue, CueTimeline } from './arrangement';
import { cueToClip } from './arrangement';
import { createDemoCues } from './demo-arrangement';
import { createDemoRig } from './demo-rig';

const BPM = 130;
const BEAT_SEC = 60 / BPM;
const BAR_SEC = BEAT_SEC * 4;
const LOOP_START = 0.02 + 40 * BAR_SEC;
const LOOP_END = LOOP_START + 16 * BAR_SEC;

function timeline(): CueTimeline {
  return {
    durationSec: 240,
    firstBeatSec: 0.02,
    bpm: BPM,
    beatsPerBar: 4,
    loopStartSec: LOOP_START,
    loopEndSec: LOOP_END,
  };
}

describe('demo arrangement', () => {
  const rig = createDemoRig(0.02, BPM);
  const cues = createDemoCues(rig.fixtures, timeline());

  it('gives every fixture at least one clip and keeps clips inside the loop', () => {
    for (const fixture of rig.fixtures) {
      expect(cues.some((cue) => cue.fixtureId === fixture.id), fixture.id).toBe(true);
    }
    for (const cue of cues) {
      expect(cue.startSec).toBeGreaterThanOrEqual(LOOP_START);
      expect(cue.endSec).toBeLessThanOrEqual(LOOP_END);
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
    }
  });

  it('uses unique clip ids', () => {
    expect(new Set(cues.map((cue) => cue.id)).size).toBe(cues.length);
  });

  it('has a clip covering at least one fixture at every second of the loop', () => {
    for (let time = LOOP_START; time < LOOP_END; time += 1) {
      expect(litFixtureIds(rig, cues, time).length, `time ${time.toFixed(2)}`).toBeGreaterThan(0);
    }
  });

  it('is already visible on the paused frame at the loop start', () => {
    const lit = litFixtureIds(rig, cues, LOOP_START);
    expect(lit.length).toBeGreaterThan(0);
  });

  it('lights fewer fixtures when an active clip is removed', () => {
    const active = litFixtureIds(rig, cues, LOOP_START);
    const clip = cues.find((cue) => cue.fixtureId === 'mh-front-0' && cue.startSec === LOOP_START);
    expect(clip).toBeDefined();
    const without = cues.filter((cue) => cue.id !== clip?.id);
    const after = litFixtureIds(rig, without, LOOP_START);
    expect(after).toHaveLength(active.length - 1);
    expect(after).not.toContain('mh-front-0');
  });
});

function litFixtureIds(
  rig: ReturnType<typeof createDemoRig>,
  cues: readonly Cue[],
  time: number,
): string[] {
  return rig.fixtures
    .filter((fixture) => {
      const clips = cues
        .filter((cue) => cue.fixtureId === fixture.id && time >= cue.startSec && time <= cue.endSec)
        .map((cue) => cueToClip(fixture, cue));
      return evaluateFixture(fixture, clips, time).active;
    })
    .map((fixture) => fixture.id);
}
