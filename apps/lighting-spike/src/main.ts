import * as THREE from 'three/webgpu';
import {
  evaluateFixture,
  parseProject,
  timeToBeat,
  type FixtureDefaults,
  type FixtureState,
  type ProjectFile,
  type ProjectSettings,
} from '@dmxsim/show-model';
import { createDemoRig } from './demo-rig';
import { createDemoCues } from './demo-arrangement';
import { AudioClock } from './audio-clock';
import { loopEndSec, loopStartSec, TRACK, TRACK_URL } from './track';
import { computePeaks, WaveformStrip } from './waveform';
import demoProjectUrl from '../../../resources/sample_projects/koto-chill/koto-chill.dmxsim?url';
import {
  applyProjectFixtureSetup,
  cueTimelineFromProject,
  cueToProjectClip,
  downloadProject,
  fixtureIds,
  projectClipToCue,
  projectFileName,
  readProjectFile,
  rigMatches,
  showFromProject,
} from './project-file';
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

/**
 * The demo is a project file, not generated code: the app loads
 * `resources/sample_projects/koto-chill/koto-chill.dmxsim` at startup so the show can be edited on disk and
 * opened back through `Open project`. The procedural rig/cues remain as a
 * fallback if the file is missing or invalid.
 */
const loadBundledProject = async (): Promise<ProjectFile | null> => {
  try {
    const response = await fetch(demoProjectUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return parseProject(await response.json());
  } catch (error) {
    console.warn('could not load the bundled project; using the generated demo rig', error);
    return null;
  }
};

const bundledProject = await loadBundledProject();
const show = bundledProject === null
  ? createDemoRig(loopStartSec, TRACK.bpm)
  : showFromProject(bundledProject);
let projectName = bundledProject?.name ?? 'Untitled project';
let projectDescription = bundledProject?.description;
let projectAudio: ProjectFile['audio'] = bundledProject?.audio ?? {
  source: 'bundled',
  id: 'koto-chill',
  title: TRACK.title,
  artist: TRACK.artist,
  fileName: 'The Koto Chill.ogg',
};
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
  statsPanel: element('stats'),
  controlsPanel: element('controls'),
  controlsToggle: element<HTMLButtonElement>('controls-toggle'),
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
  projectOpen: element<HTMLButtonElement>('btn-project-open'),
  projectSave: element<HTMLButtonElement>('btn-project-save'),
  projectFile: element<HTMLInputElement>('project-file'),
  projectStatus: element('project-status'),
  volume: element<HTMLInputElement>('volume'),
  vol: element<HTMLButtonElement>('btn-vol'),
  bloom: element<HTMLButtonElement>('btn-bloom'),
  shadow: element<HTMLButtonElement>('btn-shadow'),
  lofi: element<HTMLButtonElement>('btn-lofi'),
  strobe: element<HTMLButtonElement>('btn-strobe'),
  strobeStatus: element('strobe-status'),
  view: element<HTMLButtonElement>('btn-view'),
  count: element<HTMLButtonElement>('btn-count'),
    stats: element<HTMLButtonElement>('btn-stats'),
    dock: element('timeline-dock'),
    dockResizer: element('dock-resizer'),
    dockToggle: element<HTMLButtonElement>('btn-dock'),
    waveformResizer: element('waveform-resizer'),
    sidePanel: element<HTMLElement>('side-panel'),
    sidePanelResizer: element('side-panel-resizer'),
    sidePanelClose: element<HTMLButtonElement>('fixture-panel-close'),
    panelFixtureKind: element('fixture-panel-kind'),
    panelFixtureName: element('fixture-panel-name'),
    panelFixtureMeta: element('fixture-panel-meta'),
    panelCapabilities: element('panel-capabilities'),
    panelClipCount: element('panel-clip-count'),
    panelClipActive: element('panel-clip-active'),
  waveform: element<HTMLCanvasElement>('waveform'),
  waveformPlayhead: element('waveform-playhead'),
  waveformHover: element('waveform-hover'),
  tooltip: element('timeline-tooltip'),
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
  loading: element('loading'),
  setupDimmer: element<HTMLInputElement>('setup-dimmer'),
  setupDimmerValue: element('setup-dimmer-value'),
  setupYaw: element<HTMLInputElement>('setup-yaw'),
  setupYawValue: element('setup-yaw-value'),
  setupPitch: element<HTMLInputElement>('setup-pitch'),
  setupPitchValue: element('setup-pitch-value'),
  setupSpreadRow: element('setup-spread-row'),
  setupSpread: element<HTMLInputElement>('setup-spread'),
  setupSpreadValue: element('setup-spread-value'),
};

/**
 * Fixture side panel state. Declared here so selection sync can keep the panel
 * pointed at the right fixture; the panel behaviour lives with the dock
 * handling further down.
 */
let sidePanelOpen = false;
let sidePanelFixtureId: string | null = null;

type Fixture = (typeof show.fixtures)[number];

/**
 * Fixture setup (ADR-010). These values live on the placement and are saved
 * with the project: they are what the fixture does when no clip asserts the
 * attribute, so there is no separate render-only override path any more.
 */
const defaultsFor = (fixture: Fixture): FixtureDefaults => {
  fixture.defaults ??= {};
  return fixture.defaults;
};

const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
ui.backend.textContent = backend;

