import * as THREE from 'three/webgpu';
import { evaluateFixture, evaluateFixtureStates, timeToBeat } from '@dmxsim/show-model';
import { createDemoShow } from './demo-show';
import { AudioClock } from './audio-clock';
import { loopEndSec, loopStartSec, TRACK, TRACK_URL } from './track';
import { computePeaks, WaveformStrip } from './waveform';
import {
  Arrangement,
  CUE_COLORS,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  PIXELS_PER_SECOND,
  TRACK_LABEL_WIDTH,
  type Cue,
  type CueTimeline,
  createRuler,
} from './arrangement';
import { Stage } from './stage';
import { Post } from './post';

const show = createDemoShow(loopStartSec, TRACK.bpm);
const counts = [10, 16, 22, 26, 32].filter((n) => n <= show.fixtures.length);

const container = document.getElementById('app');
if (container === null) throw new Error('missing #app element');
const viewport = document.getElementById('stage-viewport');
if (viewport === null) throw new Error('missing #stage-viewport element');

const renderer = new THREE.WebGPURenderer({ antialias: true });
const baseRatio = Math.min(window.devicePixelRatio || 1, 1.5);
renderer.setPixelRatio(baseRatio);
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.info.autoReset = false;
container.appendChild(renderer.domElement);

await renderer.init();

const stage = new Stage(renderer.domElement, show);
// The renderer draws into #stage-viewport (window minus the timeline dock), not
// the whole window, so the initial projection must use the viewport's aspect.
stage.camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
stage.camera.updateProjectionMatrix();
const post = new Post(renderer, stage.scene, stage.camera);
const clock = new AudioClock();
clock.setLoop({ startSec: loopStartSec, endSec: loopEndSec }, true);

let volumetrics = true;
let bloomOn = true;
let shadowsOn = true;
let lofi = false;
let strobesOn = false;
let countIndex = counts.length - 1;
let activeCount = counts[countIndex] ?? show.fixtures.length;

