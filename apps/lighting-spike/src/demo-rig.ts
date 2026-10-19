import { PROFILE_LIBRARY } from '@dmxsim/fixtures';
import { CLUB_STAGE, instantiateRig } from '@dmxsim/show-model';
import type { Show } from '@dmxsim/show-model';

/**
 * Fallback rig used only when the bundled project file cannot be loaded.
 *
 * The rig itself lives on the venue template (`CLUB_STAGE.defaultRig`), so
 * this function no longer duplicates positions: it instantiates the same
 * anchored rig the project generator and the future venue picker use. The
 * returned `Show` deliberately has no tracks or clips; the arrangement is the
 * single source of choreography (see `demo-arrangement.ts`).
 */

export const DEMO_RIG_NAME = 'Spike — demo rig';

export function createDemoRig(startSec: number, bpm: number): Show {
  return {
    version: 1,
    name: DEMO_RIG_NAME,
    beatGrid: { bpm, offsetSec: startSec, beatsPerBar: 4 },
    fixtures: instantiateRig(CLUB_STAGE, PROFILE_LIBRARY),
    tracks: [],
  };
}
