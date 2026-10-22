import type { LedLookState } from '@dmxsim/show-model';
import type { Cue } from '../arrangement/types';
import type { LedPlaybackLayer } from './led-wall';

/** Fade-in used when a wall clip does not set its own crossfade length. */
const DEFAULT_CROSSFADE_SEC = 0.35;

type LookCue = Cue & { look: LedLookState };

/**
 * Resolve one wall's playback layers for a song time.
 *
 * The newest live clip is the destination; a clip that ends where it begins
 * is the source of a crossfade, ramped over the destination's fade-in. Two
 * additive layers in `LedWall` do the blend, so this stays a pure function of
 * song time — pausing mid-fade freezes the same picture.
 *
 * Returns `null` when no clip is live, leaving the wall on its last look
 * rather than blanking it.
 */
export function wallPlaybackLayers(
  cues: readonly Cue[],
  songTime: number,
): LedPlaybackLayer[] | null {
  const wallCues = cues
    .filter((cue): cue is LookCue => cue.look !== undefined)
    .slice()
    .sort((a, b) => a.startSec - b.startSec);

  const current = wallCues
    .filter((cue) => songTime >= cue.startSec && songTime < cue.endSec)
    .at(-1);
  if (current === undefined) return null;

  const earlier = wallCues.filter((cue) => cue.startSec < current.startSec).at(-1);
  const previous = earlier !== undefined && earlier.endSec >= current.startSec - 0.001
    ? earlier
    : undefined;

  // A crossfade needs something to fade *from*. With no adjacent earlier clip
  // the wall cuts to this look, so pausing at its start is never blank.
  const fade = Math.max(0.001, current.fadeInSec ?? DEFAULT_CROSSFADE_SEC);
  const ramp = previous === undefined
    ? 1
    : Math.min(1, Math.max(0, (songTime - current.startSec) / fade));

  const layers: LedPlaybackLayer[] = [];
  if (previous !== undefined && ramp < 1) {
    layers.push({ look: previous.look, opacity: (1 - ramp) * (previous.opacity ?? 1) });
  }
  layers.push({ look: current.look, opacity: ramp * (current.opacity ?? 1) });
  return layers;
}
