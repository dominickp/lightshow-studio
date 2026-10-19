import { describe, expect, it } from 'vitest';
import { parseProject, type ProjectFile } from '@dmxsim/show-model';
import {
  applyProjectFixtureSetup,
  cueTimelineFromProject,
  cueToProjectClip,
  projectClipToCue,
  projectFileName,
  rigMatches,
  showFromProject,
} from './project-file';
import type { Cue } from './arrangement';
import type { FixturePlacement, FixtureProfile } from '@dmxsim/show-model';
import { createDemoRig } from './demo-rig';
import { loopEndSec, loopStartSec, TRACK } from './track';

const profile: FixtureProfile = {
  id: 'generic-par',
  name: 'Generic PAR',
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

const project: ProjectFile = parseProject({
  format: 'dmxsim-project',
  version: 2,
  name: 'Round trip',
  venue: { id: 'club-stage', name: 'Club Stage' },
  show: {
    version: 2,
    name: 'Rig',
    fixtures: [{ id: 'mh-0', profile, position: { x: 0, y: 3, z: 0 }, yawDeg: 0 }],
  },
  timeline: {
    durationSec: 100,
    beatGrid: { bpm: 128, offsetSec: 0.1, beatsPerBar: 4 },
    loop: { startSec: 10, endSec: 20 },
  },
});

const cue: Cue = {
  id: 'cue-1',
  fixtureId: 'mh-0',
  startSec: 12,
  endSec: 14,
  action: 'pulse',
  colorIndex: 3,
  fadeInSec: 0,
};

describe('project mapping', () => {
  it('round-trips a cue through the project clip shape', () => {
    expect(projectClipToCue(cueToProjectClip(cue))).toEqual(cue);
  });

  it('omits fadeInSec when the cue has none', () => {
    const withoutFade = { ...cue, fadeInSec: undefined };
    expect(cueToProjectClip(withoutFade)).not.toHaveProperty('fadeInSec');
  });

  it('maps the project timeline to the arrangement timeline', () => {
    expect(cueTimelineFromProject(project)).toEqual({
      durationSec: 100,
      firstBeatSec: 0.1,
      bpm: 128,
      beatsPerBar: 4,
      loopStartSec: 10,
      loopEndSec: 20,
    });
  });

  it('falls back to 120 BPM for the stats grid when no tempo is known', () => {
    const untimed = parseProject({
      ...project,
      timeline: {
        durationSec: 100,
        beatGrid: { bpm: null },
        loop: { startSec: 0, endSec: 100 },
      },
    });
    expect(showFromProject(untimed).beatGrid.bpm).toBe(120);
  });

  it('derives the show rig from the project', () => {
    const rig = createDemoRig(TRACK.firstBeatSec, TRACK.bpm);
    const withRig = parseProject({
      ...project,
      show: { version: 2, name: rig.name, fixtures: rig.fixtures },
    });
    expect(rigMatches(withRig, rig.fixtures)).toBe(true);
    expect(rigMatches(withRig, rig.fixtures.slice(1))).toBe(false);
    expect(showFromProject(withRig).fixtures).toHaveLength(rig.fixtures.length);
  });

  it('builds a filesystem-safe filename', () => {
    expect(projectFileName('Koto Chill demo')).toBe('koto-chill-demo.dmxsim');
    expect(projectFileName('  ***  ')).toBe('project.dmxsim');
  });

  it('keeps the bundled demo inside the default loop', () => {
    const bundled = parseProject({
      ...project,
      timeline: {
        durationSec: 200,
        beatGrid: { bpm: TRACK.bpm, offsetSec: TRACK.firstBeatSec },
        loop: { startSec: loopStartSec, endSec: loopEndSec },
      },
    });
    const timeline = cueTimelineFromProject(bundled);
    expect(timeline.loopStartSec).toBeCloseTo(loopStartSec, 6);
    expect(timeline.loopEndSec).toBeCloseTo(loopEndSec, 6);
  });
});

describe('fixture setup', () => {
  const saved = parseProject({
    ...project,
    show: {
      version: 2,
      name: 'Rig',
      fixtures: [
        {
          id: 'mh-0',
          profile,
          position: { x: 0, y: 3, z: 0 },
          yawDeg: 42,
          pitchOffsetDeg: -7,
          defaults: { dimmer: 0.3, zoom: 0.8 },
        },
      ],
    },
  });

  it('restores saved mount angles and defaults onto the running rig', () => {
    const running: FixturePlacement[] = [
      { id: 'mh-0', profile, position: { x: 0, y: 3, z: 0 }, yawDeg: 0 },
    ];
    applyProjectFixtureSetup(saved, running);
    expect(running[0]?.yawDeg).toBe(42);
    expect(running[0]?.pitchOffsetDeg).toBe(-7);
    expect(running[0]?.defaults).toEqual({ dimmer: 0.3, zoom: 0.8 });
  });

  it('clears setup that the opened project does not define', () => {
    const running: FixturePlacement[] = [
      {
        id: 'mh-0',
        profile,
        position: { x: 0, y: 3, z: 0 },
        yawDeg: 0,
        pitchOffsetDeg: 5,
        defaults: { dimmer: 1 },
      },
    ];
    applyProjectFixtureSetup(project, running);
    expect(running[0]?.yawDeg).toBe(0);
    expect(running[0]?.pitchOffsetDeg).toBeUndefined();
    expect(running[0]?.defaults).toBeUndefined();
  });

  it('restores the mount, name, position, and laser setup', () => {
    const mounted = parseProject({
      ...project,
      show: {
        version: 2,
        name: 'Rig',
        fixtures: [{
          id: 'mh-0',
          name: 'Front truss 1',
          profile,
          position: { x: -8.1, y: 7.4, z: 1.6 },
          yawDeg: 12,
          mount: { anchorId: 'truss-front', u: 0.25, offset: { x: 0, y: -0.6, z: 0 } },
          laser: { beams: 12, pattern: 'fan', fanDeg: 55, divergenceDeg: 1.2, speedHz: 0.4, phaseDeg: 0 },
        }],
      },
    });
    const running: FixturePlacement[] = [
      { id: 'mh-0', profile, position: { x: 0, y: 0, z: 0 }, yawDeg: 0, mount: { anchorId: 'truss-mid', u: 0 } },
    ];

    applyProjectFixtureSetup(mounted, running);
    expect(running[0]?.name).toBe('Front truss 1');
    expect(running[0]?.position).toEqual({ x: -8.1, y: 7.4, z: 1.6 });
    expect(running[0]?.mount).toEqual({ anchorId: 'truss-front', u: 0.25, offset: { x: 0, y: -0.6, z: 0 } });
    expect(running[0]?.laser?.beams).toBe(12);
  });
});