const waveform = new WaveformStrip(ui.waveform, (songSec) => clock.seek(songSec));
let cues: readonly Cue[] = [];
let arrangement: Arrangement;
let currentTimeline: CueTimeline | null = null;
let followPlayhead = bundledProject?.settings.playback.followPlayhead ?? true;
let loopRegion = bundledProject === null
  ? { startSec: loopStartSec, endSec: loopEndSec }
  : {
      startSec: bundledProject.timeline.loop.startSec,
      endSec: bundledProject.timeline.loop.endSec,
    };

const kindLabel = (kind: string): string =>
  kind.split('-').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ');

/** Capability badges shown in the fixture panel; only what the profile supports. */
const fixtureCapabilityLabels = (fixture: (typeof show.fixtures)[number]): string[] => {
  const caps = fixture.profile.capabilities;
  return [
    caps.dimmer ? 'Dimmer' : null,
    caps.color ? caps.color.toUpperCase() : null,
    caps.panTilt ? 'Pan / tilt' : null,
    caps.zoom ? 'Beam angle' : null,
    caps.focus ? 'Focus' : null,
    caps.strobe ? 'Strobe' : null,
    caps.gobo ? 'Gobo' : null,
    caps.prism ? 'Prism' : null,
    caps.rotation ? 'Rotation' : null,
  ].filter((capability) => capability !== null);
};

const renderPanelCapabilities = (fixture: (typeof show.fixtures)[number] | null): void => {
  const labels = fixture === null ? [] : fixtureCapabilityLabels(fixture);
  if (labels.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'sp-empty';
    empty.textContent = fixture === null
      ? 'Select a fixture to see what it supports.'
      : 'No controllable attributes in this profile.';
    ui.panelCapabilities.replaceChildren(empty);
    return;
  }
  ui.panelCapabilities.replaceChildren(...labels.map((label) => {
    const chip = document.createElement('span');
    chip.className = 'sp-chip';
    chip.textContent = label;
    return chip;
  }));
};

const refreshPanelClipStats = (): void => {
  const fixture = arrangement.selectedFixture;
  const trackCues = fixture === null ? [] : cuesByFixture.get(fixture.id) ?? [];
  const now = clock.time;
  const active = trackCues.filter((cue) => now >= cue.startSec && now <= cue.endSec).length;
  ui.panelClipCount.textContent = String(trackCues.length);
  ui.panelClipActive.textContent = String(active);
};

const syncCueInspector = (fixture: (typeof show.fixtures)[number] | null, cue: Cue | null): void => {
  stage.setSelectedFixture(fixture?.id ?? null);
  ui.selectedFixture.textContent = fixture?.id ?? 'Select a fixture track';
  ui.panelFixtureKind.textContent = fixture === null ? 'Fixture' : kindLabel(fixture.profile.kind);
  ui.panelFixtureName.textContent = fixture?.id ?? 'No fixture selected';
  ui.panelFixtureMeta.textContent = fixture === null
    ? 'Click a track name to open this panel'
    : `${fixture.profile.manufacturer ?? 'Unknown'} · ${fixture.profile.channels.length} DMX channels`;
  renderPanelCapabilities(fixture);
  if (sidePanelOpen) sidePanelFixtureId = fixture?.id ?? null;

  if (fixture === null) {
    ui.setupDimmer.disabled = true;
    ui.setupYaw.disabled = true;
    ui.setupPitch.disabled = true;
    ui.setupSpread.disabled = true;
    ui.setupSpreadRow.hidden = true;
  } else {
    const defaults = defaultsFor(fixture);
    const caps = fixture.profile.capabilities;
    const [spreadMin, spreadMax] = fixture.profile.beam.spreadDeg;
    const dimmer = defaults.dimmer ?? 0;
    const zoom = defaults.zoom ?? 0;
    ui.setupDimmer.disabled = !caps.dimmer;
    ui.setupDimmer.value = String(Math.round(dimmer * 100));
    ui.setupDimmerValue.textContent = `${Math.round(dimmer * 100)}%`;
    ui.setupYaw.disabled = false;
    ui.setupYaw.value = String(Math.round(fixture.yawDeg));
    ui.setupYawValue.textContent = `${Math.round(fixture.yawDeg)}°`;
    ui.setupPitch.disabled = false;
    ui.setupPitch.value = String(Math.round(fixture.pitchOffsetDeg ?? 0));
    ui.setupPitchValue.textContent = `${Math.round(fixture.pitchOffsetDeg ?? 0)}°`;
    ui.setupSpreadRow.hidden = !caps.zoom;
    ui.setupSpread.disabled = !caps.zoom;
    ui.setupSpread.value = String(Math.round(zoom * 100));
    ui.setupSpreadValue.textContent = `${(spreadMin + (spreadMax - spreadMin) * zoom).toFixed(1)}°`;
  }
  refreshPanelClipStats();

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

let cuesByFixture = new Map<string, readonly Cue[]>();
const indexCues = (): void => {
  const next = new Map<string, Cue[]>();
  for (const cue of cues) {
    const list = next.get(cue.fixtureId);
    if (list === undefined) next.set(cue.fixtureId, [cue]);
    else list.push(cue);
  }
  cuesByFixture = next;
};

arrangement = new Arrangement(ui.arrangement, ui.arrangementScroll, show.fixtures, (nextCues) => {
  cues = nextCues;
  indexCues();
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCue);
}, (fixture, cue) => {
  syncCueInspector(fixture, cue);
}, (fixtureId, hidden) => {
  stage.setFixtureHidden(fixtureId, hidden);
}, (fixture) => {
  toggleSidePanel(fixture.id);
});

