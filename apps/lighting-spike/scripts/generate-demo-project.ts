import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_FORMAT,
  PROJECT_VERSION,
  defaultProjectSettings,
  projectJsonSchema,
  serializeProject,
  type ProjectFile,
} from '@dmxsim/show-model';
import type { CueTimeline } from '../src/arrangement';
import { createDemoCues } from '../src/demo-arrangement';
import { createDemoRig } from '../src/demo-rig';
import { cueToProjectClip } from '../src/project-file';
import { TRACK, loopEndSec, loopStartSec } from '../src/track';

/**
 * Regenerates the shipped Koto Chill project and the JSON Schema companion.
 *
 * The demo is loaded by the app from
 * `resources/sample_projects/koto-chill/koto-chill.dmxsim`, so edit that
 * file directly to iterate on the show. Run this only to rebuild it from the
 * authored `demo-arrangement.ts` (which would overwrite those edits).
 *
 *   npm run project:generate
 */

const AUDIO_DURATION_SEC = 123.924898;

const rig = createDemoRig(TRACK.firstBeatSec, TRACK.bpm);
const timeline: CueTimeline = {
  durationSec: AUDIO_DURATION_SEC,
  firstBeatSec: TRACK.firstBeatSec,
  bpm: TRACK.bpm,
  beatsPerBar: TRACK.beatsPerBar,
  loopStartSec,
  loopEndSec,
};

const defaults = defaultProjectSettings();
const project: ProjectFile = {
  format: PROJECT_FORMAT,
  version: PROJECT_VERSION,
  name: 'Koto Chill demo',
  description: 'Bundled demo project: the full rig plus a 16-bar arrangement on The Koto Chill.',
  show: {
    version: 1,
    name: rig.name,
    fixtures: rig.fixtures,
    tracks: [],
  },
  timeline: {
    durationSec: AUDIO_DURATION_SEC,
    beatGrid: {
      bpm: TRACK.bpm,
      offsetSec: TRACK.firstBeatSec,
      beatsPerBar: TRACK.beatsPerBar,
    },
    loop: { startSec: loopStartSec, endSec: loopEndSec },
  },
  arrangement: {
    clips: createDemoCues(rig.fixtures, timeline).map(cueToProjectClip),
  },
  settings: {
    ...defaults,
    render: {
      ...defaults.render,
      activeFixtureCount: rig.fixtures.length,
    },
    playback: {
      ...defaults.playback,
      loopEnabled: true,
    },
  },
  audio: {
    source: 'bundled',
    id: 'koto-chill',
    title: TRACK.title,
    artist: TRACK.artist,
    fileName: 'The Koto Chill.ogg',
  },
};

const projectPath = fileURLToPath(new URL('../../../resources/sample_projects/koto-chill/koto-chill.dmxsim', import.meta.url));
mkdirSync(dirname(projectPath), { recursive: true });
writeFileSync(projectPath, serializeProject(project));

const schemaPath = fileURLToPath(new URL('../../../docs/agent_docs/project-file.schema.json', import.meta.url));
writeFileSync(schemaPath, `${JSON.stringify(projectJsonSchema(), null, 2)}\n`);

console.log(`wrote ${projectPath} (${project.arrangement.clips.length} clips)`);
console.log(`wrote ${schemaPath}`);
