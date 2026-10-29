import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_ENTRY,
  readProjectBundle,
  sha256Hex,
  writeProjectBundle,
  type ProjectMediaFile,
} from './bundle';
import { PROJECT_FORMAT, PROJECT_VERSION, parseProject, type ProjectFile } from './project';

const AUDIO = new TextEncoder().encode('pretend ogg bytes');
const WALL = new TextEncoder().encode('pretend png bytes');

const profile = {
  id: 'test-par',
  name: 'Test PAR',
  kind: 'par' as const,
  channels: ['dimmer', 'red', 'green', 'blue'],
  capabilities: {
    dimmer: true,
    color: 'rgb' as const,
    panTilt: false,
    zoom: false,
    focus: false,
    strobe: false,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [0, 0] as [number, number],
    tiltDeg: [0, 0] as [number, number],
    strobeHz: [1, 20] as [number, number],
  },
  beam: { spreadDeg: [10, 40] as [number, number], apertureDiameterM: 0.15, throwM: 8 },
};

const mediaFile = (bytes: Uint8Array, kind: ProjectMediaFile['kind'], mime: string, fileName: string): ProjectMediaFile => ({
  bytes,
  kind,
  mime,
  fileName,
});

async function projectWithAudio(sha256: string): Promise<ProjectFile> {
  return parseProject({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: 'Bundle test',
    venue: { id: 'club-stage', name: 'Club Stage' },
    show: {
      version: 2,
      name: 'Rig',
      fixtures: [{ id: 'par-0', profile, position: { x: 0, y: 3, z: 0 }, yawDeg: 0 }],
    },
    timeline: {
      durationSec: 60,
      beatGrid: { bpm: 120, offsetSec: 0, beatsPerBar: 4 },
      loop: { startSec: 0, endSec: 30 },
    },
    audio: { source: 'embedded', sha256, fileName: 'song.ogg' },
    media: [{ sha256, kind: 'audio', mime: 'audio/ogg', bytes: AUDIO.byteLength, fileName: 'song.ogg' }],
  });
}

describe('project bundle', () => {
  it('round-trips the document and its media', async () => {
    const audioSha = await sha256Hex(AUDIO);
    const project = await projectWithAudio(audioSha);
    project.settings.render.haze = 0.23;
    const bytes = await writeProjectBundle(project, new Map([
      [audioSha, mediaFile(AUDIO, 'audio', 'audio/ogg', 'song.ogg')],
    ]));

    const bundle = await readProjectBundle(bytes);
    expect(bundle.warnings).toEqual([]);
    expect(bundle.project).toEqual(project);
    expect(new TextDecoder().decode(bundle.media.get(audioSha)?.bytes)).toBe('pretend ogg bytes');
  });

  it('prunes media the document does not reference', async () => {
    const audioSha = await sha256Hex(AUDIO);
    const wallSha = await sha256Hex(WALL);
    const project = await projectWithAudio(audioSha);
    const bytes = await writeProjectBundle(project, new Map([
      [audioSha, mediaFile(AUDIO, 'audio', 'audio/ogg', 'song.ogg')],
      [wallSha, mediaFile(WALL, 'image', 'image/png', 'wall.png')],
    ]));

    const bundle = await readProjectBundle(bytes);
    expect(bundle.project.media.map((entry) => entry.sha256)).toEqual([audioSha]);
    expect(bundle.media.has(wallSha)).toBe(false);
  });

  it('opens a bundle whose media is missing, with a warning', async () => {
    const audioSha = await sha256Hex(AUDIO);
    const project = await projectWithAudio(audioSha);
    const zipped = unzipSync(await writeProjectBundle(project, new Map([
      [audioSha, mediaFile(AUDIO, 'audio', 'audio/ogg', 'song.ogg')],
    ])));
    const withoutMedia = Object.fromEntries(
      Object.entries(zipped).filter(([name]) => !name.startsWith('media/')),
    );
    const bundle = await readProjectBundle(zipSync(withoutMedia));
    expect(bundle.media.size).toBe(0);
    expect(bundle.warnings[0]).toMatch(/song\.ogg/);
  });

  it('rejects archives without a project document', async () => {
    const bytes = zipSync({ 'notes.txt': strToU8('hello') });
    await expect(readProjectBundle(bytes)).rejects.toThrow(/project\.json/);
  });

  it('rejects unsafe entry names', async () => {
    const audioSha = await sha256Hex(AUDIO);
    const project = await projectWithAudio(audioSha);
    const zipped = unzipSync(await writeProjectBundle(project, new Map([
      [audioSha, mediaFile(AUDIO, 'audio', 'audio/ogg', 'song.ogg')],
    ])));
    const bytes = zipSync({ ...zipped, '../escape.txt': strToU8('nope') });
    await expect(readProjectBundle(bytes)).rejects.toThrow(/Unsafe bundle entry/);
  });

  it('rejects bytes that are not a zip', async () => {
    await expect(readProjectBundle(strToU8('{"format":"dmxsim-project"}'))).rejects.toThrow(/Not a valid/);
  });

  it('names the project entry as project.json', async () => {
    const audioSha = await sha256Hex(AUDIO);
    const project = await projectWithAudio(audioSha);
    const entries = unzipSync(await writeProjectBundle(project, new Map([
      [audioSha, mediaFile(AUDIO, 'audio', 'audio/ogg', 'song.ogg')],
    ])));
    expect(Object.keys(entries)).toContain(PROJECT_ENTRY);
  });
});
