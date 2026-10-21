import type { FixtureState } from '@dmxsim/show-model';
import type { AudioClock } from './audio-clock';

/**
 * Sound for cryo jets.
 *
 * The effect is triggered on the rising edge of a jet's spray level, so it
 * fires exactly once per clip even while the clip continues to render. Frame
 * advances over a jump (scrub, loop wrap, tab restore) update the tracking
 * without firing, which keeps scrubbing silent and lets a clip fire again on
 * its next real start.
 */
export class CryoJetAudio {
  private buffer: AudioBuffer | null = null;
  private readonly firing = new Map<string, boolean>();
  private lastSongSec: number | null = null;

  constructor(private readonly clock: AudioClock) {}

  async load(url: string): Promise<void> {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      this.buffer = await this.clock.decode(await response.arrayBuffer());
    } catch (error) {
      console.warn('could not load the cryo jet sound effect', error);
    }
  }

  /**
   * `clipEndSecFor` resolves the end of the jet's active clip. The sample is
   * looped when the clip outlasts it and cut off when the clip ends first.
   */
  update(
    states: readonly FixtureState[],
    songSec: number,
    playing: boolean,
    clipEndSecFor: (fixtureId: string) => number | null,
  ): void {
    const previous = this.lastSongSec;
    const jumped = previous !== null
      && (songSec - previous > 0.3 || songSec - previous < -0.05);
    const toFire: { durationSec: number | null }[] = [];

    for (const state of states) {
      if (state.kind !== 'cryo-jet') continue;
      const firing = state.active && state.intensity > 0.05;
      const wasFiring = this.firing.get(state.fixtureId) ?? false;
      if (firing && !wasFiring && playing && !jumped) {
        const end = clipEndSecFor(state.fixtureId);
        const remaining = end === null ? null : end - songSec;
        if (remaining === null || remaining > 0.01) toFire.push({ durationSec: remaining });
      }
      this.firing.set(state.fixtureId, firing);
    }

    this.lastSongSec = songSec;

    if (toFire.length === 0 || this.buffer === null) return;

    /* Jets whose clips end together share one sample; different lengths need
     * separate sources so each one stops or loops on its own boundary. */
    const groups = new Map<number | null, number>();
    for (const { durationSec } of toFire) {
      const key = durationSec === null ? null : Math.round(durationSec * 100) / 100;
      groups.set(key, (groups.get(key) ?? 0) + 1);
    }

    for (const [durationSec, count] of groups) {
      // Stacked jets read as one bigger hit, not a pile-up of copies.
      const level = Math.min(1, 0.78 + count * 0.06);
      const rate = 1 + (Math.random() - 0.5) * 0.04;
      this.clock.playOneShot(this.buffer, level, rate, durationSec ?? undefined);
    }
  }
}