stage.setActiveCount(activeCount);

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id}`);
  return found as T;
};

const ui = {
  fps: element('stat-fps'),
  ms: element('stat-ms'),
  calls: element('stat-calls'),
  tris: element('stat-tris'),
  res: element('stat-res'),
  backend: element('stat-backend'),
  fixtures: element('stat-fixtures'),
  time: element('stat-time'),
  latency: element('stat-latency'),
  loop: element('stat-loop'),
  transportTime: element('transport-time'),
  transportTrack: element('transport-track'),
  audioStatus: element('audio-status'),
  play: element<HTMLButtonElement>('btn-play'),
  chooseAudio: element<HTMLButtonElement>('btn-audio'),
  audioFile: element<HTMLInputElement>('audio-file'),
  vol: element<HTMLButtonElement>('btn-vol'),
  bloom: element<HTMLButtonElement>('btn-bloom'),
  shadow: element<HTMLButtonElement>('btn-shadow'),
  lofi: element<HTMLButtonElement>('btn-lofi'),
  strobe: element<HTMLButtonElement>('btn-strobe'),
  strobeStatus: element('strobe-status'),
  view: element<HTMLButtonElement>('btn-view'),
  count: element<HTMLButtonElement>('btn-count'),
  waveform: element<HTMLCanvasElement>('waveform'),
  arrangement: element('arrangement-rows'),
  arrangementScroll: element('arrangement-scroll'),
  ruler: element<HTMLCanvasElement>('timeline-ruler'),
  cueAdd: element<HTMLButtonElement>('btn-cue-add'),
  cueAction: element<HTMLSelectElement>('cue-action'),
  cueColor: element<HTMLSelectElement>('cue-color'),
  cueDelete: element<HTMLButtonElement>('btn-cue-delete'),
  cueStatus: element('cue-status'),
  zoomIn: element<HTMLButtonElement>('btn-zoom-in'),
  zoomOut: element<HTMLButtonElement>('btn-zoom-out'),
  zoomFit: element<HTMLButtonElement>('btn-zoom-fit'),
  zoomLevel: element<HTMLInputElement>('zoom-level'),
  zoomPercent: element('zoom-percent'),
  loopBtn: element<HTMLButtonElement>('btn-loop'),
  loopFit: element<HTMLButtonElement>('btn-loop-fit'),
  follow: element<HTMLButtonElement>('btn-follow'),
  rulerPlayhead: element('ruler-playhead'),
  selectedFixture: element('selected-fixture'),
  fixtureCapabilities: element('fixture-capabilities'),
  loading: element('loading'),
};

const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
ui.backend.textContent = backend;

const waveform = new WaveformStrip(ui.waveform, (songSec) => clock.seek(songSec));
let cues: readonly Cue[] = [];
let arrangement: Arrangement;
let currentTimeline: CueTimeline | null = null;
let followPlayhead = true;
let loopRegion = { startSec: loopStartSec, endSec: loopEndSec };

const syncCueInspector = (fixture: (typeof show.fixtures)[number] | null, cue: Cue | null): void => {
  ui.selectedFixture.textContent = fixture?.id ?? 'Select a fixture track';
  ui.fixtureCapabilities.textContent = fixture === null
    ? 'Choose a track to see its available controls'
    : [
        fixture.profile.capabilities.dimmer ? 'Dimmer' : null,
        fixture.profile.capabilities.color ? fixture.profile.capabilities.color.toUpperCase() : null,
        fixture.profile.capabilities.panTilt ? 'Pan / tilt' : null,
        fixture.profile.capabilities.zoom ? 'Zoom' : null,
        fixture.profile.capabilities.strobe ? 'Strobe rate' : null,
        fixture.profile.capabilities.gobo ? 'Gobo' : null,
        fixture.profile.capabilities.prism ? 'Prism' : null,
        fixture.profile.capabilities.rotation ? 'Rotation' : null,
      ].filter((capability) => capability !== null).join(' · ');

  const available = arrangement.selectedActions;
  ui.cueAction.replaceChildren(...available.map((action) => {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = action[0]!.toUpperCase() + action.slice(1);
    return option;
  }));
  ui.cueAction.disabled = fixture === null;
  ui.cueAction.value = cue?.action ?? arrangement.suggestedAction;
  ui.cueColor.disabled = fixture === null || !fixture.profile.capabilities.color;
  ui.cueColor.value = String(cue?.colorIndex ?? arrangement.suggestedColorIndex);
  ui.cueDelete.disabled = cue === null;
  ui.cueAdd.disabled = fixture === null || clock.duration <= 0;
  const count = cues.length;
  ui.cueStatus.textContent = `${count} clip${count === 1 ? '' : 's'} · click or drag a lane to add`;
};

ui.cueColor.replaceChildren(...CUE_COLORS.map((color, index) => {
  const option = document.createElement('option');
  option.value = String(index);
  option.textContent = color.name[0]!.toUpperCase() + color.name.slice(1);
  return option;
}));

arrangement = new Arrangement(ui.arrangement, show.fixtures, (nextCues) => {
  cues = nextCues;
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCue);
}, syncCueInspector);
arrangement.selectFixture(show.fixtures[0]?.id ?? '');

/** Choreography stays on the loop's bar grid even when the audio is not looping. */
const showTime = (songSec: number): number => {
  const length = Math.max(0.001, loopRegion.endSec - loopRegion.startSec);
  return loopRegion.startSec + (((songSec - loopRegion.startSec) % length) + length) % length;
};

const formatClock = (seconds: number): string => {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${(safe - minutes * 60).toFixed(1).padStart(4, '0')}`;
};

const syncButtons = (): void => {
  ui.play.classList.toggle('on', clock.playing);
  ui.play.textContent = clock.playing ? '❚❚ Pause' : '▶ Play';
  ui.loop.textContent = clock.loopEnabled ? 'on' : 'off';
  ui.vol.classList.toggle('on', volumetrics);
  ui.bloom.classList.toggle('on', bloomOn);
  ui.shadow.classList.toggle('on', shadowsOn);
  ui.lofi.classList.toggle('on', lofi);
  ui.strobe.classList.toggle('on', strobesOn);
  ui.strobeStatus.textContent = strobesOn ? 'on' : 'off';
  ui.count.querySelector('em')!.textContent = String(activeCount);
};

const applyShadows = (): void => {
  stage.setShadows(shadowsOn);
  renderer.shadowMap.enabled = shadowsOn;
  stage.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.material === undefined) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material.needsUpdate = true;
  });
};

const setActiveCount = (count: number): void => {
  activeCount = count;
  stage.setActiveCount(count);
  syncButtons();
};

const togglePlay = (): void => {
  void clock.toggle().then(syncButtons);
};

ui.play.addEventListener('click', togglePlay);

