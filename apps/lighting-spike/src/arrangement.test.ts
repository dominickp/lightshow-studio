import { describe, expect, it } from 'vitest';
import { STROBE } from '@dmxsim/fixtures';
import type { FixturePlacement } from '@dmxsim/show-model';
import { cueToClip, reserveCueIds, type Cue } from './arrangement';

const cue = (id: string, startSec = 0): Cue => ({
  id,
  fixtureId: 'mh-front-0',
  startSec,
  endSec: startSec + 1,
  colorIndex: 0,
  action: 'hold',
});

const strobeFixture: FixturePlacement = {
  id: 'strobe-0',
  profile: STROBE,
  position: { x: 0, y: 3, z: 0 },
  yawDeg: 0,
};

describe('reserveCueIds', () => {
  it('keeps unique ids and continues past the highest cue-N', () => {
    const { cues, nextId } = reserveCueIds([cue('demo-1'), cue('cue-1'), cue('cue-7', 4)]);
    expect(cues.map((item) => item.id)).toEqual(['demo-1', 'cue-1', 'cue-7']);
    expect(nextId).toBe(8);
  });

  it('repairs a duplicate id instead of letting two clips share identity', () => {
    // A project saved by an older build could hold a `cue-1` that the next
    // session then handed out again; resizing one clip moved both.
    const { cues } = reserveCueIds([cue('cue-1', 0), cue('cue-1', 10)]);
    expect(cues.map((item) => item.id)).toEqual(['cue-1', 'cue-2']);
    expect(new Set(cues.map((item) => item.id)).size).toBe(2);
  });

  it('gives a missing id a fresh one', () => {
    const { cues } = reserveCueIds([cue('')]);
    expect(cues[0]!.id).toMatch(/^cue-\d+$/);
  });

  it('does not mutate the input cues', () => {
    const input = [cue('cue-1', 0), cue('cue-1', 10)];
    reserveCueIds(input);
    expect(input.map((item) => item.id)).toEqual(['cue-1', 'cue-1']);
  });
});

describe('cueToClip', () => {
  it('passes strobe shaping and the rate override through', () => {
    const clip = cueToClip(strobeFixture, {
      ...cue('cue-1'),
      fixtureId: 'strobe-0',
      action: 'strobe',
      strobe: { hz: 12, attack: 0.1, release: 0.3 },
    });
    expect(clip.attributes.strobe).toEqual([{ at: 0, value: 0.78 }]);
    expect(clip.strobe).toEqual({ hz: 12, attack: 0.1, release: 0.3 });
  });

  it('keeps a custom fade out and defaults it otherwise', () => {
    expect(cueToClip(strobeFixture, cue('cue-1')).fadeOutSec).toBeCloseTo(0.08);
    expect(cueToClip(strobeFixture, { ...cue('cue-1'), fadeOutSec: 1.5 }).fadeOutSec).toBeCloseTo(1.5);
  });

  it('pulses at an explicit rate regardless of clip length', () => {
    const clip = cueToClip(strobeFixture, {
      ...cue('cue-1'),
      startSec: 0,
      endSec: 2,
      action: 'pulse',
      pulseHz: 2,
    });
    // Two cycles per second over two seconds = 8 half-cycle keyframes.
    expect(clip.attributes.dimmer).toHaveLength(9);
    expect(clip.attributes.dimmer?.[0]?.value).toBeCloseTo(0.9);
    expect(clip.attributes.dimmer?.at(-1)?.value).toBeCloseTo(0.9);
  });
});
