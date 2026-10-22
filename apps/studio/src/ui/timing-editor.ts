import {
  DEFAULT_AIM,
  EASINGS,
  strobeGate,
  sweepWave,
  type Easing,
  type FixturePlacement,
} from '@dmxsim/show-model';
import type { Arrangement } from '../arrangement';
import {
  FALLBACK_PAN_TILT,
  SWEEP_RATE_BOUNDS,
  cueLength,
  degFromNorm,
  formatHz,
  normFromDeg,
  rateBounds,
  strobeRateFor,
  sweepFor,
  sweepRateFor,
  timingSummary,
} from '../arrangement/clip-timing';
import type { Cue, CueTimeline } from '../arrangement/types';
import { clamp } from '../lib/math';
import type { UiElements } from './elements';
import { enhanceSlider } from './slider';

export interface TimingEditorDeps {
  ui: UiElements;
  arrangement: Arrangement;
  /** Beat grid of the loaded track, or `null` before audio loads. */
  getTimeline(): CueTimeline | null;
}

export interface TimingEditor {
  /** Refresh the toolbar button and popover from the current selection. */
  sync(cue: Cue | null, fixture: FixturePlacement | null): void;
}

/**
 * The clip timing popover: strobe rate/shape, sweep movement and aim travel,
 * plus the clip's own fades.
 *
 * One toolbar button carries the summary; everything else lives in the
 * popover. The module owns its own DOM wiring, so the app only calls `sync`
 * when the selection changes.
 */
