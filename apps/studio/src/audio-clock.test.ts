import { describe, expect, it } from 'vitest';
import { effectPlaybackPlan } from './audio-clock';

describe('effectPlaybackPlan', () => {
  it('plays a sample once when the clip has no known end', () => {
    expect(effectPlaybackPlan(2, undefined)).toEqual({ loop: false, stopAfterSec: null });
  });

  it('cuts a sample short at the clip boundary', () => {
    expect(effectPlaybackPlan(2, 0.9)).toEqual({ loop: false, stopAfterSec: 0.9 });
  });

  it('loops a sample for a clip that outlasts it', () => {
    expect(effectPlaybackPlan(2, 5)).toEqual({ loop: true, stopAfterSec: 5 });
  });

  it('does not loop when the sample exactly fills the clip', () => {
    expect(effectPlaybackPlan(2, 2)).toEqual({ loop: false, stopAfterSec: 2 });
  });

  it('clamps a negative clip length to zero', () => {
    expect(effectPlaybackPlan(2, -1)).toEqual({ loop: false, stopAfterSec: 0 });
  });
});