/**
 * Mirrors the `--track-width` CSS variable so zoom/fit/follow math stays correct
 * when the responsive breakpoint changes the label column width.
 */
let cachedTrackWidth = TRACK_LABEL_WIDTH;
const measureTrackWidth = (): void => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--track-width');
  const parsed = Number.parseFloat(raw);
  cachedTrackWidth = Number.isFinite(parsed) && parsed > 0 ? parsed : TRACK_LABEL_WIDTH;
};
const labelWidth = (): number => cachedTrackWidth;
measureTrackWidth();

const ZOOM_SLIDER_STEPS = 1000;
const ZOOM_RANGE = MAX_PIXELS_PER_SECOND / MIN_PIXELS_PER_SECOND;
const zoomToSlider = (zoom: number): number =>
  Math.round((Math.log(zoom / MIN_PIXELS_PER_SECOND) / Math.log(ZOOM_RANGE)) * ZOOM_SLIDER_STEPS);
const sliderToZoom = (value: number): number =>
  MIN_PIXELS_PER_SECOND * Math.pow(ZOOM_RANGE, value / ZOOM_SLIDER_STEPS);

const setZoom = (nextZoom: number, anchorClientX?: number): void => {
  if (currentTimeline === null) return;
  const previousZoom = arrangement.zoomLevel;
  const zoom = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, nextZoom));
  const trackWidth = labelWidth();
  const bounds = ui.arrangementScroll.getBoundingClientRect();
  const anchorX = anchorClientX === undefined
    ? Math.max(trackWidth, ui.arrangementScroll.clientWidth / 2)
    : Math.max(trackWidth, anchorClientX - bounds.left);
  const anchorTime = Math.max(0, ui.arrangementScroll.scrollLeft + anchorX - trackWidth) / previousZoom;
  arrangement.setZoom(zoom);
  const width = currentTimeline.durationSec * zoom;
  ui.waveform.style.width = `${width}px`;
  createRuler(ui.ruler, currentTimeline, width, zoom);
  ui.zoomLevel.value = String(zoomToSlider(zoom));
  ui.zoomPercent.textContent = `${Math.round((zoom / PIXELS_PER_SECOND) * 100)}%`;
  ui.arrangementScroll.scrollLeft = Math.max(0, anchorTime * zoom + trackWidth - anchorX);
  ui.rulerPlayhead.style.left = `${clock.time * zoom}px`;
};
ui.zoomIn.addEventListener('click', () => setZoom(arrangement.zoomLevel * 1.25));
ui.zoomOut.addEventListener('click', () => setZoom(arrangement.zoomLevel * 0.8));
ui.zoomLevel.addEventListener('input', () => setZoom(sliderToZoom(Number(ui.zoomLevel.value))));
ui.zoomFit.addEventListener('click', () => {
  if (currentTimeline === null) return;
  const trackWidth = labelWidth();
  const availableWidth = Math.max(1, ui.arrangementScroll.clientWidth - trackWidth - 18);
  setZoom(availableWidth / currentTimeline.durationSec, trackWidth + availableWidth / 2);
  ui.arrangementScroll.scrollLeft = 0;
});
ui.follow.addEventListener('click', () => {
  followPlayhead = !followPlayhead;
  ui.follow.classList.toggle('on', followPlayhead);
  ui.follow.setAttribute('aria-pressed', String(followPlayhead));
});
ui.arrangementScroll.addEventListener('wheel', (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
  setZoom(arrangement.zoomLevel * factor, event.clientX);
}, { passive: false });

const MIN_LOOP_SEC = 0.25;

const snapTime = (timeSec: number): number => {
  const timeline = currentTimeline;
  if (timeline === null) return timeSec;
  if (timeline.bpm === null || timeline.bpm <= 0) {
    return Math.max(0, Math.min(timeline.durationSec, timeSec));
  }
  const divisionSec = 60 / timeline.bpm / 4;
  return Math.max(0, Math.min(
    timeline.durationSec,
    timeline.firstBeatSec + Math.round((timeSec - timeline.firstBeatSec) / divisionSec) * divisionSec,
  ));
};