const updateFixtureSetup = (update: (fixture: Fixture) => void): void => {
  const fixture = arrangement.selectedFixture;
  if (fixture === null) return;
  update(fixture);
  // The next frame re-evaluates the show, so setup edits are visible immediately.
  refreshPanelClipStats();
};

ui.setupDimmer.addEventListener('input', () => updateFixtureSetup((fixture) => {
  defaultsFor(fixture).dimmer = Number(ui.setupDimmer.value) / 100;
  ui.setupDimmerValue.textContent = `${ui.setupDimmer.value}%`;
}));
ui.setupYaw.addEventListener('input', () => updateFixtureSetup((fixture) => {
  fixture.yawDeg = Number(ui.setupYaw.value);
  ui.setupYawValue.textContent = `${ui.setupYaw.value}°`;
}));
ui.setupPitch.addEventListener('input', () => updateFixtureSetup((fixture) => {
  fixture.pitchOffsetDeg = Number(ui.setupPitch.value);
  ui.setupPitchValue.textContent = `${ui.setupPitch.value}°`;
}));
ui.setupSpread.addEventListener('input', () => updateFixtureSetup((fixture) => {
  const [spreadMin, spreadMax] = fixture.profile.beam.spreadDeg;
  const zoom = Number(ui.setupSpread.value) / 100;
  defaultsFor(fixture).zoom = zoom;
  ui.setupSpreadValue.textContent = `${(spreadMin + (spreadMax - spreadMin) * zoom).toFixed(1)}°`;
}));

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

// --- Render preferences (persisted) ---------------------------------------
/**
 * View/render preferences are kept in localStorage so a refresh does not undo
 * the user's setup. The bundled demo project is re-applied on every load, so
 * its settings are only treated as defaults (see `applyProjectSettings`).
 */
const RENDER_KEY = 'dmxsim.spike.render';

interface StoredRenderSettings {
  volumetrics?: boolean;
  bloom?: boolean;
  shadows?: boolean;
  lofi?: boolean;
  strobes?: boolean;
  activeFixtureCount?: number;
  cameraView?: number;
}

const readStoredRender = (): StoredRenderSettings => {
  try {
    const raw = localStorage.getItem(RENDER_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoredRenderSettings) : {};
  } catch {
    return {};
  }
};

const snapshotRender = (): StoredRenderSettings => ({
  volumetrics,
  bloom: bloomOn,
  shadows: shadowsOn,
  lofi,
  strobes: strobesOn,
  activeFixtureCount: activeCount,
  cameraView: stage.view,
});

