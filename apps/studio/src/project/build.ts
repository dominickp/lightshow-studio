import {
  PROJECT_VERSION,
  type FixturePlacement,
  type LedSurface,
  type ProjectFile,
  type ProjectSettings,
} from '@dmxsim/show-model';
import type { Cue, CueTimeline } from '../arrangement/types';
import { splitCues } from '../project-file';

export interface BuildProjectInput {
  name: string;
  description?: string;
  venue: { id: string; name: string };
  show: { name: string; fixtures: readonly FixturePlacement[] };
  timeline: CueTimeline;
  loop: { startSec: number; endSec: number };
  cues: readonly Cue[];
  surfaces: readonly LedSurface[];
  render: ProjectSettings['render'];
  playback: ProjectSettings['playback'];
  ui: ProjectSettings['ui'];
  audio: ProjectFile['audio'];
}

/** Assemble the portable project document from the current editor state. */
export function buildProjectFile(input: BuildProjectInput): ProjectFile {
  const { timeline, loop } = input;
  const clips = splitCues(input.cues);
  return {
    format: 'dmxsim-project',
    version: PROJECT_VERSION,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    venue: input.venue,
    show: {
      version: 2,
      name: input.show.name,
      fixtures: [...input.show.fixtures],
      tracks: [],
    },
    timeline: {
      durationSec: timeline.durationSec,
      beatGrid: {
        bpm: timeline.bpm,
        offsetSec: timeline.firstBeatSec,
        beatsPerBar: timeline.beatsPerBar,
      },
      loop: { startSec: loop.startSec, endSec: loop.endSec },
    },
    arrangement: {
      clips: clips.clips,
      surfaces: [...input.surfaces],
      surfaceClips: clips.surfaceClips,
    },
    settings: {
      render: input.render,
      playback: input.playback,
      ui: input.ui,
    },
    audio: input.audio,
    // Filled in when the bundle is written; the in-memory document has no
    // embedded media until then.
    media: [],
  };
}