const loopRangeLabel = (): string => {
  const timeline = currentTimeline;
  if (timeline === null) return '';
  if (timeline.bpm === null || timeline.bpm <= 0) {
    return `${formatClock(loopRegion.startSec)}–${formatClock(loopRegion.endSec)}`;
  }
  const barSec = (60 / timeline.bpm) * timeline.beatsPerBar;
  const startBar = Math.floor((loopRegion.startSec - timeline.firstBeatSec) / barSec + 1e-6) + 1;
  const endBar = Math.max(startBar, Math.ceil((loopRegion.endSec - timeline.firstBeatSec) / barSec - 1e-6));
  return `${startBar}–${endBar}`;
};

const updateLoopUi = (): void => {
  const enabled = clock.loopEnabled;
  ui.loopBtn.classList.toggle('on', enabled);
  ui.loopBtn.setAttribute('aria-pressed', String(enabled));
  const range = loopRangeLabel();
  ui.loopBtn.textContent = enabled ? `Loop ${range}` : 'Loop off';
  ui.loopBtn.title = `${enabled ? 'Looping' : 'Loop off'}${range === '' ? '' : ` ${range}`} · click or press L to toggle`;
};

const applyLoop = (commitToClock = true): void => {
  if (commitToClock) clock.setLoop({ startSec: loopRegion.startSec, endSec: loopRegion.endSec }, clock.loopEnabled);
  const timeline = currentTimeline;
  if (timeline !== null) {
    currentTimeline = {
      ...timeline,
      loopStartSec: loopRegion.startSec,
      loopEndSec: loopRegion.endSec,
    };
    arrangement.setLoop(loopRegion.startSec, loopRegion.endSec);
    waveform.setTimeline({
      durationSec: timeline.durationSec,
      loopStartSec: loopRegion.startSec,
      loopEndSec: loopRegion.endSec,
      firstBeatSec: timeline.firstBeatSec,
      bpm: timeline.bpm,
      beatsPerBar: timeline.beatsPerBar,
    });
    createRuler(
      ui.ruler,
      currentTimeline,
      timeline.durationSec * arrangement.zoomLevel,
      arrangement.zoomLevel,
    );
  }
  updateLoopUi();
};

const setLoopRegion = (startSec: number, endSec: number, commitToClock = true): void => {
  if (currentTimeline === null) return;
  const duration = currentTimeline.durationSec;
  const start = Math.max(0, Math.min(duration - MIN_LOOP_SEC, startSec));
  const end = Math.max(start + MIN_LOOP_SEC, Math.min(duration, endSec));
  if (Math.abs(start - loopRegion.startSec) < 1e-4 && Math.abs(end - loopRegion.endSec) < 1e-4) return;
  loopRegion = { startSec: start, endSec: end };
  applyLoop(commitToClock);
};

ui.loopBtn.addEventListener('click', () => {
  clock.setLoopEnabled(!clock.loopEnabled);
  updateLoopUi();
  syncButtons();
});
ui.loopFit.addEventListener('click', () => {
  if (currentTimeline === null) return;
  const trackWidth = labelWidth();
  const availableWidth = Math.max(1, ui.arrangementScroll.clientWidth - trackWidth - 18);
  const length = Math.max(MIN_LOOP_SEC, loopRegion.endSec - loopRegion.startSec);
  setZoom(availableWidth / length, trackWidth + availableWidth / 2);
  ui.arrangementScroll.scrollLeft = Math.max(0, loopRegion.startSec * arrangement.zoomLevel);
});

type LoopGesture = { edge: 'start' | 'end' | 'new'; anchorSec: number };
let loopGesture: LoopGesture | null = null;
const LOOP_GRIP_PX = 8;

const rulerTimeAt = (clientX: number): number => {
  const timeline = currentTimeline;
  if (timeline === null) return 0;
  const rect = ui.ruler.getBoundingClientRect();
  const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
  return (x / Math.max(1, rect.width)) * timeline.durationSec;
};

const rulerXFor = (timeSec: number): number => {
  const timeline = currentTimeline;
  if (timeline === null) return 0;
  const rect = ui.ruler.getBoundingClientRect();
  return (timeSec / Math.max(1, timeline.durationSec)) * rect.width;
};

