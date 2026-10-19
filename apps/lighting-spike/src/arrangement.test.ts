import { describe, expect, it } from 'vitest';
import { reserveCueIds, type Cue } from './arrangement';

const cue = (id: string, startSec = 0): Cue => ({
  id,
  fixtureId: 'mh-front-0',
  startSec,
  endSec: startSec + 1,
  colorIndex: 0,
  action: 'hold',
});

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