export function createTimingEditor(deps: TimingEditorDeps): TimingEditor {
  const { ui, arrangement, getTimeline } = deps;

  const setSliderValue = (input: HTMLInputElement, value: number): void => {
    // Do not fight the thumb while the user is dragging it.
    if (document.activeElement === input) return;
    input.value = String(value);
  };

  /**
   * Draw the clip's actual dimmer output across its full duration.
   *
   * The x axis is the clip, so the fade ramps are visible where they really
   * happen. Pulse/strobe cycles are capped to keep a dense clip readable; the
   * caption reports the true count.
   */
  function drawTimingPreview(cue: Cue, fixture: FixturePlacement | null): void {
    const ctx = ui.sePreview.getContext('2d');
    if (ctx === null) return;
    const width = ui.sePreview.width;
    const height = ui.sePreview.height;
    ctx.clearRect(0, 0, width, height);

    const len = cueLength(cue);
    const isStrobe = cue.action === 'strobe';
    const isPulse = cue.action === 'pulse';
    const isSweep = cue.action === 'sweep';
    const isAim = cue.action === 'aim';
    const rate = isStrobe
      ? strobeRateFor(cue, fixture)
      : isPulse
        ? cue.pulseHz ?? 4 / len
        : isSweep
          ? sweepRateFor(cue)
          : 0;
    const trueCycles = rate > 0 ? len * rate : 0;
    // A sweep is about movement, not light: keep a few cycles readable.
    const cycles = clamp(trueCycles, 1, isSweep ? 4 : 6);
    const phase = isSweep ? cue.sweep?.phase ?? 0 : 0;

    const fadeInSec = clamp(cue.fadeInSec ?? (cue.action === 'fade' ? 0 : 0.04), 0, len);
    const fadeOutSec = clamp(cue.fadeOutSec ?? 0.08, 0, len);

    const shapeAt = (u: number): number => {
      if (isStrobe) return strobeGate(u * cycles, cue.strobe);
      if (isPulse) return (u * cycles) % 1 < 0.5 ? 0.9 : 0.08;
      // Pan position across the movement cycle, so rate and offset are visible.
      if (isSweep) return 0.5 + 0.5 * sweepWave(u * cycles + phase);
      /* An aim shows its tilt, so the descent is visible as a ramp that then
       * holds flat for the rest of the clip. */
      if (isAim) {
        const aim = cue.aim ?? DEFAULT_AIM;
        const travel = clamp(aim.travelSec ?? len, 0.0001, len);
        const eased = (EASINGS[aim.easing ?? 'sine'])(clamp((u * len) / travel, 0, 1));
        const tilt = aim.tilt;
        return tilt + ((aim.toTilt ?? tilt) - tilt) * eased;
      }
      if (cue.action === 'fade') return u;
      if (cue.action === 'fire') {
        if (u < 0.04) return 0.15 + (u / 0.04) * 0.85;
        if (u < 0.6) return 0.9;
        return 0.9 * (1 - (u - 0.6) / 0.4);
      }
      return 0.9;
    };
    const envelopeAt = (u: number): number => {
      const sec = u * len;
      let env = 1;
      if (fadeInSec > 0) env = Math.min(env, sec / fadeInSec);
      if (fadeOutSec > 0) env = Math.min(env, (len - sec) / fadeOutSec);
      return clamp(env, 0, 1);
    };
    // Movement is geometric, not a dimmer level, so fades do not scale it.
    const levelAt = (u: number): number => isSweep || isAim
      ? shapeAt(u)
      : clamp(shapeAt(u) * envelopeAt(u), 0, 1);

    const steps = 300;
    const top = 6;
    const bottom = height - 6;
    const path = new Path2D();
    for (let index = 0; index <= steps; index += 1) {
      const u = index / steps;
      const x = u * width;
      const y = bottom - levelAt(u) * (bottom - top);
      if (index === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }

    const fill = new Path2D(path);
    fill.lineTo(width, bottom);
    fill.lineTo(0, bottom);
    fill.closePath();
    ctx.fillStyle = 'rgba(255, 138, 92, 0.16)';
    ctx.fill(fill);

    ctx.strokeStyle = '#ff8a5c';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke(path);

    if (!isSweep && !isAim && fadeInSec > 0) {
      ctx.fillStyle = 'rgba(122, 209, 255, 0.55)';
      ctx.fillRect(0, 0, (fadeInSec / len) * width, 2);
    }
    if (!isSweep && !isAim && fadeOutSec > 0) {
      ctx.fillStyle = 'rgba(122, 209, 255, 0.55)';
      ctx.fillRect(width - (fadeOutSec / len) * width, 0, (fadeOutSec / len) * width, 2);
    }

    const parts = [`${len.toFixed(2)} s clip`];
    if (trueCycles > 0) {
      parts.push(`${formatHz(rate)} · ${Math.max(1, Math.round(trueCycles))} cycle${Math.round(trueCycles) === 1 ? '' : 's'}`);
    }
    if (cue.action === 'sweep') parts.push(`offset ${Math.round(phase * 100)}%`);
    if (isAim) {
      const travel = clamp(cue.aim?.travelSec ?? len, 0, len);
      parts.push(`travel ${travel.toFixed(2)} s`);
    }
    if (!isSweep && !isAim && (fadeInSec > 0 || fadeOutSec > 0)) parts.push('fades shown');
    ui.sePreviewCaption.textContent = parts.join(' · ');
  }

  /** Musical rate chips: one, two or four hits per beat. */
  function renderRateChips(rate: number, cue: Cue, fixture: FixturePlacement | null): void {
    ui.seRateChips.replaceChildren();
    const bpm = getTimeline()?.bpm ?? null;
    if (bpm === null || bpm <= 0) return;
    const limits = rateBounds(cue, fixture);
    for (const [label, hits] of [['1/4', 1], ['1/8', 2], ['1/16', 4]] as const) {
      // One decimal keeps the slider, the readout and the stored rate identical.
      const hz = Math.round(clamp((bpm / 60) * hits, limits[0], limits[1]) * 10) / 10;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = `${formatHz(hz)} · ${hits} hit${hits === 1 ? '' : 's'} per beat`;
      button.setAttribute('aria-pressed', String(Math.abs(hz - rate) < 0.05));
      button.addEventListener('click', () => {
        beginTimingEdit();
        ensureTimingHistory();
        applyTimingPatch({ rate: hz });
        endTimingEdit();
      });
      ui.seRateChips.append(button);
    }
  }

  /**
   * Movement-period chips. Unlike strobes, a sweep is slow enough to talk bars:
   * one full pan/tilt cycle per 1, 2 or 4 bars keeps groups in step with the song.
   */
  function renderSweepChips(rate: number): void {
    ui.seMoveChips.replaceChildren();
    const timeline = getTimeline();
    const bpm = timeline?.bpm ?? null;
    if (bpm === null || bpm <= 0) return;
    const barSec = (60 / bpm) * Math.max(1, timeline?.beatsPerBar ?? 4);
    for (const [label, bars] of [['1 bar', 1], ['2 bars', 2], ['4 bars', 4]] as const) {
      const hz = Math.round(clamp(1 / (barSec * bars), SWEEP_RATE_BOUNDS[0], SWEEP_RATE_BOUNDS[1]) * 100) / 100;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = `${formatHz(hz)} · one cycle every ${bars} bar${bars === 1 ? '' : 's'}`;
      button.setAttribute('aria-pressed', String(Math.abs(hz - rate) < 0.005));
      button.addEventListener('click', () => {
        beginTimingEdit();
        ensureTimingHistory();
        applyTimingPatch({ rate: hz });
        endTimingEdit();
      });
      ui.seMoveChips.append(button);
    }
  }

  /** Start-angle presets: aligned, or deliberately out of step with each other. */
  function renderPhaseChips(phase: number): void {
    ui.seMovePhaseChips.replaceChildren();
    for (const [label, value, hint] of [
      ['0%', 0, 'All heads start together'],
      ['25%', 0.25, 'Quarter-cycle offset'],
      ['50%', 0.5, 'Half-cycle offset — mirrored'],
      ['75%', 0.75, 'Three-quarter offset'],
    ] as const) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = hint;
      button.setAttribute('aria-pressed', String(Math.abs(value - phase) < 0.005));
      button.addEventListener('click', () => {
        beginTimingEdit();
        ensureTimingHistory();
        applyTimingPatch({ phase: value });
        endTimingEdit();
      });
      ui.seMovePhaseChips.append(button);
    }

    // Selecting several clips and spreading them is the fast way to stop a row
    // of identical heads from moving in lockstep.
    const spread = document.createElement('button');
    spread.type = 'button';
    spread.textContent = 'Spread';
    spread.title = `Offset the ${arrangement.selectionCount} selected sweep clips evenly across the cycle`;
    spread.disabled = arrangement.selectionCount < 2;
    spread.addEventListener('click', () => {
      arrangement.spreadSelectedSweepPhase();
    });
    ui.seMovePhaseChips.append(spread);
  }

  /** Refresh the button and popover from the current selection. */
  function sync(cue: Cue | null, fixture: FixturePlacement | null): void {
    ui.clipTiming.hidden = cue === null;
    if (cue === null) {
      close();
      return;
    }

    const isStrobe = cue.action === 'strobe';
    const isPulse = cue.action === 'pulse';
    const isSweep = cue.action === 'sweep';
    const isAim = cue.action === 'aim';
    const len = cueLength(cue);
    ui.clipTiming.textContent = timingSummary(cue, fixture);
    ui.clipTiming.title = isStrobe || isPulse
      ? 'Strobe / pulse rate and shape, plus clip fades'
      : isAim
        ? 'Fixed pan/tilt aim, plus clip fades'
        : isSweep
          ? 'Movement speed, start angle and pan/tilt range, plus clip fades'
          : 'Clip fades';

    ui.sePulseSection.hidden = !(isStrobe || isPulse);
    ui.seShapeSection.hidden = !isStrobe;
    ui.seMoveSection.hidden = !isSweep;
    ui.seAimSection.hidden = !isAim;
    ui.seGlyph.textContent = isStrobe ? '⚡' : isPulse ? '≈' : isAim ? '⌖' : isSweep ? '↔' : '⏱';
    ui.seTitle.textContent = isStrobe
      ? 'Strobe'
      : isPulse
        ? 'Pulse'
        : isAim
          ? 'Aim'
          : isSweep
            ? 'Sweep'
            : 'Clip timing';
    ui.seRateLabel.textContent = isStrobe ? 'Strobe rate' : 'Pulse rate';

    const [rateMin, rateMax] = rateBounds(cue, fixture);
    ui.seRate.min = String(rateMin);
    ui.seRate.max = String(rateMax);
    const rate = isStrobe ? strobeRateFor(cue, fixture) : cue.pulseHz ?? 4 / len;
    setSliderValue(ui.seRate, rate);
    ui.seRateValue.textContent = formatHz(rate);
    renderRateChips(rate, cue, fixture);

    const attackPct = Math.round((cue.strobe?.attack ?? 0.05) * 100);
    const releasePct = Math.round((cue.strobe?.release ?? 0.18) * 100);
    const depthPct = Math.round((cue.strobe?.depth ?? 0) * 100);
    setSliderValue(ui.seAttack, attackPct);
    setSliderValue(ui.seRelease, releasePct);
    setSliderValue(ui.seDepth, depthPct);
    ui.seAttackValue.textContent = `${attackPct}%`;
    ui.seReleaseValue.textContent = `${releasePct}%`;
    ui.seDepthValue.textContent = `${depthPct}%`;

    if (isSweep) {
      const sweep = sweepFor(cue);
      const limits = fixture?.profile.limits ?? FALLBACK_PAN_TILT;
      const sweepRate = sweepRateFor(cue);
      setSliderValue(ui.seMoveRate, sweepRate);
      ui.seMoveRateValue.textContent = formatHz(sweepRate);
      renderSweepChips(sweepRate);

      const phasePct = Math.round(sweep.phase * 100);
      setSliderValue(ui.seMovePhase, phasePct);
      ui.seMovePhaseValue.textContent = `${phasePct}%`;
      renderPhaseChips(sweep.phase);

      const panSpan = limits.panDeg[1] - limits.panDeg[0];
      const tiltSpan = limits.tiltDeg[1] - limits.tiltDeg[0];
      ui.sePanCenter.min = String(limits.panDeg[0]);
      ui.sePanCenter.max = String(limits.panDeg[1]);
      ui.sePanRange.max = String(Math.round(panSpan / 2));
      ui.seTiltCenter.min = String(limits.tiltDeg[0]);
      ui.seTiltCenter.max = String(limits.tiltDeg[1]);
      ui.seTiltRange.max = String(Math.round(tiltSpan / 2));

      const panCenterDeg = Math.round(degFromNorm(sweep.panCenter, limits.panDeg));
      const panRangeDeg = Math.round(sweep.panRange * panSpan);
      const tiltCenterDeg = Math.round(degFromNorm(sweep.tiltCenter, limits.tiltDeg));
      const tiltRangeDeg = Math.round(sweep.tiltRange * tiltSpan);
      setSliderValue(ui.sePanCenter, panCenterDeg);
      setSliderValue(ui.sePanRange, panRangeDeg);
      setSliderValue(ui.seTiltCenter, tiltCenterDeg);
      setSliderValue(ui.seTiltRange, tiltRangeDeg);
      ui.sePanCenterValue.textContent = `${panCenterDeg}°`;
      ui.sePanRangeValue.textContent = `±${panRangeDeg}°`;
      ui.seTiltCenterValue.textContent = `${tiltCenterDeg}°`;
      ui.seTiltRangeValue.textContent = `±${tiltRangeDeg}°`;
    }

    if (isAim) {
      const aim = cue.aim ?? DEFAULT_AIM;
      const limits = fixture?.profile.limits ?? FALLBACK_PAN_TILT;
      for (const slider of [ui.seAimPan, ui.seAimPanTo]) {
        slider.min = String(limits.panDeg[0]);
        slider.max = String(limits.panDeg[1]);
      }
      for (const slider of [ui.seAimTilt, ui.seAimTiltTo]) {
        slider.min = String(limits.tiltDeg[0]);
        slider.max = String(limits.tiltDeg[1]);
      }
      const panDeg = Math.round(degFromNorm(aim.pan, limits.panDeg));
      const tiltDeg = Math.round(degFromNorm(aim.tilt, limits.tiltDeg));
      const toPanDeg = Math.round(degFromNorm(aim.toPan ?? aim.pan, limits.panDeg));
      const toTiltDeg = Math.round(degFromNorm(aim.toTilt ?? aim.tilt, limits.tiltDeg));
      setSliderValue(ui.seAimPan, panDeg);
      setSliderValue(ui.seAimTilt, tiltDeg);
      setSliderValue(ui.seAimPanTo, toPanDeg);
      setSliderValue(ui.seAimTiltTo, toTiltDeg);
      ui.seAimPanValue.textContent = `${panDeg}°`;
      ui.seAimTiltValue.textContent = `${tiltDeg}°`;
      ui.seAimPanToValue.textContent = `${toPanDeg}°`;
      ui.seAimTiltToValue.textContent = `${toTiltDeg}°`;

      // The travel cannot outlast the clip it lives in; no travel means the
      // head jumps straight to the end pose.
      ui.seAimTravel.max = String(Math.max(0.05, len));
      const travelSec = Math.min(aim.travelSec ?? len, len);
      setSliderValue(ui.seAimTravel, Math.round(travelSec * 20) / 20);
      ui.seAimTravelValue.textContent = `${travelSec.toFixed(2)} s`;
      ui.seAimEasing.value = aim.easing ?? 'sine';
    }

    const fadeInSec = cue.fadeInSec ?? (cue.action === 'fade' ? 0 : 0.04);
    const fadeOutSec = cue.fadeOutSec ?? 0.08;
    // Fades cannot be longer than the clip they belong to.
    ui.seFadeIn.max = String(Math.max(0.02, len));
    ui.seFadeOut.max = String(Math.max(0.02, len));
    setSliderValue(ui.seFadeIn, Math.min(fadeInSec, len));
    setSliderValue(ui.seFadeOut, Math.min(fadeOutSec, len));
    ui.seFadeInValue.textContent = `${Math.min(fadeInSec, len).toFixed(2)} s`;
    ui.seFadeOutValue.textContent = `${Math.min(fadeOutSec, len).toFixed(2)} s`;

    if (!ui.strobeEditor.hidden) drawTimingPreview(cue, fixture);
  }

  /**
   * Apply the popover's current controls to the selection.
   *
   * `history: false` is used during a drag; the matching undo step is opened by
   * `beginTimingEdit` on pointer-down (and on arrow-key nudges).
   */
  function applyTimingPatch(overrides: { rate?: number; phase?: number } = {}): void {
    const cue = arrangement.selectedCue;
    if (cue === null) return;
    const fixture = arrangement.selectedFixture;
    const len = cueLength(cue);
    const [rateMin, rateMax] = rateBounds(cue, fixture);
    const rate = clamp(overrides.rate ?? Number(ui.seRate.value), rateMin, rateMax);
    const attack = clamp(Number(ui.seAttack.value) / 100, 0, 0.5);
    const release = clamp(Number(ui.seRelease.value) / 100, 0, 0.5);
    const depth = clamp(Number(ui.seDepth.value) / 100, 0, 1);
    const fadeInSec = clamp(Number(ui.seFadeIn.value), 0, len);
    const fadeOutSec = clamp(Number(ui.seFadeOut.value), 0, len);

    const sweepRate = clamp(
      overrides.rate ?? Number(ui.seMoveRate.value),
      SWEEP_RATE_BOUNDS[0],
      SWEEP_RATE_BOUNDS[1],
    );
    const phase = clamp(overrides.phase ?? Number(ui.seMovePhase.value) / 100, 0, 1);
    const limits = fixture?.profile.limits ?? FALLBACK_PAN_TILT;
    const panSpan = limits.panDeg[1] - limits.panDeg[0];
    const tiltSpan = limits.tiltDeg[1] - limits.tiltDeg[0];

    arrangement.setSelectedClipSettings({
      fadeInSec,
      fadeOutSec,
      ...(cue.action === 'strobe'
        ? { strobe: { ...cue.strobe, hz: rate, attack, release, depth } }
        : cue.action === 'pulse'
          ? { pulseHz: rate }
          : {}),
      ...(cue.action === 'sweep'
        ? {
            sweep: {
              ...cue.sweep,
              hz: sweepRate,
              phase,
              panCenter: normFromDeg(Number(ui.sePanCenter.value), limits.panDeg),
              panRange: clamp(Number(ui.sePanRange.value) / panSpan, 0, 0.5),
              tiltCenter: normFromDeg(Number(ui.seTiltCenter.value), limits.tiltDeg),
              tiltRange: clamp(Number(ui.seTiltRange.value) / tiltSpan, 0, 0.5),
            },
          }
        : {}),
      ...(cue.action === 'aim'
        ? {
            aim: {
              pan: normFromDeg(Number(ui.seAimPan.value), limits.panDeg),
              tilt: normFromDeg(Number(ui.seAimTilt.value), limits.tiltDeg),
              toPan: normFromDeg(Number(ui.seAimPanTo.value), limits.panDeg),
              toTilt: normFromDeg(Number(ui.seAimTiltTo.value), limits.tiltDeg),
              travelSec: clamp(Number(ui.seAimTravel.value), 0, len),
              easing: ui.seAimEasing.value as Easing,
            },
          }
        : {}),
    }, { history: false });
  }

  let timingEditPending = false;
  const beginTimingEdit = (): void => {
    timingEditPending = true;
  };
  /** Open the undo step on the first real change of a gesture. */
  const ensureTimingHistory = (): void => {
    if (!timingEditPending) return;
    timingEditPending = false;
    arrangement.beginClipEdit();
  };
  const endTimingEdit = (): void => {
    timingEditPending = false;
  };

  /* A select has no drag gesture, so it opens and closes its own undo step. */
  ui.seAimEasing.addEventListener('change', () => {
    arrangement.beginClipEdit();
    applyTimingPatch();
  });

  function open(): void {
    const cue = arrangement.selectedCue;
    if (cue === null) return;
    sync(cue, arrangement.selectedFixture);
    ui.strobeEditor.hidden = false;
    ui.clipTiming.setAttribute('aria-expanded', 'true');
    drawTimingPreview(cue, arrangement.selectedFixture);
  }

  function close(): void {
    if (ui.strobeEditor.hidden) return;
    ui.strobeEditor.hidden = true;
    ui.clipTiming.setAttribute('aria-expanded', 'false');
  }

  ui.clipTiming.addEventListener('click', () => {
    if (ui.strobeEditor.hidden) open();
    else close();
  });
  ui.seClose.addEventListener('click', () => {
    close();
    ui.clipTiming.focus();
  });
  ui.strobeEditor.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close();
    ui.clipTiming.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (ui.strobeEditor.hidden || !(target instanceof Node)) return;
    if (ui.strobeEditor.contains(target) || ui.clipTiming.contains(target)) return;
    close();
  });

  for (const [slider, readout] of [
    [ui.seRate, ui.seRateValue],
    [ui.seAttack, ui.seAttackValue],
    [ui.seRelease, ui.seReleaseValue],
    [ui.seDepth, ui.seDepthValue],
    [ui.seMoveRate, ui.seMoveRateValue],
    [ui.seMovePhase, ui.seMovePhaseValue],
    [ui.sePanCenter, ui.sePanCenterValue],
    [ui.sePanRange, ui.sePanRangeValue],
    [ui.seTiltCenter, ui.seTiltCenterValue],
    [ui.seTiltRange, ui.seTiltRangeValue],
    [ui.seAimPan, ui.seAimPanValue],
    [ui.seAimTilt, ui.seAimTiltValue],
    [ui.seAimPanTo, ui.seAimPanToValue],
    [ui.seAimTiltTo, ui.seAimTiltToValue],
    [ui.seAimTravel, ui.seAimTravelValue],
    [ui.seFadeIn, ui.seFadeInValue],
    [ui.seFadeOut, ui.seFadeOutValue],
  ] as Array<[HTMLInputElement, HTMLElement]>) {
    enhanceSlider(slider, readout, { beforeEdit: beginTimingEdit });
    slider.addEventListener('pointerdown', beginTimingEdit);
    slider.addEventListener('pointerup', endTimingEdit);
    slider.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      if (!/^(Arrow|Home|End|Page)/.test(event.key)) return;
      beginTimingEdit();
    });
    slider.addEventListener('input', () => {
      ensureTimingHistory();
      applyTimingPatch();
    });
    slider.addEventListener('change', () => {
      ensureTimingHistory();
      applyTimingPatch();
      endTimingEdit();
    });
  }

  return { sync };
}