ui.ruler.addEventListener('pointerdown', (event) => {
  if (currentTimeline === null) return;
  ui.ruler.setPointerCapture(event.pointerId);
  const rect = ui.ruler.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const startX = rulerXFor(loopRegion.startSec);
  const endX = rulerXFor(loopRegion.endSec);

  if (event.shiftKey) {
    const anchor = snapTime(rulerTimeAt(event.clientX));
    const beat = currentTimeline.bpm !== null && currentTimeline.bpm > 0 ? 60 / currentTimeline.bpm : 1;
    loopGesture = { edge: 'new', anchorSec: anchor };
    setLoopRegion(anchor, anchor + beat, false);
    return;
  }
  if (Math.abs(x - startX) <= LOOP_GRIP_PX) {
    loopGesture = { edge: 'start', anchorSec: loopRegion.endSec };
  } else if (Math.abs(x - endX) <= LOOP_GRIP_PX) {
    loopGesture = { edge: 'end', anchorSec: loopRegion.startSec };
  } else {
    loopGesture = null;
    clock.seek(rulerTimeAt(event.clientX));
  }
});

ui.ruler.addEventListener('pointermove', (event) => {
  if (!ui.ruler.hasPointerCapture(event.pointerId)) return;
  if (currentTimeline === null) return;
  const time = snapTime(rulerTimeAt(event.clientX));
  if (loopGesture === null) {
    clock.seek(time);
    return;
  }
  if (loopGesture.edge === 'start') {
    setLoopRegion(Math.min(time, loopGesture.anchorSec - MIN_LOOP_SEC), loopGesture.anchorSec, false);
  } else if (loopGesture.edge === 'end') {
    setLoopRegion(loopGesture.anchorSec, Math.max(time, loopGesture.anchorSec + MIN_LOOP_SEC), false);
  } else {
    const a = Math.min(loopGesture.anchorSec, time);
    const b = Math.max(loopGesture.anchorSec, time);
    if (b - a >= MIN_LOOP_SEC) setLoopRegion(a, b, false);
  }
});

const endLoopGesture = (event: PointerEvent): void => {
  const wasLoop = loopGesture !== null;
  loopGesture = null;
  if (ui.ruler.hasPointerCapture(event.pointerId)) ui.ruler.releasePointerCapture(event.pointerId);
  if (wasLoop) applyLoop(true);
};
ui.ruler.addEventListener('pointerup', endLoopGesture);
ui.ruler.addEventListener('pointercancel', endLoopGesture);

// Shift+drag anywhere in the timeline (ruler, waveform, or a fixture lane)
// draws a loop. Capture phase keeps the lane/waveform gesture handlers out of it.
const isPointing = (target: Element, event: PointerEvent): boolean =>
  target.hasPointerCapture(event.pointerId);

ui.arrangementScroll.addEventListener('pointerdown', (event) => {
  if (!event.shiftKey || currentTimeline === null) return;
  event.preventDefault();
  event.stopPropagation();
  const beat = currentTimeline.bpm !== null && currentTimeline.bpm > 0 ? 60 / currentTimeline.bpm : 1;
  const anchor = snapTime(rulerTimeAt(event.clientX));
  loopGesture = { edge: 'new', anchorSec: anchor };
  ui.arrangementScroll.setPointerCapture(event.pointerId);
  setLoopRegion(anchor, anchor + beat, false);
}, { capture: true });

ui.arrangementScroll.addEventListener('pointermove', (event) => {
  if (loopGesture === null || loopGesture.edge !== 'new' || currentTimeline === null) return;
  if (!isPointing(ui.arrangementScroll, event)) return;
  const time = snapTime(rulerTimeAt(event.clientX));
  const a = Math.min(loopGesture.anchorSec, time);
  const b = Math.max(loopGesture.anchorSec, time);
  if (b - a >= MIN_LOOP_SEC) setLoopRegion(a, b, false);
});

const endScrollLoopGesture = (event: PointerEvent): void => {
  if (loopGesture === null || loopGesture.edge !== 'new') return;
  loopGesture = null;
  if (ui.arrangementScroll.hasPointerCapture(event.pointerId)) {
    ui.arrangementScroll.releasePointerCapture(event.pointerId);
  }
  applyLoop(true);
};
ui.arrangementScroll.addEventListener('pointerup', endScrollLoopGesture);
ui.arrangementScroll.addEventListener('pointercancel', endScrollLoopGesture);

const setLoopMode = (on: boolean): void => {
  ui.arrangementScroll.classList.toggle('loop-mode', on);
};
window.addEventListener('keydown', (event) => {
  if (event.key === 'Shift') setLoopMode(true);
});
window.addEventListener('keyup', (event) => {
  if (event.key === 'Shift') setLoopMode(false);
});
window.addEventListener('blur', () => setLoopMode(false));
const isTextEntry = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLSelectElement ||
  target instanceof HTMLTextAreaElement;