let persistedRender = '';
/** Write render prefs only when they actually changed. */
const persistRender = (): void => {
  const next = JSON.stringify(snapshotRender());
  if (next === persistedRender) return;
  persistedRender = next;
  localStorage.setItem(RENDER_KEY, next);
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
  persistRender();
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

/**
 * Follow mode needs the scroll viewport every frame. Reading `scrollLeft` /
 * `clientWidth` after style writes forces a synchronous layout (expensive with
 * a wide, sticky timeline), so cache them from events instead.
 */
const scrollMetrics = { left: 0, width: 0 };
const refreshScrollMetrics = (): void => {
  scrollMetrics.left = ui.arrangementScroll.scrollLeft;
  scrollMetrics.width = ui.arrangementScroll.clientWidth;
};
ui.arrangementScroll.addEventListener('scroll', refreshScrollMetrics, { passive: true });
new ResizeObserver(refreshScrollMetrics).observe(ui.arrangementScroll);
refreshScrollMetrics();

const VOLUME_KEY = 'dmxsim.spike.volume';
const storedVolume = Number.parseFloat(localStorage.getItem(VOLUME_KEY) ?? '');
let volume = Number.isFinite(storedVolume) ? Math.min(1, Math.max(0, storedVolume)) : 1;
let muted = false;

/**
 * `muted` is a keyboard-only state now (`M`): there is no mute button, so the
 * slider reflects it through colour and its tooltip.
 */
const applyVolume = (persist = true): void => {
  clock.setVolume(muted ? 0 : volume);
  ui.volume.value = String(Math.round(volume * 100));
  ui.volume.classList.toggle('muted', muted);
  ui.volume.title = muted ? 'Muted — press M or move the slider to unmute' : 'Playback volume (M mutes)';
  if (persist) localStorage.setItem(VOLUME_KEY, String(volume));
};

ui.volume.addEventListener('input', () => {
  volume = Number(ui.volume.value) / 100;
  muted = false;
  applyVolume();
});
applyVolume(false);

// --- View preferences (persisted) -----------------------------------------
const STATS_KEY = 'dmxsim.spike.stats';
let statsVisible = localStorage.getItem(STATS_KEY) !== 'off';
const applyStats = (): void => {
  ui.statsPanel.hidden = !statsVisible;
  ui.stats.classList.toggle('on', statsVisible);
  ui.stats.setAttribute('aria-pressed', String(statsVisible));
};
const setStatsVisible = (visible: boolean, persist = true): void => {
  statsVisible = visible;
  if (persist) localStorage.setItem(STATS_KEY, visible ? 'on' : 'off');
  applyStats();
};
const toggleStats = (): void => setStatsVisible(!statsVisible);
applyStats();
ui.stats.addEventListener('click', toggleStats);

const CONTROLS_KEY = 'dmxsim.spike.controlsVisible';
let controlsVisible = localStorage.getItem(CONTROLS_KEY) === 'on';
const applyControls = (): void => {
  ui.controlsPanel.hidden = !controlsVisible;
  ui.controlsToggle.classList.toggle('on', controlsVisible);
  ui.controlsToggle.setAttribute('aria-pressed', String(controlsVisible));
};
const setControlsVisible = (visible: boolean, persist = true): void => {
  controlsVisible = visible;
  if (persist) localStorage.setItem(CONTROLS_KEY, visible ? 'on' : 'off');
  applyControls();
};
const toggleControls = (): void => setControlsVisible(!controlsVisible);
applyControls();
ui.controlsToggle.addEventListener('click', toggleControls);

const DOCK_HEIGHT_KEY = 'dmxsim.spike.dockHeight';
const DOCK_COLLAPSED_KEY = 'dmxsim.spike.dockCollapsed';
const WAVE_HEIGHT_KEY = 'dmxsim.spike.waveHeight';
const COLLAPSED_DOCK_PX = 54;
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const storedDockHeight = Number.parseFloat(localStorage.getItem(DOCK_HEIGHT_KEY) ?? '');
let dockHeightPx = Number.isFinite(storedDockHeight) ? storedDockHeight : 0;
let dockCollapsed = localStorage.getItem(DOCK_COLLAPSED_KEY) === 'on';

const applyDock = (): void => {
  const root = document.documentElement;
  if (dockCollapsed) root.style.setProperty('--dock-height', `${COLLAPSED_DOCK_PX}px`);
  else if (dockHeightPx > 0) root.style.setProperty('--dock-height', `${dockHeightPx}px`);
  else root.style.removeProperty('--dock-height');
  ui.dock.classList.toggle('collapsed', dockCollapsed);
  ui.dockToggle.textContent = dockCollapsed ? 'Expand timeline' : 'Collapse timeline';
  ui.dockToggle.setAttribute('aria-expanded', String(!dockCollapsed));
  // The 3D viewport is laid out from --dock-height, so it must re-measure.
  requestAnimationFrame(() => resizeViewport());
};

let dockDrag: { startY: number; startHeight: number } | null = null;
ui.dockResizer.addEventListener('pointerdown', (event) => {
  if (dockCollapsed) return;
  dockDrag = { startY: event.clientY, startHeight: ui.dock.getBoundingClientRect().height };
  ui.dockResizer.setPointerCapture(event.pointerId);
  ui.dockResizer.classList.add('dragging');
  event.preventDefault();
});
ui.dockResizer.addEventListener('pointermove', (event) => {
  if (dockDrag === null) return;
  dockHeightPx = clamp(
    dockDrag.startHeight - (event.clientY - dockDrag.startY),
    180,
    window.innerHeight - 160,
  );
  applyDock();
});
const endDockDrag = (): void => {
  if (dockDrag === null) return;
  dockDrag = null;
  ui.dockResizer.classList.remove('dragging');
  localStorage.setItem(DOCK_HEIGHT_KEY, String(Math.round(dockHeightPx)));
};
ui.dockResizer.addEventListener('pointerup', endDockDrag);
ui.dockResizer.addEventListener('pointercancel', endDockDrag);

ui.dockToggle.addEventListener('click', () => {
  dockCollapsed = !dockCollapsed;
  localStorage.setItem(DOCK_COLLAPSED_KEY, dockCollapsed ? 'on' : 'off');
  applyDock();
});

const storedWaveHeight = Number.parseFloat(localStorage.getItem(WAVE_HEIGHT_KEY) ?? '');
let waveHeightPx = Number.isFinite(storedWaveHeight) ? Math.max(40, Math.min(200, storedWaveHeight)) : 62;
const applyWaveHeight = (): void => {
  document.documentElement.style.setProperty('--wave-height', `${waveHeightPx}px`);
  waveform.paint();
};
applyWaveHeight();

let waveDrag: { startY: number; startHeight: number } | null = null;
ui.waveformResizer.addEventListener('pointerdown', (event) => {
  waveDrag = { startY: event.clientY, startHeight: ui.waveform.getBoundingClientRect().height };
  ui.waveformResizer.setPointerCapture(event.pointerId);
  ui.waveformResizer.classList.add('dragging');
  event.preventDefault();
});
ui.waveformResizer.addEventListener('pointermove', (event) => {
  if (waveDrag === null) return;
  waveHeightPx = Math.max(40, Math.min(200, waveDrag.startHeight + (event.clientY - waveDrag.startY)));
  applyWaveHeight();
});
const endWaveDrag = (): void => {
  if (waveDrag === null) return;
  waveDrag = null;
  ui.waveformResizer.classList.remove('dragging');
  localStorage.setItem(WAVE_HEIGHT_KEY, String(Math.round(waveHeightPx)));
};
ui.waveformResizer.addEventListener('pointerup', endWaveDrag);
ui.waveformResizer.addEventListener('pointercancel', endWaveDrag);

applyDock();

// --- Fixture side panel ---------------------------------------------------
const PANEL_WIDTH_KEY = 'dmxsim.spike.sidePanelWidth';
const PANEL_MIN_WIDTH = 210;
const PANEL_MAX_WIDTH = 520;
const storedPanelWidth = Number.parseFloat(localStorage.getItem(PANEL_WIDTH_KEY) ?? '');
let panelWidthPx = Number.isFinite(storedPanelWidth)
  ? clamp(storedPanelWidth, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH)
  : 0;

const applyPanelWidth = (): void => {
  const root = document.documentElement;
  // On narrow screens the responsive width in index.html wins; a persisted
  // pixel width would otherwise squeeze the timeline too far.
  if (panelWidthPx > 0 && window.innerWidth > 680) {
    root.style.setProperty('--side-panel-width', `${Math.round(panelWidthPx)}px`);
  } else {
    root.style.removeProperty('--side-panel-width');
  }
};

/**
 * The arrangement lives in the first dock column, so closing the panel gives it
 * the full width back. After the column changes we wait for layout to settle,
 * then re-measure the scroll viewport and repaint the canvas-backed pieces.
 */
const applySidePanel = (): void => {
  ui.sidePanel.hidden = !sidePanelOpen;
  ui.dock.classList.toggle('has-panel', sidePanelOpen);
  requestAnimationFrame(() => {
    refreshScrollMetrics();
    waveform.requestPaint();
  });
};

const setSidePanelOpen = (open: boolean, fixtureId?: string): void => {
  sidePanelOpen = open;
  if (open && fixtureId !== undefined) sidePanelFixtureId = fixtureId;
  applySidePanel();
};

/** Clicking a light's name opens its panel; clicking it again closes it. */
const toggleSidePanel = (fixtureId: string): void => {
  if (sidePanelOpen && sidePanelFixtureId === fixtureId) {
    setSidePanelOpen(false);
    return;
  }
  setSidePanelOpen(true, fixtureId);
};

ui.sidePanelClose.addEventListener('click', () => setSidePanelOpen(false));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidePanelOpen) setSidePanelOpen(false);
});

