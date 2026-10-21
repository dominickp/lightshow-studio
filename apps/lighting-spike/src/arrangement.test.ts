import { describe, expect, it } from 'vitest';
import { MOVING_HEAD, STROBE } from '@dmxsim/fixtures';
import type { FixturePlacement } from '@dmxsim/show-model';
import { cueToClip, reserveCueIds, withCueColor, type Cue } from './arrangement';

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

const movingHeadFixture: FixturePlacement = {
  id: 'mh-0',
  profile: MOVING_HEAD,
  position: { x: 0, y: 5, z: 0 },
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

describe('withCueColor', () => {
  const custom = { kind: 'rgb', r: 0.2, g: 0.4, b: 0.6 } as const;

  it('keeps a custom override when a custom color is passed', () => {
    const next = withCueColor(cue('cue-1'), 3, custom);
    expect(next.colorIndex).toBe(3);
    expect(next.colorOverride).toEqual(custom);
  });

  it('drops the override when a palette entry is chosen', () => {
    // Regression: a clip that already carried a custom override kept it after
    // a palette click, so `resolveCueColor` still rendered the custom color and
    // the palette swatch looked dead. Going from "recent" back to "palette"
    // must clear it.
    const withCustom = { ...cue('cue-1'), colorOverride: custom };
    const next = withCueColor(withCustom, 2);
    expect(next.colorIndex).toBe(2);
    expect('colorOverride' in next).toBe(false);
    expect(next).not.toBe(withCustom);
  });

  it('does not mutate the input cue', () => {
    const withCustom = { ...cue('cue-1'), colorOverride: custom };
    withCueColor(withCustom, 5);
    expect(withCustom.colorOverride).toEqual(custom);
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

  it('passes sweep settings through instead of baking pan/tilt keyframes', () => {
    const sweep = { hz: 0.4, phase: 0.25, panCenter: 0.5, panRange: 0.2 };
    const clip = cueToClip(movingHeadFixture, {
      ...cue('cue-1'),
      fixtureId: 'mh-0',
      action: 'sweep',
      sweep,
    });
    expect(clip.sweep).toEqual(sweep);
    // The evaluator derives pan/tilt from the sweep, so no envelopes compete.
    expect(clip.attributes.pan).toBeUndefined();
    expect(clip.attributes.tilt).toBeUndefined();
  });

  it('keeps the legacy keyframes for a sweep clip with no settings', () => {
    const clip = cueToClip(movingHeadFixture, {
      ...cue('cue-1'),
      fixtureId: 'mh-0',
      action: 'sweep',
    });
    expect(clip.sweep).toBeUndefined();
    expect(clip.attributes.pan?.[1]?.value).toBeCloseTo(0.85);
  });

  it('passes an aim travel through without baking pan/tilt keyframes', () => {
    const aim = { pan: 0.5, tilt: 0.2, toTilt: 0.95, travelSec: 2.5, easing: 'sine' } as const;
    const clip = cueToClip(movingHeadFixture, {
      ...cue('cue-1'),
      fixtureId: 'mh-0',
      action: 'aim',
      aim,
    });
    expect(clip.aim).toEqual(aim);
    expect(clip.attributes.pan).toBeUndefined();
    expect(clip.attributes.tilt).toBeUndefined();
  });

  it('does not attach aim settings to a non-aim clip', () => {
    const clip = cueToClip(movingHeadFixture, {
      ...cue('cue-1'),
      fixtureId: 'mh-0',
      aim: { pan: 0.5, tilt: 0.2 },
    });
    expect(clip.aim).toBeUndefined();
  });
});
