import type { FixturePlacement } from '@dmxsim/show-model';
import { CUE_COLORS, type Cue, type CueAction, type CueTimeline } from './arrangement';

/**
 * The demo's choreography, authored as arrangement clips on the loop's bar
 * grid. The stage evaluates exactly these cues, so dragging, retiming, or
 * deleting a clip changes the light immediately. No effects live outside here.
 */

type ColorName = (typeof CUE_COLORS)[number]['name'];

const colorIndex = (name: ColorName): number => {
  const index = CUE_COLORS.findIndex((color) => color.name === name);
  return index < 0 ? 0 : index;
};

const supports = (fixture: FixturePlacement, action: CueAction): boolean => {
  const caps = fixture.profile.capabilities;
  if (action === 'fire') return fixture.profile.kind === 'cryo-jet';
  if (action === 'sweep') return caps.panTilt;
  if (action === 'strobe') return caps.strobe;
  return caps.dimmer;
};

const group = (fixtures: readonly FixturePlacement[], prefix: string): FixturePlacement[] =>
  fixtures.filter((fixture) => fixture.id.startsWith(prefix));

export function createDemoCues(
  fixtures: readonly FixturePlacement[],
  timeline: CueTimeline,
): Cue[] {
  const bpm = timeline.bpm !== null && timeline.bpm > 0 ? timeline.bpm : 130;
  const beatsPerBar = Math.max(1, timeline.beatsPerBar);
  const beatSec = 60 / bpm;
  const barSec = beatSec * beatsPerBar;
  const startSec = timeline.loopStartSec ?? timeline.firstBeatSec;
  const endSec = Math.max(startSec + barSec, timeline.loopEndSec ?? timeline.durationSec);
  const barCount = Math.max(1, Math.round((endSec - startSec) / barSec));

  const at = (bar: number, beat = 0): number =>
    Math.min(endSec, Math.max(startSec, startSec + bar * barSec + beat * beatSec));

  const cues: Cue[] = [];
  let nextId = 0;

  const add = (
    fixture: FixturePlacement,
    action: CueAction,
    fromBar: number,
    toBar: number,
    color: ColorName,
    fromBeat = 0,
    toBeat = 0,
  ): void => {
    if (!supports(fixture, action)) return;
    const cueStart = at(fromBar, fromBeat);
    const cueEnd = at(toBar, toBeat);
    if (cueEnd - cueStart < 0.05) return;
    cues.push({
      id: `demo-${nextId++}`,
      fixtureId: fixture.id,
      startSec: cueStart,
      endSec: cueEnd,
      colorIndex: colorIndex(color),
      action,
      // Demo cues are cut on the grid; a fade-in would leave the paused
      // frame at the loop start dark.
      fadeInSec: 0,
    });
  };

  const frontHeads = group(fixtures, 'mh-front-');
  const rearHeads = group(fixtures, 'mh-rear-');
  const washes = group(fixtures, 'wash-');
  const strobes = group(fixtures, 'strobe-');
  const lasers = group(fixtures, 'laser-');
  const pars = group(fixtures, 'par-');
  const cryos = group(fixtures, 'cryo-');

  // Bars 0–2: slow intro. Fades buy time for the first downbeat to land.
  for (const [i, wash] of washes.entries()) add(wash, 'fade', 0, 2, i % 2 === 0 ? 'blue' : 'violet');
  for (const [i, par] of pars.entries()) add(par, 'hold', 0, 2, i % 2 === 0 ? 'amber' : 'blue');
  for (const [i, head] of frontHeads.entries()) add(head, 'sweep', 0, 2, i % 2 === 0 ? 'cyan' : 'blue');
  for (const [i, head] of rearHeads.entries()) add(head, 'sweep', 0, 2, i % 2 === 0 ? 'violet' : 'blue');
  for (const laser of lasers) add(laser, 'sweep', 0, 2, 'cyan');

  // Bars 2–4: groove. Per-fixture phase offsets turn grouped clips into a chase.
  const grooveColors: ColorName[] = ['magenta', 'cyan', 'amber', 'violet'];
  for (let bar = 2; bar < 4 && bar < barCount; bar += 1) {
    for (const [i, head] of frontHeads.entries()) {
      const phase = (i % 5) * 0.12;
      add(head, 'sweep', bar + phase, bar + phase + 1, (bar + i) % 2 === 0 ? 'magenta' : 'cyan');
    }
    for (const [i, head] of rearHeads.entries()) {
      const phase = (i % 3) * 0.2;
      add(head, 'sweep', bar + phase, bar + phase + 1, (bar + i) % 2 === 0 ? 'violet' : 'blue');
    }
    for (const [i, wash] of washes.entries()) {
      add(wash, 'hold', bar, bar + 1, grooveColors[(bar + i) % grooveColors.length]!);
    }
    for (const [i, par] of pars.entries()) {
      for (const beat of [0, 2]) {
        add(par, 'pulse', bar, bar, (i + beat) % 2 === 0 ? 'amber' : 'cyan', beat, beat + 1);
      }
    }
    for (const [i, laser] of lasers.entries()) {
      add(laser, 'sweep', bar + i * 0.5, bar + i * 0.5 + 1, i % 2 === 0 ? 'cyan' : 'violet');
    }
  }

  // Bars 4–6: build. Half-bar moves, beat strobes (rendered only when enabled).
  for (let bar = 4; bar < 6 && bar < barCount; bar += 1) {
    for (const [i, head] of frontHeads.entries()) {
      for (const half of [0, 0.5]) {
        add(head, 'sweep', bar + half, bar + half + 0.5, (i + Math.round(half * 2)) % 2 === 0 ? 'magenta' : 'cyan');
      }
    }
    for (const [i, head] of rearHeads.entries()) {
      for (const half of [0, 0.5]) {
        add(head, 'sweep', bar + half, bar + half + 0.5, i % 2 === 0 ? 'blue' : 'violet');
      }
    }
    for (const [i, wash] of washes.entries()) add(wash, 'hold', bar, bar + 1, grooveColors[(bar + i) % grooveColors.length]!);
    for (const par of pars) add(par, 'hold', bar, bar + 1, 'amber');
    for (const [i, strobe] of strobes.entries()) {
      for (const beat of [0, 1, 2, 3]) {
        if ((beat + i) % 2 !== 0) continue;
        add(strobe, 'strobe', bar, bar, 'white', beat, beat + 0.5);
      }
    }
    for (const [i, laser] of lasers.entries()) {
      for (const half of [0, 0.5]) add(laser, 'sweep', bar + half, bar + half + 0.5, i % 2 === 0 ? 'cyan' : 'blue');
    }
  }

  // Bars 6–8: breakdown. Long blue/violet fades let the drop read as a change.
  if (barCount >= 8) {
    for (const [i, wash] of washes.entries()) add(wash, 'fade', 6, 8, i % 2 === 0 ? 'blue' : 'violet');
    for (const [i, head] of frontHeads.entries()) {
      add(head, 'sweep', 6 + (i % 5) * 0.1, 8, i % 2 === 0 ? 'blue' : 'violet');
    }
    for (const [i, head] of rearHeads.entries()) {
      add(head, 'sweep', 6 + (i % 3) * 0.15, 8, i % 2 === 0 ? 'violet' : 'blue');
    }
    for (const par of pars) add(par, 'hold', 6, 8, 'blue');
    for (const laser of lasers) add(laser, 'sweep', 6, 8, 'cyan');
  }

  // Bars 8–12: drop. Busy chase across the heads, pars pulsing every beat.
  const dropWashes: ColorName[] = ['amber', 'magenta', 'cyan', 'white'];
  for (let bar = 8; bar < 12 && bar < barCount; bar += 1) {
    for (const [i, head] of frontHeads.entries()) {
      const phase = (i % 5) * 0.1;
      add(head, 'sweep', bar + phase, bar + phase + 1, (bar + i) % 2 === 0 ? 'magenta' : 'cyan');
    }
    for (const [i, head] of rearHeads.entries()) {
      const phase = (i % 3) * 0.15;
      add(head, 'sweep', bar + phase, bar + phase + 1, i % 2 === 0 ? 'blue' : 'violet');
    }
    for (const [i, wash] of washes.entries()) {
      add(wash, 'hold', bar, bar + 1, dropWashes[(bar + i) % dropWashes.length]!);
    }
    for (const [i, par] of pars.entries()) {
      for (const beat of [0, 1, 2, 3]) {
        add(par, 'pulse', bar, bar, (i + beat) % 2 === 0 ? 'cyan' : 'amber', beat, beat + 1);
      }
    }
    for (const strobe of strobes) {
      for (const beat of [0, 2]) {
        add(strobe, 'strobe', bar, bar, 'white', beat, beat + 0.5);
      }
    }
    for (const [i, laser] of lasers.entries()) {
      for (const half of [0, 0.5]) {
        add(laser, 'sweep', bar + half, bar + half + 0.5, i % 2 === 0 ? 'cyan' : 'magenta');
      }
    }
  }

  // Drop punctuation: both jets fire straight up at the big transitions.
  for (const bar of [8, 12, 14]) {
    if (bar >= barCount) continue;
    for (const cryo of cryos) add(cryo, 'fire', bar, bar, 'white', 0, 2);
  }

  // Bars 12–14: peak. Everything moves on the same half-bar grid.
  for (let bar = 12; bar < 14 && bar < barCount; bar += 1) {    for (const [i, head] of frontHeads.entries()) {
      for (const half of [0, 0.5]) {
        add(head, 'sweep', bar + half, bar + half + 0.5, (i + Math.round(half * 2)) % 2 === 0 ? 'magenta' : 'cyan');
      }
    }
    for (const [i, head] of rearHeads.entries()) {
      for (const half of [0, 0.5]) {
        add(head, 'sweep', bar + half, bar + half + 0.5, i % 2 === 0 ? 'violet' : 'blue');
      }
    }
    for (const [i, wash] of washes.entries()) add(wash, 'hold', bar, bar + 1, i % 2 === 0 ? 'amber' : 'magenta');
    for (const par of pars) add(par, 'hold', bar, bar + 1, 'amber');
    for (const strobe of strobes) {
      for (const beat of [0, 1, 2, 3]) add(strobe, 'strobe', bar, bar, 'white', beat, beat + 0.5);
    }
    for (const [i, laser] of lasers.entries()) {
      for (const half of [0, 0.5]) add(laser, 'sweep', bar + half, bar + half + 0.5, i % 2 === 0 ? 'white' : 'cyan');
    }
  }

  // Bars 14–16: outro. Settle back to the intro palette.
  if (barCount > 14) {
    const outBar = Math.min(16, barCount);
    for (const [i, wash] of washes.entries()) add(wash, 'fade', 14, outBar, i % 2 === 0 ? 'blue' : 'violet');
    for (const [i, head] of frontHeads.entries()) add(head, 'sweep', 14 + (i % 5) * 0.08, outBar, 'blue');
    for (const [i, head] of rearHeads.entries()) add(head, 'sweep', 14 + (i % 3) * 0.12, outBar, 'violet');
    for (const par of pars) add(par, 'hold', 14, outBar, 'blue');
    for (const laser of lasers) add(laser, 'hold', 14, outBar, 'cyan');
  }

  return cues.sort((a, b) => a.startSec - b.startSec || a.fixtureId.localeCompare(b.fixtureId));
}