window.addEventListener('keydown', (event) => {
  if (!(event.ctrlKey || event.metaKey)) return;
  if (isTextEntry(event.target)) return;
  if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    setZoom(arrangement.zoomLevel * 1.25);
  } else if (event.key === '-') {
    event.preventDefault();
    setZoom(arrangement.zoomLevel * 0.8);
  } else if (event.key === '0') {
    event.preventDefault();
    ui.zoomFit.click();
  }
});
const selectedAction = () => arrangement.selectedActions.find((action) => action === ui.cueAction.value)
  ?? arrangement.suggestedAction;
ui.cueAdd.addEventListener('click', () => arrangement.addAt(clock.time, selectedAction()));
ui.cueAction.addEventListener('change', () => {
  const action = selectedAction();
  arrangement.setPendingAction(action);
  arrangement.setSelectedAction(action);
});
ui.cueColor.addEventListener('change', () => {
  const colorIndex = Number(ui.cueColor.value);
  arrangement.setPendingColor(colorIndex);
  arrangement.setSelectedColor(colorIndex);
});
ui.cueDelete.addEventListener('click', () => arrangement.deleteSelected());
ui.chooseAudio.addEventListener('click', () => ui.audioFile.click());
ui.audioFile.addEventListener('change', () => {
  const file = ui.audioFile.files?.[0];
  ui.audioFile.value = '';
  if (file === undefined) return;

  ui.chooseAudio.disabled = true;
  ui.audioStatus.textContent = `Loading ${file.name}…`;
  void (async () => {
    try {
      const buffer = await clock.decode(await file.arrayBuffer());
      clock.load(buffer);
      clock.setLoop({ startSec: 0, endSec: buffer.duration }, true);
      clock.seek(0);
      ui.transportTrack.textContent = file.name;
      ui.transportTime.textContent = `${formatClock(0)} / ${formatClock(buffer.duration)}`;
      ui.audioStatus.textContent = 'Local audio loaded · beat grid not set';
      waveform.setTimeline({
        durationSec: buffer.duration,
        loopStartSec: 0,
        loopEndSec: buffer.duration,
        firstBeatSec: 0,
        bpm: null,
        beatsPerBar: TRACK.beatsPerBar,
      });
      waveform.setPeaks(computePeaks(buffer, 1600));
      const timeline: CueTimeline = {
        durationSec: buffer.duration,
        firstBeatSec: 0,
        bpm: null,
        beatsPerBar: TRACK.beatsPerBar,
        loopStartSec: 0,
        loopEndSec: buffer.duration,
      };
      currentTimeline = timeline;
      loopRegion = { startSec: 0, endSec: buffer.duration };
      waveform.setTimeline({ ...timeline, loopStartSec: 0, loopEndSec: buffer.duration });
      ui.waveform.style.width = `${buffer.duration * arrangement.zoomLevel}px`;
      createRuler(ui.ruler, timeline, buffer.duration * arrangement.zoomLevel, arrangement.zoomLevel);
      arrangement.setTimeline(timeline);
      ui.arrangementScroll.scrollLeft = 0;
      ui.zoomIn.disabled = false;
      ui.zoomOut.disabled = false;
      ui.zoomFit.disabled = false;
      ui.zoomLevel.disabled = false;
      ui.loopBtn.disabled = false;
      ui.loopFit.disabled = false;
      setZoom(PIXELS_PER_SECOND);
      applyLoop();
      ui.play.disabled = false;
    } catch (error) {
      console.error(`could not load audio file "${file.name}"`, error);
      ui.audioStatus.textContent = `Could not load ${file.name}; previous audio is unchanged`;
    } finally {
      ui.chooseAudio.disabled = false;
      syncButtons();
    }
  })();
});
ui.vol.addEventListener('click', () => {
  volumetrics = !volumetrics;
  syncButtons();
});
ui.bloom.addEventListener('click', () => {
  bloomOn = !bloomOn;
  post.setBloom(bloomOn);
  syncButtons();
});
ui.shadow.addEventListener('click', () => {
  shadowsOn = !shadowsOn;
  applyShadows();
  syncButtons();
});
ui.lofi.addEventListener('click', () => {
  lofi = !lofi;
  post.setLofi(lofi);
  syncButtons();
});
ui.strobe.addEventListener('click', () => {
  strobesOn = !strobesOn;
  syncButtons();
});
ui.view.addEventListener('click', () => stage.nextView());
ui.count.addEventListener('click', () => {
  countIndex = (countIndex + 1) % counts.length;
  setActiveCount(counts[countIndex] ?? show.fixtures.length);
});

