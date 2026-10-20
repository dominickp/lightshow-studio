import type { FixturePlacement } from '@dmxsim/show-model';
import type { CueAction } from './types';

/** Actions a fixture's profile can actually perform. */
export function actionsFor(fixture: FixturePlacement): CueAction[] {
  const caps = fixture.profile.capabilities;
  return [
    'hold',
    'fade',
    'pulse',
    ...(caps.panTilt ? ['sweep' as const] : []),
    ...(caps.strobe ? ['strobe' as const] : []),
  ];
}