let panelResize: { startX: number; startWidth: number } | null = null;

const movePanelResize = (event: PointerEvent): void => {
  if (panelResize === null) return;
  const maxWidth = clamp(window.innerWidth - 420, PANEL_MIN_WIDTH, PANEL_MAX_WIDTH);
  panelWidthPx = clamp(
    panelResize.startWidth - (event.clientX - panelResize.startX),
    PANEL_MIN_WIDTH,
    maxWidth,
  );
  applyPanelWidth();
};

const endPanelResize = (): void => {
  if (panelResize === null) return;
  panelResize = null;
  ui.sidePanelResizer.classList.remove('dragging');
  window.removeEventListener('pointermove', movePanelResize);
  window.removeEventListener('pointerup', endPanelResize);
  window.removeEventListener('pointercancel', endPanelResize);
  localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(panelWidthPx)));
  refreshScrollMetrics();
  waveform.requestPaint();
};

ui.sidePanelResizer.addEventListener('pointerdown', (event) => {
  panelResize = { startX: event.clientX, startWidth: ui.sidePanel.getBoundingClientRect().width };
  ui.sidePanelResizer.classList.add('dragging');
  window.addEventListener('pointermove', movePanelResize);
  window.addEventListener('pointerup', endPanelResize);
  window.addEventListener('pointercancel', endPanelResize);
  event.preventDefault();
});

applyPanelWidth();
applySidePanel();

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
  const nextScroll = Math.max(0, anchorTime * zoom + trackWidth - anchorX);
  ui.arrangementScroll.scrollLeft = nextScroll;
  scrollMetrics.left = nextScroll;
  waveform.requestPaint();
  setRulerPlayhead(clock.time * zoom);
};

