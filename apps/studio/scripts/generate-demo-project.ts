import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLUB_STAGE,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  defaultProjectSettings,
  ledSurfaceFromFeature,
  projectJsonSchema,
  readProjectBundle,
  writeProjectBundle,
  type ProjectFile,
  type ProjectMediaMap,
} from '@dmxsim/show-model';
import type { CueTimeline } from '../src/arrangement';
import { createDemoCues, createDemoSurfaceCues } from '../src/demo-arrangement';
import { createDemoRig } from '../src/demo-rig';
import { splitCues } from '../src/project-file';
import { TRACK, loopEndSec, loopStartSec } from '../src/track';

/**
 * Regenerates the shipped Koto Chill project bundle and the JSON Schema
 * companion.
 *
 * The demo is loaded by the app from
 * `resources/sample_projects/koto-chill/koto-chill.dmxsim`, which is a ZIP
 * bundle holding `project.json` and the song. Replace that file with a saved
 * bundle to publish arrangement edits; run this script only to rebuild it from
 * the authored `demo-arrangement.ts` (which would overwrite those edits). The
 * song is carried over from the bundle itself, so there is no side-car audio
 * file to keep in sync.
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
const wallFeature = CLUB_STAGE.features.ledWall;
const surfaces = wallFeature === undefined ? [] : [ledSurfaceFromFeature(wallFeature)];
const cues = [...createDemoCues(rig.fixtures, timeline), ...createDemoSurfaceCues(timeline)];
const { clips, surfaceClips } = splitCues(cues);
const project: ProjectFile = {
  format: PROJECT_FORMAT,
  version: PROJECT_VERSION,
  name: 'Koto Chill demo',
  description: 'Bundled demo project: the full rig plus a 16-bar arrangement on The Koto Chill.',
  venue: { id: 'club-stage', name: 'Club Stage' },
  show: {
    version: 2,
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
    clips,
    surfaces,
    surfaceClips,
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
    source: 'embedded',
    title: TRACK.title,
    artist: TRACK.artist,
    fileName: 'The Koto Chill.ogg',
  },
  // Filled in by `writeProjectBundle` from the media map below.
  media: [],
};

const audioPath = fileURLToPath(new URL('../../../resources/sample_projects/koto-chill/koto-chill.dmxsim', import.meta.url));

/**
 * The song exists only inside the bundle, so the generator carries its bytes
 * over from the bundle currently on disk rather than reading a second copy
 * from a side-car `.ogg`. Regenerating the arrangement therefore keeps the
 * audio byte-identical, and the repo ships the track exactly once.
 */
const existing = await readProjectBundle(new Uint8Array(readFileSync(audioPath)));
const audioSha = existing.project.audio.sha256;
const audio = audioSha === undefined ? undefined : existing.media.get(audioSha);
if (audioSha === undefined || audio === undefined) {
  throw new Error('the demo bundle has no embedded song to carry over');
}
project.audio.sha256 = audioSha;
const media: ProjectMediaMap = new Map([[audioSha, audio]]);

const bundle = await writeProjectBundle(project, media);
const projectPath = audioPath;
mkdirSync(dirname(projectPath), { recursive: true });
writeFileSync(projectPath, bundle);

const schemaPath = fileURLToPath(new URL('../../../docs/agent_docs/project-file.schema.json', import.meta.url));
writeFileSync(schemaPath, `${JSON.stringify(projectJsonSchema(), null, 2)}\n`);

console.log(`wrote ${projectPath} (${project.arrangement.clips.length} clips)`);
console.log(`wrote ${schemaPath}`);
