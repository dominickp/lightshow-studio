import { describe, expect, it } from 'vitest';
import {
  CLUB_STAGE,
  DEFAULT_VENUE_ID,
  anchorPoint,
  anchorYawDeg,
  findAnchor,
  instantiateRig,
  nextFixtureId,
  resolveMount,
  venueById,
  type FixtureProfile,
} from './index';

const profile: FixtureProfile = {
  id: 'test-par',
  name: 'Test PAR',
  kind: 'par',
  channels: ['dimmer'],
  capabilities: {
    dimmer: true,
    color: false,
    panTilt: false,
    zoom: false,
    focus: false,
    strobe: false,
    gobo: false,
    prism: false,
    rotation: false,
  },
  limits: { panDeg: [0, 0], tiltDeg: [0, 0], strobeHz: [1, 20] },
  beam: { spreadDeg: [10, 40], apertureDiameterM: 0.15, throwM: 8 },
};

/** Every profile the club rig references, all pointing at the test profile. */
const clubProfiles: Record<string, FixtureProfile> = {
  'generic-moving-head': profile,
  'generic-wash': profile,
  'generic-strobe': profile,
  'generic-laser': profile,
  'generic-par': profile,
};

describe('anchors', () => {
  it('derives yaw from the anchor normal', () => {
    const anchor = findAnchor(CLUB_STAGE, 'truss-front');
    if (anchor === undefined) throw new Error('missing truss-front anchor');

    expect(anchorYawDeg(anchor)).toBeCloseTo(0);
    expect(anchorYawDeg({ ...anchor, normal: { x: 1, y: 0, z: 0 } })).toBeCloseTo(90);
    expect(anchorYawDeg({ ...anchor, normal: { x: -1, y: 0, z: 0 } })).toBeCloseTo(-90);
    expect(anchorYawDeg({ ...anchor, normal: { x: 0, y: 0, z: -1 } })).toBeCloseTo(180);
  });

  it('interpolates along a segment and clamps u', () => {
    const anchor = findAnchor(CLUB_STAGE, 'truss-front');
    if (anchor === undefined) throw new Error('missing truss-front anchor');

    expect(anchorPoint(anchor, 0)).toEqual({ x: -10.5, y: 8, z: 1.6 });
    expect(anchorPoint(anchor, 1)).toEqual({ x: 10.5, y: 8, z: 1.6 });
    expect(anchorPoint(anchor, 0.5).x).toBeCloseTo(0);
    expect(anchorPoint(anchor, -2)).toEqual(anchor.start);
    expect(anchorPoint(anchor, 4)).toEqual(anchor.end);
  });
});

describe('resolveMount', () => {
  it('resolves position, yaw, and the anchor pitch', () => {
    const resolved = resolveMount(CLUB_STAGE, { anchorId: 'riser-front', u: 0.5 });
    if (resolved === null) throw new Error('expected a resolved mount');

    expect(resolved.position.x).toBeCloseTo(0);
    expect(resolved.position.y).toBeCloseTo(0.32);
    expect(resolved.yawDeg).toBeCloseTo(0);
    // Floor uplights point up and slightly toward the audience.
    expect(resolved.pitchOffsetDeg).toBeCloseTo(168);
  });

  it('applies world-space offsets', () => {
    const resolved = resolveMount(CLUB_STAGE, {
      anchorId: 'truss-mid',
      u: 0,
      offset: { x: 0, y: -0.6, z: 0.25 },
    });
    if (resolved === null) throw new Error('expected a resolved mount');

    expect(resolved.position).toEqual({ x: -10.5, y: 7.4, z: -1.75 });
  });

  it('honours per-fixture yaw and pitch overrides', () => {
    const resolved = resolveMount(CLUB_STAGE, {
      anchorId: 'truss-front',
      u: 0.5,
      yawDeg: 12,
      mountPitchDeg: 45,
    });
    if (resolved === null) throw new Error('expected a resolved mount');

    expect(resolved.yawDeg).toBeCloseTo(12);
    expect(resolved.pitchOffsetDeg).toBeCloseTo(45);
  });

  it('returns null for an anchor the template does not have', () => {
    expect(resolveMount(CLUB_STAGE, { anchorId: 'no-such-truss', u: 0.5 })).toBeNull();
  });
});

