import {
  PROJECT_VERSION,
  type FixturePlacement,
  type ProjectFile,
  type ProjectSettings,
} from '@dmxsim/show-model';
import type { Cue, CueTimeline } from '../arrangement/types';
import { cueToProjectClip } from '../project-file';

export interface BuildProjectInput {
  name: string;
  description?: string;
  venue: { id: string; name: string };
  show: { name: string; fixtures: readonly FixturePlacement[] };
  timeline: CueTimeline;
  loop: { startSec: number; endSec: number };
  cues: readonly Cue[];
  render: ProjectSettings['render'];
  playback: ProjectSettings['playback'];
  ui: ProjectSettings['ui'];
  audio: ProjectFile['audio'];
}

/** Assemble the portable project document from the current editor state. */
export function buildProjectFile(input: BuildProjectInput): ProjectFile {
  const { timeline, loop } = input;
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
      clips: input.cues.map(cueToProjectClip),
    },
    settings: {
      render: input.render,
      playback: input.playback,
      ui: input.ui,
    },
    audio: input.audio,
  };
}