window.addEventListener('keydown', (event) => {
  if (isTextEntry(event.target)) return;
  // A focused button already handles Space (and Enter) itself.
  if (event.code === 'Space' && event.target instanceof HTMLButtonElement) return;
  if (event.code === 'Space') {
    event.preventDefault();
    togglePlay();
  } else if (event.key === '1') {
    volumetrics = !volumetrics;
  } else if (event.key === '2') {
    bloomOn = !bloomOn;
    post.setBloom(bloomOn);
  } else if (event.key === '3') {
    shadowsOn = !shadowsOn;
    applyShadows();
  } else if (event.key === '4') {
    lofi = !lofi;
    post.setLofi(lofi);
  } else if (event.key === '5') {
    strobesOn = !strobesOn;
  } else if (event.key === 'l' || event.key === 'L') {
    clock.setLoopEnabled(!clock.loopEnabled);
    updateLoopUi();
  } else if (event.key === 'c' || event.key === 'C') {
    stage.nextView();
  } else if (event.key === '[' || event.key === ']') {
    const step = event.key === ']' ? 1 : -1;
    countIndex = (countIndex + step + counts.length) % counts.length;
    setActiveCount(counts[countIndex] ?? show.fixtures.length);
  }
  syncButtons();
});

const resizeViewport = (): void => {
  measureTrackWidth();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  stage.camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  stage.camera.updateProjectionMatrix();
};
window.addEventListener('resize', resizeViewport);

let resolutionScale = 1;
let smoothedFrameMs = 16.7;
let framesSinceAdjust = 0;
let lastFrame = performance.now();
let lastStats = 0;

const adjustResolution = (): void => {
  if (framesSinceAdjust < 45) return;
  framesSinceAdjust = 0;

  if (smoothedFrameMs > 20.5 && resolutionScale > 0.55) {
    resolutionScale = Math.max(0.55, resolutionScale - 0.08);
    renderer.setPixelRatio(baseRatio * resolutionScale);
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  } else if (smoothedFrameMs < 13.2 && resolutionScale < 1) {
    resolutionScale = Math.min(1, resolutionScale + 0.05);
    renderer.setPixelRatio(baseRatio * resolutionScale);
    renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  }
};