const setRulerPlayhead = (x: number): void => {
  ui.rulerPlayhead.style.transform = `translate3d(${x}px, 0, 0)`;
};
const setWaveformPlayhead = (x: number): void => {
  ui.waveformPlayhead.style.transform = `translate3d(${x}px, 0, 0)`;
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

/** Arrow-key seek: one 1/16 by default, one bar with Shift. */
const seekBy = (direction: 1 | -1, coarse: boolean): void => {
  const timeline = currentTimeline;
  if (timeline === null) return;
  const bpm = timeline.bpm;
  const stepSec = bpm !== null && bpm > 0
    ? (coarse ? (60 / bpm) * timeline.beatsPerBar : 60 / bpm / 4)
    : (coarse ? 5 : 1);
  clock.seek(snapTime(clock.time) + direction * stepSec);
};

const barBeatLabel = (timeSec: number): string => {
  const timeline = currentTimeline;
  if (timeline === null || timeline.bpm === null || timeline.bpm <= 0) {
    return formatClock(timeSec);
  }
  const beatSec = 60 / timeline.bpm;
  const beat = (timeSec - timeline.firstBeatSec) / beatSec;
  const beatsPerBar = Math.max(1, timeline.beatsPerBar);
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = Math.floor(((beat % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1;
  return `${bar}.${beatInBar}`;
};

const showTimelineTooltip = (event: PointerEvent, timeSec: number, hint: string): void => {
  ui.tooltip.hidden = false;
  ui.tooltip.textContent = `${barBeatLabel(timeSec)} · ${formatClock(timeSec)} · ${hint}`;
  ui.tooltip.style.left = `${event.clientX + 14}px`;
  ui.tooltip.style.top = `${event.clientY + 16}px`;
};
const hideTimelineTooltip = (): void => {
  ui.tooltip.hidden = true;
};
ui.waveform.addEventListener('pointermove', (event) => {
  ui.waveformHover.hidden = false;
  ui.waveformHover.style.transform = `translate3d(${event.offsetX}px, 0, 0)`;
  showTimelineTooltip(event, event.offsetX / arrangement.zoomLevel, 'click to seek');
});
ui.waveform.addEventListener('pointerleave', () => {
  ui.waveformHover.hidden = true;
  hideTimelineTooltip();
});
ui.ruler.addEventListener('pointermove', (event) => {
  showTimelineTooltip(event, event.offsetX / arrangement.zoomLevel, 'click to seek · Shift-drag for loop');
});
ui.ruler.addEventListener('pointerleave', hideTimelineTooltip);

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
    waveform.requestPaint();
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

ui.ruler.addEventListener('pointermove', (event) => {
  if (ui.ruler.hasPointerCapture(event.pointerId)) return;
  const rect = ui.ruler.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const near = Math.abs(x - rulerXFor(loopRegion.startSec)) <= LOOP_GRIP_PX
    || Math.abs(x - rulerXFor(loopRegion.endSec)) <= LOOP_GRIP_PX;
  ui.ruler.style.cursor = near ? 'col-resize' : 'ew-resize';
});

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
  } else if (event.key === 'z' || event.key === 'Z') {
    event.preventDefault();
    if (event.shiftKey) arrangement.redo();
    else arrangement.undo();
  } else if (event.key === 'y' || event.key === 'Y') {
    event.preventDefault();
    arrangement.redo();
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
      projectAudio = { source: 'external', fileName: file.name };
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
      enableTimelineControls();
      setZoom(PIXELS_PER_SECOND);
      applyLoop();
      setProjectStatus('Local audio attached · use Save project to keep the reference');
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
ui.view.addEventListener('click', () => {
  stage.nextView();
  persistRender();
});
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
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    seekBy(event.key === 'ArrowRight' ? 1 : -1, event.shiftKey);
  } else if (event.key === 'Backspace' || event.key === 'Delete') {
    // Backspace is also the browser's "back" shortcut; only intercept it when
    // there is actually a clip to delete.
    if (arrangement.selectedCue === null) return;
    event.preventDefault();
    arrangement.deleteSelected();
  } else if (event.key === 'm' || event.key === 'M') {
    muted = !muted;
    applyVolume(false);
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
  } else if (event.key === 's' || event.key === 'S') {
    toggleStats();
  } else if (event.key === '`' || event.key === '~') {
    toggleControls();
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
  applyPanelWidth();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  stage.camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  stage.camera.updateProjectionMatrix();
  refreshScrollMetrics();
  waveform.paint();
};
window.addEventListener('resize', resizeViewport);

let resolutionScale = 1;
let smoothedFrameMs = 16.7;
let smoothedCpuMs = 1;
let lastFrame = performance.now();
let lastStats = 0;
let lastResolutionChange = 0;
const RESOLUTION_COOLDOWN_MS = 3000;

const applyResolutionScale = (now: number): void => {
  lastResolutionChange = now;
  renderer.setPixelRatio(baseRatio * resolutionScale);
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
};

/**
 * Adaptive resolution is a GPU lever. Two rules keep it from misfiring:
 * - never resize while paused (a framebuffer reallocation reads as a flash,
 *   and there is no playback load to measure);
 * - only downscale when the main thread is not the bottleneck, because a
 *   CPU-paint-bound frame (e.g. Firefox with the timeline) cannot be fixed by
 *   rendering fewer pixels.
 */
const adjustResolution = (deltaMs: number, cpuMs: number, now: number): void => {
  if (document.hidden || !clock.playing) return;
  if (now - lastResolutionChange < RESOLUTION_COOLDOWN_MS) return;

  if (smoothedFrameMs < 13.2) {
    if (resolutionScale >= 1) return;
    resolutionScale = Math.min(1, resolutionScale + 0.1);
    applyResolutionScale(now);
    return;
  }
  if (smoothedFrameMs < 20.5) return;

  const gpuBound = cpuMs < deltaMs * 0.5;
  if (!gpuBound || resolutionScale <= 0.55) return;
  resolutionScale = Math.max(0.55, resolutionScale - 0.1);
  applyResolutionScale(now);
};

const updateStats = (now: number, states: readonly FixtureState[], songTime: number): void => {
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
  if (sidePanelOpen) refreshPanelClipStats();
};

const frame = (now: number): void => {
  const workStart = performance.now();
  const delta = now - lastFrame;
  lastFrame = now;
  smoothedFrameMs += (Math.min(delta, 100) - smoothedFrameMs) * 0.08;

  const songTime = clock.time;
  if (clock.playing && followPlayhead) {
    const trackWidth = labelWidth();
    const pps = arrangement.zoomLevel;
    const viewportWidth = scrollMetrics.width || ui.arrangementScroll.clientWidth;
    // Content coordinates include the sticky label column; the lane starts after it.
    const playheadX = trackWidth + songTime * pps;
    const viewportRight = scrollMetrics.left + viewportWidth;
    const visibleLeft = scrollMetrics.left + trackWidth;
    if (playheadX > viewportRight - 140) {
      const next = Math.max(0, playheadX - viewportWidth + 200);
      ui.arrangementScroll.scrollLeft = next;
      scrollMetrics.left = next;
    } else if (playheadX < visibleLeft + 40) {
      const next = Math.max(0, playheadX - trackWidth - 80);
      ui.arrangementScroll.scrollLeft = next;
      scrollMetrics.left = next;
    }
  }
  const showAt = showTime(songTime);
  const states = show.fixtures.map((fixture) => {
    const trackClips = (cuesByFixture.get(fixture.id) ?? [])
      .filter((cue) => songTime >= cue.startSec && songTime <= cue.endSec)
      .map((cue) => arrangement.toClip(cue));
    const state = evaluateFixture(fixture, trackClips, songTime);
    return fixture.profile.kind === 'strobe' && !strobesOn
      ? { ...state, intensity: 0, active: false, strobeHz: 0 }
      : state;
  });

  stage.update(states, showAt, { volumetrics });
  post.setTime(showAt);
  renderer.info.reset();
  post.render();

  arrangement.setSongTime(songTime);
  const playheadX = songTime * arrangement.zoomLevel;
  setRulerPlayhead(playheadX);
  setWaveformPlayhead(playheadX);

  const cpuMs = performance.now() - workStart;
  smoothedCpuMs += (cpuMs - smoothedCpuMs) * 0.08;
  adjustResolution(delta, smoothedCpuMs, now);
  updateStats(now, states, songTime);

  requestAnimationFrame(frame);
};

// --- Project files --------------------------------------------------------

const setProjectStatus = (message: string): void => {
  ui.projectStatus.textContent = message;
};

const describeAudio = (audio: ProjectFile['audio'], bpm: number | null): string => {
  if (audio.source === 'bundled' && audio.title !== undefined) {
    const artist = audio.artist === undefined ? '' : ` — ${audio.artist}`;
    const tempo = bpm === null ? '' : ` · ${Math.round(bpm)} BPM`;
    return `${audio.title}${artist}${tempo}`;
  }
  return audio.fileName ?? 'Local audio';
};

const enableTimelineControls = (): void => {
  ui.zoomIn.disabled = false;
  ui.zoomOut.disabled = false;
  ui.zoomFit.disabled = false;
  ui.zoomLevel.disabled = false;
  ui.loopBtn.disabled = false;
  ui.loopFit.disabled = false;
  ui.play.disabled = false;
};

/**
 * Apply saved UI/render state. Called on startup and project import.
 *
 * `source` decides who wins when they disagree:
 * - `project`: a project the user just opened — its settings are authoritative
 *   and become the local defaults for the next refresh.
 * - `default`: the bundled demo, which is re-applied on every load. Local
 *   preferences (localStorage) win so refreshing does not undo the user's setup.
 */
const applyProjectSettings = (settings: ProjectSettings, source: 'project' | 'default' = 'project'): void => {
  const local = source === 'default' ? readStoredRender() : {};
  const keepLocalUi = source === 'default';

  volumetrics = local.volumetrics ?? settings.render.volumetrics;
  bloomOn = local.bloom ?? settings.render.bloom;
  shadowsOn = local.shadows ?? settings.render.shadows;
  lofi = local.lofi ?? settings.render.lofi;
  strobesOn = local.strobes ?? settings.render.strobes;
  post.setBloom(bloomOn);
  post.setLofi(lofi);
  applyShadows();

  const requested = (local.activeFixtureCount ?? settings.render.activeFixtureCount) > 0
    ? Math.min(local.activeFixtureCount ?? settings.render.activeFixtureCount, show.fixtures.length)
    : show.fixtures.length;
  setActiveCount(requested);
  const presetIndex = counts.indexOf(requested);
  countIndex = presetIndex >= 0 ? presetIndex : counts.length - 1;
  stage.setView(local.cameraView ?? settings.render.cameraView, true);

  volume = settings.playback.volume;
  muted = settings.playback.muted;
  applyVolume();
  followPlayhead = settings.playback.followPlayhead;
  ui.follow.classList.toggle('on', followPlayhead);
  ui.follow.setAttribute('aria-pressed', String(followPlayhead));

  // Local panel/dock prefs survive the demo load; a freshly opened project wins.
  if (!keepLocalUi) {
    setStatsVisible(settings.ui.statsVisible);
    dockCollapsed = settings.ui.dockCollapsed;
    dockHeightPx = settings.ui.dockHeightPx;
    localStorage.setItem(DOCK_COLLAPSED_KEY, dockCollapsed ? 'on' : 'off');
    localStorage.setItem(DOCK_HEIGHT_KEY, String(Math.round(dockHeightPx)));
    applyDock();
    waveHeightPx = Math.max(40, Math.min(200, settings.ui.waveformHeightPx));
    localStorage.setItem(WAVE_HEIGHT_KEY, String(Math.round(waveHeightPx)));
    applyWaveHeight();
  }

  if (currentTimeline !== null) setZoom(settings.playback.zoomPixelsPerSecond);
  syncButtons();
};

/** Load a project into the running app. The rig is fixed for the spike. */
const applyProject = (project: ProjectFile, source: 'project' | 'default' = 'project'): void => {
  projectName = project.name;
  projectDescription = project.description;
  projectAudio = project.audio;
  ui.projectStatus.title = project.description ?? '';
  const timeline = cueTimelineFromProject(project);
  currentTimeline = timeline;
  loopRegion = {
    startSec: project.timeline.loop.startSec,
    endSec: project.timeline.loop.endSec,
  };

  ui.transportTrack.textContent = describeAudio(project.audio, timeline.bpm);
  arrangement.setTimeline(timeline);
  applyProjectFixtureSetup(project, show.fixtures);
  arrangement.setCues(project.arrangement.clips.map(projectClipToCue));
  clock.setLoopEnabled(project.settings.playback.loopEnabled);
  applyProjectSettings(project.settings, source);
  applyLoop();
  clock.seek(loopRegion.startSec);
  ui.transportTime.textContent = `${formatClock(loopRegion.startSec)} / ${formatClock(clock.duration)}`;
  ui.arrangementScroll.scrollLeft = Math.max(0, loopRegion.startSec * arrangement.zoomLevel);
  enableTimelineControls();
};

const buildProject = (): ProjectFile | null => {
  const timeline = currentTimeline;
  if (timeline === null) return null;
  return {
    format: 'dmxsim-project',
    version: 1,
    name: projectName,
    ...(projectDescription === undefined ? {} : { description: projectDescription }),
    show: {
      version: 1,
      name: show.name,
      fixtures: show.fixtures,
      tracks: [],
    },
    timeline: {
      durationSec: timeline.durationSec,
      beatGrid: {
        bpm: timeline.bpm,
        offsetSec: timeline.firstBeatSec,
        beatsPerBar: timeline.beatsPerBar,
      },
      loop: { startSec: loopRegion.startSec, endSec: loopRegion.endSec },
    },
    arrangement: {
      clips: cues.map(cueToProjectClip),
    },
    settings: {
      render: {
        volumetrics,
        bloom: bloomOn,
        shadows: shadowsOn,
        lofi,
        strobes: strobesOn,
        activeFixtureCount: activeCount,
        cameraView: stage.view,
      },
      playback: {
        volume,
        muted,
        loopEnabled: clock.loopEnabled,
        followPlayhead,
        zoomPixelsPerSecond: arrangement.zoomLevel,
      },
      ui: {
        statsVisible,
        dockCollapsed,
        dockHeightPx,
        waveformHeightPx: waveHeightPx,
      },
    },
    audio: projectAudio,
  };
};

const saveProject = (): void => {
  const project = buildProject();
  if (project === null) {
    setProjectStatus('Load audio before saving a project');
    return;
  }
  downloadProject(project);
  setProjectStatus(`Saved ${projectFileName(project.name)} · ${project.arrangement.clips.length} clips`);
};

const openProject = async (file: File): Promise<void> => {
  ui.projectOpen.disabled = true;
  setProjectStatus(`Opening ${file.name}…`);
  try {
    const project = await readProjectFile(file);
    if (currentTimeline === null || clock.duration <= 0) {
      setProjectStatus('Load audio before opening a project');
      return;
    }
    if (!rigMatches(project, show.fixtures)) {
      setProjectStatus(
        `Cannot open ${file.name}: its rig (${fixtureIds(project).length} fixtures) does not match this build`,
      );
      return;
    }
    applyProject(project);
    // `project.name` comes from the opened file's own `name` field, so the
    // status always describes the project the user actually loaded.
    setProjectStatus(`Opened ${project.name} · ${project.arrangement.clips.length} clips · ${file.name}`);
  } catch (error) {
    console.error(`could not open project "${file.name}"`, error);
    setProjectStatus(error instanceof Error ? `Could not open ${file.name}: ${error.message}` : `Could not open ${file.name}`);
  } finally {
    ui.projectOpen.disabled = false;
  }
};

ui.projectSave.addEventListener('click', saveProject);
ui.projectOpen.addEventListener('click', () => ui.projectFile.click());
ui.projectFile.addEventListener('change', () => {
  const file = ui.projectFile.files?.[0];
  ui.projectFile.value = '';
  if (file !== undefined) void openProject(file);
});

ui.loading.textContent = 'loading audio…';

try {
  const response = await fetch(TRACK_URL);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const buffer = await clock.decode(await response.arrayBuffer());
  clock.load(buffer);
  waveform.setPeaks(computePeaks(buffer, 1600));
  // The track line already names the song; a generic "Ready" here was noise.
  ui.audioStatus.textContent = '';

  if (bundledProject !== null) {
    applyProject(bundledProject, 'default');
    setProjectStatus(`Bundled demo: ${bundledProject.name} · ${bundledProject.arrangement.clips.length} clips`);
  } else {
    clock.setLoop({ startSec: loopStartSec, endSec: loopEndSec }, true);
    clock.seek(loopStartSec);
    ui.transportTrack.textContent = `${TRACK.title} — ${TRACK.artist} · ${TRACK.bpm} BPM`;
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
    waveform.setTimeline({
      durationSec: buffer.duration,
      loopStartSec,
      loopEndSec,
      firstBeatSec: TRACK.firstBeatSec,
      bpm: TRACK.bpm,
      beatsPerBar: TRACK.beatsPerBar,
    });
    arrangement.setTimeline(timeline);
    enableTimelineControls();
    setZoom(PIXELS_PER_SECOND);
    applyLoop();
    arrangement.setCues(createDemoCues(show.fixtures, timeline));
    ui.arrangementScroll.scrollLeft = Math.max(0, loopStartSec * PIXELS_PER_SECOND);
    ui.transportTime.textContent = `${formatClock(loopStartSec)} / ${formatClock(buffer.duration)}`;
  }
} catch (error) {
  console.error(error);
  ui.audioStatus.textContent = `Could not load default track: ${TRACK.title}`;
}

ui.loading.hidden = true;
syncButtons();
requestAnimationFrame(frame);