describe('club stage template', () => {
  it('keeps the legacy venue id so v1 files migrate onto it', () => {
    expect(CLUB_STAGE.id).toBe(DEFAULT_VENUE_ID);
  });

  it('anchors every default fixture to a real structure', () => {
    const rig = instantiateRig(CLUB_STAGE, clubProfiles);
    expect(rig).toHaveLength(CLUB_STAGE.defaultRig.fixtures.length);

    for (const fixture of rig) {
      expect(fixture.mount, fixture.id).toBeDefined();
      expect(findAnchor(CLUB_STAGE, fixture.mount?.anchorId ?? '')).toBeDefined();
      expect(fixture.position.y).toBeGreaterThan(0);
      expect(Number.isFinite(fixture.yawDeg)).toBe(true);
    }
  });

  it('generates unique ids', () => {
    const ids = instantiateRig(CLUB_STAGE, clubProfiles).map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('mh-front-0');
    expect(ids).toContain('par-0');
  });

  it('reproduces the legacy demo rig positions', () => {
    const rig = instantiateRig(CLUB_STAGE, clubProfiles);
    const front = rig.find((fixture) => fixture.id === 'mh-front-0');
    const rear = rig.find((fixture) => fixture.id === 'mh-rear-0');
    const par = rig.find((fixture) => fixture.id === 'par-0');
    const laser = rig.find((fixture) => fixture.id === 'laser-0');

    expect(front?.position.x).toBeCloseTo(-8.1, 9);
    expect(front?.position.y).toBeCloseTo(7.4, 9);
    expect(front?.position.z).toBeCloseTo(1.6, 9);
    expect(rear?.position.x).toBeCloseTo(-6.4, 9);
    expect(par?.position.x).toBeCloseTo(-7.5, 9);
    expect(par?.position.y).toBeCloseTo(0.7, 9);
    expect(par?.pitchOffsetDeg).toBeCloseTo(168);
    expect(laser?.position.x).toBeCloseTo(-1.4, 9);
    expect(laser?.position.y).toBeCloseTo(7.5, 9);
    expect(laser?.position.z).toBeCloseTo(-5.6, 9);
  });

  it('rejects an unknown profile or anchor', () => {
    expect(() => instantiateRig(CLUB_STAGE, {})).toThrow(/unknown profile/);

    const badAnchor = {
      ...CLUB_STAGE,
      defaultRig: {
        id: 'bad',
        name: 'Bad',
        fixtures: [{ profileId: 'test-par', anchorId: 'nope', u: 0.5 }],
      },
    };
    expect(() => instantiateRig(badAnchor, { 'test-par': profile })).toThrow(/unknown anchor/);
  });

  it('resolves templates through the registry', () => {
    expect(venueById(DEFAULT_VENUE_ID)).toBe(CLUB_STAGE);
    expect(venueById('no-such-venue')).toBeUndefined();
  });

  it('allocates unique ids for a bulk add', () => {
    const existing = [{ id: 'wash-0' }, { id: 'wash-4' }, { id: 'mh-2' }];
    expect(nextFixtureId(existing, 'wash')).toBe('wash-5');
    expect(nextFixtureId(existing, 'moving-head')).toBe('mh-3');
    expect(nextFixtureId(existing, 'par')).toBe('par-1');

    // The bug this guards: a batch that only reads the document's starting
    // fixtures gives every new light the same id.
    const batch = [...existing];
    const ids: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const id = nextFixtureId(batch, 'wash');
      batch.push({ id });
      ids.push(id);
    }
    expect(ids).toEqual(['wash-5', 'wash-6', 'wash-7']);
    expect(new Set(batch.map((fixture) => fixture.id)).size).toBe(batch.length);
  });

  it('ignores ids of other kinds and unrelated names', () => {
    expect(nextFixtureId([{ id: 'wash-left' }, { id: 'mh-wash-9' }], 'wash')).toBe('wash-1');
  });

  it('keeps camera presets usable', () => {
    expect(CLUB_STAGE.cameraPresets.length).toBeGreaterThanOrEqual(3);
    for (const preset of CLUB_STAGE.cameraPresets) {
      expect(Number.isFinite(preset.position.y)).toBe(true);
      expect(Number.isFinite(preset.target.z)).toBe(true);
    }
  });

  it('describes the original room shell exactly', () => {
    const boxes = CLUB_STAGE.structure.filter((primitive) => primitive.shape === 'box');
    const planes = CLUB_STAGE.structure.filter((primitive) => primitive.shape === 'plane');

    // Floor, back wall, two side walls, ceiling.
    expect(planes).toHaveLength(5);
    const ground = planes.find((primitive) => primitive.role === 'floor');
    expect(ground?.size).toEqual({ x: 40, y: 34, z: 0 });
    expect(ground?.position).toEqual({ x: 0, y: 0, z: 3 });
    expect(ground?.rotationDeg?.x).toBeCloseTo(-90);

    // Riser, three truss bars, six towers, booth, booth top, two edge strips.
    expect(boxes).toHaveLength(14);
    const riser = boxes.find((primitive) => primitive.size.x === 24);
    expect(riser?.size).toEqual({ x: 24, y: 0.3, z: 9.4 });
    expect(riser?.position.z).toBeCloseTo(-7.3);

    const bars = boxes.filter((primitive) => primitive.size.x === 21 && primitive.position.y === 8);
    expect(bars.map((bar) => bar.position.z).sort((a, b) => a - b)).toEqual([-5.6, -2, 1.6]);

    expect(CLUB_STAGE.features.ledWall).toEqual({ width: 13.5, height: 6.2, y: 4.9, z: -11.85 });
    expect(CLUB_STAGE.features.accentStrips).toHaveLength(2);
    expect(CLUB_STAGE.features.crowd?.count).toBe(90);
    expect(CLUB_STAGE.features.haze).toBe(true);
  });
});