const updateStats = (now: number, states: ReturnType<typeof evaluateFixtureStates>, songTime: number): void => {
  if (now - lastStats < 250) return;
  lastStats = now;
  syncButtons();

  const info = renderer.info.render;
  ui.fps.textContent = (1000 / smoothedFrameMs).toFixed(0);
  ui.ms.textContent = `${smoothedFrameMs.toFixed(1)} ms`;
  ui.calls.textContent = String(info.drawCalls);
  ui.tris.textContent = info.triangles.toLocaleString('en-US');
  ui.res.textContent = `${(resolutionScale * 100).toFixed(0)}%`;
  ui.latency.textContent = `${(clock.latencySec * 1000).toFixed(1)} ms`;

  const active = states.slice(0, activeCount).filter((state) => state.active).length;
  ui.fixtures.textContent = `${active} active / ${activeCount} shown`;

  const { beatsPerBar } = show.beatGrid;
  const beat = timeToBeat(show.beatGrid, showTime(songTime));
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = Math.floor(((beat % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1;
  ui.time.textContent = `${bar}.${beatInBar}`;
  ui.transportTime.textContent = `${formatClock(songTime)} / ${formatClock(clock.duration)}`;
};

const frame = (now: number): void => {
  const delta = now - lastFrame;
  lastFrame = now;
  smoothedFrameMs += (Math.min(delta, 100) - smoothedFrameMs) * 0.08;
  framesSinceAdjust += 1;

  const songTime = clock.time;
  if (clock.playing && followPlayhead) {
    const trackWidth = labelWidth();
    const pps = arrangement.zoomLevel;
    // Content coordinates include the sticky label column; the lane starts after it.
    const playheadX = trackWidth + songTime * pps;
    const scroll = ui.arrangementScroll;
    const viewportRight = scroll.scrollLeft + scroll.clientWidth;
    const visibleLeft = scroll.scrollLeft + trackWidth;
    if (playheadX > viewportRight - 140) {
      scroll.scrollLeft = playheadX - scroll.clientWidth + 200;
    } else if (playheadX < visibleLeft + 40) {
      scroll.scrollLeft = Math.max(0, playheadX - trackWidth - 80);
    }
  }
  const showAt = showTime(songTime);
  const demoStates = evaluateFixtureStates(show, showAt);
  const states = show.fixtures.map((fixture, index) => {
    const demoState = demoStates[index];
    if (demoState === undefined) return demoState;
    const trackCues = cues.filter((cue) =>
      cue.fixtureId === fixture.id && songTime >= cue.startSec && songTime <= cue.endSec,
    );
    const trackClips = trackCues.map((cue) => arrangement.toClip(cue));
    if (trackClips.length === 0) return demoState;
    const cueState = evaluateFixture(fixture, trackClips, songTime);
    return {
      ...demoState,
      intensity: cueState.intensity,
      active: cueState.active,
      ...(fixture.profile.capabilities.color ? { color: cueState.color } : {}),
      ...(trackCues.some((cue) => cue.action === 'sweep')
        ? { panDeg: cueState.panDeg, tiltDeg: cueState.tiltDeg }
        : {}),
      ...(trackCues.some((cue) => cue.action === 'strobe')
        ? { strobeHz: cueState.strobeHz }
        : {}),
    };
  }).filter((state) => state !== undefined).map((state) =>
    state.kind === 'strobe' && !strobesOn
      ? { ...state, intensity: 0, active: false, strobeHz: 0 }
      : state,
  );

  stage.update(states, showAt, { volumetrics });
  post.setTime(showAt);
  renderer.info.reset();
  post.render();

  waveform.render(songTime);
  arrangement.setSongTime(songTime);
  ui.rulerPlayhead.style.left = `${songTime * arrangement.zoomLevel}px`;
  adjustResolution();
  updateStats(now, states, songTime);

  requestAnimationFrame(frame);
};

ui.loading.textContent = 'loading audio…';

try {
  const response = await fetch(TRACK_URL);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const buffer = await clock.decode(await response.arrayBuffer());
  clock.load(buffer);
  clock.setLoop({ startSec: loopStartSec, endSec: loopEndSec }, true);
  clock.seek(loopStartSec);
  ui.play.disabled = false;

  ui.transportTrack.textContent = `${TRACK.title} — ${TRACK.artist} · ${TRACK.bpm} BPM`;
  ui.audioStatus.textContent = 'Ready';
  waveform.setTimeline({
    durationSec: buffer.duration,
    loopStartSec,
    loopEndSec,
    firstBeatSec: TRACK.firstBeatSec,
    bpm: TRACK.bpm,
    beatsPerBar: TRACK.beatsPerBar,
  });
  waveform.setPeaks(computePeaks(buffer, 1600));
  const timeline: CueTimeline = {
    durationSec: buffer.duration,
    firstBeatSec: TRACK.firstBeatSec,
    bpm: TRACK.bpm,
    beatsPerBar: TRACK.beatsPerBar,
    loopStartSec,
    loopEndSec,
  };
  currentTimeline = timeline;
  loopRegion = { startSec: loopStartSec, endSec: loopEndSec };
  ui.waveform.style.width = `${buffer.duration * arrangement.zoomLevel}px`;
  createRuler(ui.ruler, timeline, buffer.duration * arrangement.zoomLevel, arrangement.zoomLevel);
  arrangement.setTimeline(timeline);
  ui.zoomIn.disabled = false;
  ui.zoomOut.disabled = false;
  ui.zoomFit.disabled = false;
  ui.zoomLevel.disabled = false;
  ui.loopBtn.disabled = false;
  ui.loopFit.disabled = false;
  setZoom(PIXELS_PER_SECOND);
  applyLoop();
  ui.arrangementScroll.scrollLeft = Math.max(0, loopStartSec * PIXELS_PER_SECOND);
  ui.transportTime.textContent = `${formatClock(loopStartSec)} / ${formatClock(buffer.duration)}`;
} catch (error) {
  console.error(error);
  ui.audioStatus.textContent = `Could not load default track: ${TRACK.title}`;
}

ui.loading.hidden = true;
syncButtons();
requestAnimationFrame(frame);
