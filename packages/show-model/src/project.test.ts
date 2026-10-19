import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_FORMAT,
  PROJECT_VERSION,
  ProjectFileError,
  fixtureProfileSchema,
  parseProject,
  projectJsonSchema,
  serializeProject,
  type ProjectFile,
} from './project';

const profile = {
  id: 'test-head',
  name: 'Test moving head',
  kind: 'moving-head' as const,
  channels: ['dimmer', 'pan', 'panFine', 'tilt', 'tiltFine'],
  capabilities: {
    dimmer: true,
    color: false as const,
    panTilt: true,
    zoom: false,
    focus: false,
    strobe: false,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: {
    panDeg: [-270, 270] as [number, number],
    tiltDeg: [-130, 130] as [number, number],
    strobeHz: [1, 20] as [number, number],
  },
  beam: {
    spreadDeg: [4, 45] as [number, number],
    apertureDiameterM: 0.12,
    throwM: 12,
  },
};

function minimalProject(): ProjectFile {
  const parsed = parseProject({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: 'Test project',
    show: {
      version: 1,
      name: 'Test rig',
      fixtures: [
        {
          id: 'mh-0',
          profile,
          position: { x: 0, y: 6, z: 0 },
          yawDeg: 0,
        },
      ],
    },
    timeline: {
      durationSec: 120,
      beatGrid: { bpm: 128, offsetSec: 0.1, beatsPerBar: 4 },
      loop: { startSec: 10, endSec: 20 },
    },
    arrangement: {
      clips: [
        {
          id: 'clip-1',
          fixtureId: 'mh-0',
          startSec: 10,
          endSec: 12,
          action: 'sweep',
          colorIndex: 2,
        },
      ],
    },
  });
  return parsed;
}

describe('project file schema', () => {
  it('fills optional sections with documented defaults', () => {
    const project = minimalProject();
    expect(project.settings.render.strobes).toBe(false);
    expect(project.settings.playback.volume).toBe(1);
    expect(project.settings.ui.waveformHeightPx).toBe(62);
    expect(project.audio.source).toBe('external');
    expect(project.show.tracks).toEqual([]);
  });

  it('accepts a missing beat grid (imported audio without analysis)', () => {
    const project = parseProject({
      ...minimalProject(),
      timeline: {
        durationSec: 90,
        beatGrid: { bpm: null },
        loop: { startSec: 0, endSec: 90 },
      },
    });
    expect(project.timeline.beatGrid.bpm).toBeNull();
    expect(project.timeline.beatGrid.beatsPerBar).toBe(4);
  });

  it('round-trips through serialize/parse', () => {
    const project = minimalProject();
    expect(parseProject(JSON.parse(serializeProject(project)))).toEqual(project);
  });

  it('round-trips fixture setup defaults', () => {
    const project = minimalProject();
    const withSetup = parseProject({
      ...project,
      show: {
        ...project.show,
        fixtures: project.show.fixtures.map((fixture) => ({
          ...fixture,
          pitchOffsetDeg: -7,
          defaults: { dimmer: 0.3, zoom: 0.8 },
        })),
      },
    });
    expect(parseProject(JSON.parse(serializeProject(withSetup)))).toEqual(withSetup);
  });

  it('rejects setup values outside 0..1', () => {
    const project = minimalProject();
    expect(() => parseProject({
      ...project,
      show: {
        ...project.show,
        fixtures: project.show.fixtures.map((fixture) => ({
          ...fixture,
          defaults: { dimmer: 1.5 },
        })),
      },
    })).toThrow(/defaults|dimmer/);
  });

  it('rejects a project from a newer app version', () => {
    expect(() => parseProject({ ...minimalProject(), version: 2 })).toThrow(ProjectFileError);
    expect(() => parseProject({ ...minimalProject(), version: 2 })).toThrow(/newer app/);
  });

  it('rejects a different file format', () => {
    expect(() => parseProject({ ...minimalProject(), format: 'other' })).toThrow(/Not a dmxsim-project file/);
  });

  it('rejects clips whose end is not after their start', () => {
    const project = minimalProject();
    expect(() => parseProject({
      ...project,
      arrangement: {
        clips: [{ ...project.arrangement.clips[0], endSec: 10 }],
      },
    })).toThrow(/endSec/);
  });

  it('rejects loops outside the song duration', () => {
    const project = minimalProject();
    expect(() => parseProject({
      ...project,
      timeline: { ...project.timeline, loop: { startSec: 0, endSec: 121 } },
    })).toThrow(/durationSec/);
  });

  it('rejects clips on unknown fixtures and duplicate clip ids', () => {
    const project = minimalProject();
    expect(() => parseProject({
      ...project,
      arrangement: {
        clips: [{ ...project.arrangement.clips[0], fixtureId: 'missing' }],
      },
    })).toThrow(/unknown fixture/);
    expect(() => parseProject({
      ...project,
      arrangement: {
        clips: [
          { ...project.arrangement.clips[0], id: 'same' },
          { ...project.arrangement.clips[0], id: 'same', startSec: 13, endSec: 14 },
        ],
      },
    })).toThrow(/Duplicate clip id/);
  });

  it('ignores unknown fields so v1 readers tolerate future additions', () => {
    const project = parseProject({ ...minimalProject(), futureField: { a: 1 } });
    expect(project).not.toHaveProperty('futureField');
  });

  it('exports a JSON Schema for tooling', () => {
    expect(fixtureProfileSchema.parse(profile).id).toBe('test-head');
    const schema = projectJsonSchema();
    expect(schema.title ?? schema.type).toBeDefined();
  });

  it('ships a valid koto-chill demo project', () => {
    const url = new URL('../../../resources/sample_projects/koto-chill/koto-chill.dmxsim', import.meta.url);
    const project = parseProject(JSON.parse(readFileSync(url, 'utf8')));
    expect(project.show.fixtures.length).toBeGreaterThan(0);
    expect(project.arrangement.clips.length).toBeGreaterThan(0);
    const fixtureIds = new Set(project.show.fixtures.map((fixture) => fixture.id));
    for (const clip of project.arrangement.clips) {
      expect(fixtureIds.has(clip.fixtureId), clip.fixtureId).toBe(true);
    }
  });
});
