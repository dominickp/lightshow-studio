import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { CLUB_STAGE, type FixtureState, type FixturePlacement } from '@dmxsim/show-model';
import { MOVING_HEAD } from '@dmxsim/fixtures';
import { FixtureRig, POOL_MESH_NAME } from './rig';

/**
 * Surface decals are the only surface light at low haze, so these tests pin the
 * behaviour that used to be wrong: a beam whose cone crosses two objects (the
 * dance floor and the stage top) has to paint both.
 */

const surfaces = CLUB_STAGE.surfaces;

function placement(overrides: Partial<FixturePlacement> = {}): FixturePlacement {
  return {
    id: 'test-head',
    profile: MOVING_HEAD,
    position: { x: 0, y: 6, z: 1.5 },
    yawDeg: 0,
    ...overrides,
  };
}

function state(overrides: Partial<FixtureState> = {}): FixtureState {
  return {
    fixtureId: 'test-head',
    kind: 'moving-head',
    intensity: 1,
    color: { r: 1, g: 1, b: 1 },
    panDeg: 0,
    tiltDeg: 0,
    spreadDeg: 30,
    focus: 0.5,
    strobeHz: 0,
    strobeLevel: 1,
    rotation: 0,
    active: true,
    ...overrides,
  };
}

/** Pool meshes the rig drew this frame, as (x, y, z) decal positions. */
function decalsOf(rig: FixtureRig, fixtureState: FixtureState): THREE.Vector3[] {
  const scene = new THREE.Scene();
  rig.addTo(scene);
  rig.update(fixtureState, 0, {
    volumetrics: true,
    haze: 0.1,
    camera: new THREE.PerspectiveCamera(),
    surfaces,
  });
  return scene.children
    .filter((child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name === POOL_MESH_NAME)
    .filter((mesh) => mesh.visible)
    .map((mesh) => mesh.position.clone());
}

/** Negative tilt aims the beam away from the audience, i.e. towards the stage. */
const TILT_TOWARDS_STAGE = -34;

describe('surface decals', () => {
  it('lights the floor and the stage top when the cone crosses the lip', () => {
    const decals = decalsOf(
      new FixtureRig(placement()),
      state({ tiltDeg: TILT_TOWARDS_STAGE, spreadDeg: 60 }),
    );

    expect(decals).toHaveLength(2);
    /* One decal on the dance floor (y = 0 + decal offset) and one on the stage
     * top (y = 0.3 + decal offset). Before the multi-surface pass the second
     * one did not exist, which is why beams lit the ground and skipped the
     * stage. */
    const ys = decals.map((point) => point.y).sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(0.012, 3);
    expect(ys[1]).toBeCloseTo(0.312, 3);
  });

  it('does not paint the stage when a narrow beam lands on the floor in front of it', () => {
    const decals = decalsOf(
      new FixtureRig(placement({ position: { x: 0, y: 6, z: 6 } })),
      state({ tiltDeg: -10, spreadDeg: 8 }),
    );

    expect(decals).toHaveLength(1);
    expect(decals[0]!.y).toBeCloseTo(0.012, 3);
  });

  it('paints the stage top only when the beam is aimed at it', () => {
    const decals = decalsOf(
      new FixtureRig(placement({ position: { x: 0, y: 6, z: 0 } })),
      state({ tiltDeg: -44, spreadDeg: 12 }),
    );

    expect(decals).toHaveLength(1);
    expect(decals[0]!.y).toBeCloseTo(0.312, 3);
  });

  it('skips the laser, which is rendered additively instead of lighting surfaces', () => {
    const decals = decalsOf(
      new FixtureRig(placement({ profile: { ...MOVING_HEAD, kind: 'laser' } })),
      state({ kind: 'laser', tiltDeg: TILT_TOWARDS_STAGE }),
    );

    expect(decals).toHaveLength(0);
  });
});
