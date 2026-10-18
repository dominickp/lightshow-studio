import { LASER, MOVING_HEAD, PAR, STROBE, WASH } from '@dmxsim/fixtures';
import type { FixturePlacement, Show, Vec3 } from '@dmxsim/show-model';

/**
 * The demo venue's fixture rig. It deliberately has no tracks or clips: the
 * arrangement is the single source of choreography (see `demo-arrangement.ts`),
 * so what the timeline shows is exactly what the stage plays.
 *
 * The returned `Show` is the document the stage renders; `tracks` stays empty
 * until an arrangement is loaded into the timeline.
 */

export const DEMO_RIG_NAME = 'Spike — demo rig';

function fixture(
  id: string,
  profile: FixturePlacement['profile'],
  position: Vec3,
  yawDeg = 0,
  pitchOffsetDeg?: number,
): FixturePlacement {
  return { id, profile, position, yawDeg, ...(pitchOffsetDeg === undefined ? {} : { pitchOffsetDeg }) };
}

export function createDemoRig(startSec: number, bpm: number): Show {
  const grid = { bpm, offsetSec: startSec, beatsPerBar: 4 };
  const fixtures: FixturePlacement[] = [];

  const frontHeads = 10;
  for (let i = 0; i < frontHeads; i += 1) {
    const x = -8.1 + (16.2 * i) / (frontHeads - 1);
    fixtures.push(fixture(`mh-front-${i}`, MOVING_HEAD, { x, y: 7.4, z: 1.6 }, (i / (frontHeads - 1) - 0.5) * 24));
  }

  const rearHeads = 6;
  for (let i = 0; i < rearHeads; i += 1) {
    const x = -6.4 + (12.8 * i) / (rearHeads - 1);
    fixtures.push(fixture(`mh-rear-${i}`, MOVING_HEAD, { x, y: 7.4, z: -5.6 }, (i / (rearHeads - 1) - 0.5) * -30));
  }

  const washes = 6;
  for (let i = 0; i < washes; i += 1) {
    const x = -7 + (14 * i) / (washes - 1);
    fixtures.push(fixture(`wash-${i}`, WASH, { x, y: 7.5, z: -2.0 }, (i / (washes - 1) - 0.5) * 20));
  }

  const strobes = 4;
  for (let i = 0; i < strobes; i += 1) {
    const x = i < 2 ? -9.2 : 9.2;
    const z = i % 2 === 0 ? 2.4 : -1.0;
    fixtures.push(fixture(`strobe-${i}`, STROBE, { x, y: 6.6, z }, 0));
  }

  const lasers = 2;
  for (let i = 0; i < lasers; i += 1) {
    fixtures.push(fixture(`laser-${i}`, LASER, { x: i === 0 ? -1.4 : 1.4, y: 7.5, z: -5.6 }, 0));
  }

  const pars = 4;
  const parX = [-7.5, -3.2, 3.2, 7.5];
  for (let i = 0; i < pars; i += 1) {
    fixtures.push(fixture(`par-${i}`, PAR, { x: parX[i]!, y: 0.7, z: -2.6 }, 0, 168));
  }

  return {
    version: 1,
    name: DEMO_RIG_NAME,
    beatGrid: grid,
    fixtures,
    tracks: [],
  };
}
