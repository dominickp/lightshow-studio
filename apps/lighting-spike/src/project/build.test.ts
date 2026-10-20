import { describe, expect, it } from 'vitest';
import { MOVING_HEAD } from '@dmxsim/fixtures';
import { PROJECT_VERSION } from '@dmxsim/show-model';
import { buildProjectFile } from './build';
import type { Cue, CueTimeline } from '../arrangement/types';

const timeline: CueTimeline = {
  durationSec: 120,
  firstBeatSec: 0.5,
  bpm: 128,
  beatsPerBar: 4,
  loopStartSec: 16,
  loopEndSec: 32,
};

const cue: Cue = {
  id: 'cue-1',
  fixtureId: 'mh-0',
  startSec: 4,
  endSec: 6,
  colorIndex: 2,
  action: 'sweep',
  fadeInSec: 0.2,
};

const base = {
  name: 'Koto',
  venue: { id: 'club-stage', name: 'Club Stage' },
  show: { name: 'Koto show', fixtures: [
    { id: 'mh-0', profile: MOVING_HEAD, position: { x: 0, y: 1, z: 0 }, yawDeg: 0 },
  ] },
  timeline,
  loop: { startSec: 16, endSec: 32 },
  cues: [cue],
  render: {
    volumetrics: true,
    bloom: true,
    shadows: false,
    strobes: true,
    activeFixtureCount: 1,
    cameraView: 0,
  },
  playback: {
    volume: 0.8,
    muted: false,
    loopEnabled: true,
    followPlayhead: true,
    zoomPixelsPerSecond: 48,
  },
  ui: {
    statsVisible: true,
    dockCollapsed: false,
    dockHeightPx: 300,
    waveformHeightPx: 62,
  },
  audio: { source: 'bundled' as const, id: 'koto', title: 'Koto' },
};

describe('buildProjectFile', () => {
  it('assembles the versioned project document', () => {
    const project = buildProjectFile(base);
    expect(project.format).toBe('dmxsim-project');
    expect(project.version).toBe(PROJECT_VERSION);
    expect(project.name).toBe('Koto');
    expect(project.venue).toEqual({ id: 'club-stage', name: 'Club Stage' });
    expect(project.show).toMatchObject({ version: 2, name: 'Koto show', tracks: [] });
    expect(project.show.fixtures).toHaveLength(1);
  });

  it('maps cues and the timeline beat grid into the portable shape', () => {
    const project = buildProjectFile(base);
    expect(project.arrangement.clips).toEqual([
      {
        id: 'cue-1',
        fixtureId: 'mh-0',
        startSec: 4,
        endSec: 6,
        action: 'sweep',
        colorIndex: 2,
        fadeInSec: 0.2,
      },
    ]);
    expect(project.timeline).toEqual({
      durationSec: 120,
      beatGrid: { bpm: 128, offsetSec: 0.5, beatsPerBar: 4 },
      loop: { startSec: 16, endSec: 32 },
    });
  });

  it('carries settings and audio through unchanged', () => {
    const project = buildProjectFile(base);
    expect(project.settings.render).toEqual(base.render);
    expect(project.settings.playback).toEqual(base.playback);
    expect(project.settings.ui).toEqual(base.ui);
    expect(project.audio).toEqual(base.audio);
  });

  it('omits an absent description and includes a present one', () => {
    expect(buildProjectFile(base).description).toBeUndefined();
    expect(buildProjectFile({ ...base, description: 'A demo' }).description).toBe('A demo');
  });
});
