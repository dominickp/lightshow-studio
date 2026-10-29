import { describe, expect, it } from 'vitest';
import { MOVING_HEAD } from '@dmxsim/fixtures';
import type { ProjectMediaFile } from '@dmxsim/show-model';
import { buildProjectFile } from './build';
import { embedProjectMedia } from './media';
import type { Cue, CueTimeline } from '../arrangement/types';

const timeline: CueTimeline = {
  durationSec: 60,
  firstBeatSec: 0,
  bpm: 120,
  beatsPerBar: 4,
  loopStartSec: 0,
  loopEndSec: 30,
};

const look = {
  kind: 'media' as const,
  colors: ['#000000'],
  speed: 1,
  scale: 1,
  angleDeg: 0,
  softness: 0,
  intensity: 1,
  seed: 0,
  sync: 'none' as const,
  media: { source: 'local:abc', kind: 'image' as const, fit: 'cover' as const, label: 'wall.png' },
};

const surfaceCue: Cue = {
  id: 'led-1',
  fixtureId: 'led-main',
  surfaceId: 'led-main',
  startSec: 0,
  endSec: 10,
  action: 'hold',
  colorIndex: 0,
  look,
};

const project = buildProjectFile({
  name: 'Media test',
  venue: { id: 'club-stage', name: 'Club Stage' },
  show: {
    name: 'Rig',
    fixtures: [{ id: 'mh-0', profile: MOVING_HEAD, position: { x: 0, y: 1, z: 0 }, yawDeg: 0 }],
  },
  timeline,
  loop: { startSec: 0, endSec: 30 },
  cues: [surfaceCue],
  surfaces: [],
  render: {
    volumetrics: true,
    bloom: true,
    shadows: false,
    haze: 0.65,
    strobes: true,
    activeFixtureCount: 1,
    cameraView: 0,
  },
  playback: {
    volume: 1,
    muted: false,
    loopEnabled: false,
    followPlayhead: true,
    zoomPixelsPerSecond: 48,
  },
  ui: { statsVisible: true, dockCollapsed: false, dockHeightPx: 0, waveformHeightPx: 62 },
  audio: { source: 'external', fileName: 'song.ogg' },
});

const audio: ProjectMediaFile = {
  bytes: new Uint8Array([1, 2, 3]),
  kind: 'audio',
  mime: 'audio/ogg',
  fileName: 'song.ogg',
};
const wall: ProjectMediaFile = {
  bytes: new Uint8Array([4, 5, 6]),
  kind: 'image',
  mime: 'image/png',
  fileName: 'wall.png',
};

describe('embedProjectMedia', () => {
  it('rewrites local refs and embeds the current audio', async () => {
    const embedded = await embedProjectMedia(project, {
      audio: async () => audio,
      file: async () => wall,
    });

    expect(embedded.project.audio.source).toBe('embedded');
    expect(embedded.project.audio.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(embedded.project.arrangement.surfaceClips[0]?.look.media?.source)
      .toMatch(/^embedded:[0-9a-f]{64}$/);
    expect(embedded.media.size).toBe(2);
    expect(embedded.missing).toEqual([]);
    // The session keeps its editable refs.
    expect(project.arrangement.surfaceClips[0]?.look.media?.source).toBe('local:abc');
  });

  it('keeps refs it cannot read and reports them', async () => {
    const embedded = await embedProjectMedia(project, {
      audio: async () => audio,
      file: async () => null,
    });
    expect(embedded.project.arrangement.surfaceClips[0]?.look.media?.source).toBe('local:abc');
    expect(embedded.missing).toEqual(['wall.png']);
  });

  it('re-collects media that is already embedded', async () => {
    const first = await embedProjectMedia(project, {
      audio: async () => audio,
      file: async () => wall,
    });
    const again = await embedProjectMedia(first.project, {
      audio: async () => null,
      file: async () => wall,
    });
    expect(again.media.size).toBe(1);
    expect(again.project.arrangement.surfaceClips[0]?.look.media?.source)
      .toBe(first.project.arrangement.surfaceClips[0]?.look.media?.source);
    // Audio bytes were unavailable, so the missing track is reported.
    expect(again.missing).toEqual(['song.ogg']);
  });
});
