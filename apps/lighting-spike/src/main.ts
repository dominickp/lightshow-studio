import * as THREE from 'three/webgpu';
import {
  CLUB_STAGE,
  DEFAULT_LASER_SETUP,
  DEFAULT_VENUE_ID,
  defaultLedLook,
  evaluateFixture,
  findAnchor,
  ledSurfaceFromFeature,
  nextFixtureId,
  readProjectBundle,
  resolveMount,
  timeToBeat,
  venueById,
  type FixtureDefaults,
  type FixturePlacement,
  type FixtureState,
  type LaserPattern,
  type LedMediaRef,
  type LaserSetup,
  type LedLookState,
  type LedSurface,
  type ProjectBundle,
  type ProjectFile,
  type ProjectMediaFile,
  type ProjectSettings,
} from '@dmxsim/show-model';
import type { LedPlaybackLayer } from './led/led-wall';
import {
  BUNDLED_MEDIA,
  LedMediaLibrary,
  mediaPoster,
  mediaRef,
  type LedMediaAsset,
} from './led/media';
import {
  LOOK_DEFINITIONS,
  PALETTE_PRESETS,
  lookDefinition,
} from './led/look-definitions';
import { PROFILE_LIBRARY } from '@dmxsim/fixtures';
import {
  BENCH_SCENARIO,
  BenchmarkRecorder,
  buildBenchCues,
  buildBenchSurfaceCues,
  machineInfo,
  rigSignature,
  type BenchmarkOptions,
  type BenchmarkResult,
  type MachineInfo,
} from './app/benchmark';
import { createDemoRig } from './demo-rig';
import { createDemoCues, createDemoSurfaceCues } from './demo-arrangement';
import { AudioClock } from './audio-clock';
import { CryoJetAudio } from './cryo-jet-audio';
import cryoJetSfxUrl from './assets/cryo-jet.ogg?url';
import { loopEndSec, loopStartSec, TRACK, TRACK_URL } from './track';
import { computePeaks, WaveformStrip } from './waveform';
import demoProjectUrl from '../../../resources/sample_projects/koto-chill/koto-chill.dmxsim?url';
import {
  applyProjectFixtureSetup,
  cueTimelineFromProject,
  projectClipToCue,
  projectSurfaceClipToCue,
  rigMatches,
  showFromProject,
  surfacesFromProject,
} from './project-file';
import {
  Arrangement,
  CUE_COLORS,
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  PIXELS_PER_SECOND,
  TRACK_LABEL_WIDTH,
  type Cue,
  type CueColorOverride,
  type CueTimeline,
  type TimelineMode,
  createRuler,
} from './arrangement';
import { kelvinToCss, kelvinToRgb } from './kelvin';
import { clamp } from './lib/math';
import { PerfMonitor } from './app/perf';
import { buildProjectFile } from './project/build';
import { embedProjectMedia } from './project/media';
import { openProject as openProjectFile, saveProject as saveProjectFile } from './project/session';
import {
  STORAGE_KEYS,
  readNumberPreference,
  readPreference,
  writePreference,
} from './ui/preferences';
import { Stage } from './stage';
import { Post } from './post';

/**
 * The demo is a project bundle, not generated code: the app loads
 * `resources/sample_projects/koto-chill/koto-chill.dmxsim` at startup so the
 * show (and its audio) can be replaced as a single file. The procedural
 * rig/cues remain as a fallback if the bundle is missing or invalid.
 */
const loadBundledProject = async (): Promise<ProjectBundle | null> => {
  try {
    const response = await fetch(demoProjectUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await readProjectBundle(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    console.warn('could not load the bundled project; using the generated demo rig', error);
    return null;
  }
};

const bundledBundle = await loadBundledProject();
const bundledProject = bundledBundle?.project ?? null;
const show = bundledProject === null
  ? createDemoRig(loopStartSec, TRACK.bpm)
  : showFromProject(bundledProject);
let projectName = bundledProject?.name ?? 'Untitled project';
let projectDescription = bundledProject?.description;
/**
 * Active venue template. Resolved from the project file so opening a project
 * renders the stage it was authored on. Unknown ids fall back to the club
 * stage with a warning rather than failing the load; a real venue switch UI is
 * still to come (see `stage-rig-editor-plan.md`).
 */
const requestedVenueId = bundledProject?.venue.id ?? DEFAULT_VENUE_ID;
const activeVenue = venueById(requestedVenueId) ?? CLUB_STAGE;
if (activeVenue.id !== requestedVenueId) {
  console.warn(`unknown venue "${requestedVenueId}"; using ${activeVenue.id}`);
}
/**
 * Walls owned by the current project. Empty `surfaces` in a file falls back to
 * the venue's declared wall, so older projects still show one.
 */
const venueSurfaces = (venue: typeof activeVenue): LedSurface[] =>
  venue.features.ledWall === undefined ? [] : [ledSurfaceFromFeature(venue.features.ledWall)];
let surfaces: LedSurface[] = venueSurfaces(activeVenue);

let projectAudio: ProjectFile['audio'] = bundledProject?.audio ?? {
  source: 'bundled',
  id: 'koto-chill',
  title: TRACK.title,
  artist: TRACK.artist,
  fileName: 'The Koto Chill.ogg',
};
/**
 * Bytes of the loaded track, so Save can embed it. `null` means the audio is
 * app-shipped (`bundled:`) and stays a reference.
 */
let projectAudioFile: ProjectMediaFile | null = null;
/** Digest of the embedded track currently in the clock, to skip re-decoding it. */
let loadedAudioSha: string | null = null;
/**
 * Fixture-count stops for the debug render budget. The rig is editable now, so
 * the list is derived from the current rig and always ends at "all fixtures".
 */
const countPresets = (): number[] => {
  const total = show.fixtures.length;
  const stops = [10, 16, 22, 26, 32].filter((n) => n < total);
  stops.push(total);
  return stops;
};
const counts = countPresets();

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

const stage = new Stage(renderer.domElement, show, activeVenue);
const media = new LedMediaLibrary();
// Wall media that shipped inside the demo bundle must exist before the stage
// builds its materials from the project's looks.
if (bundledBundle !== null) media.addEmbedded(bundledBundle.media);
stage.setLedMediaRuntime(media);
// A local upload restored from IndexedDB is only usable once its texture
// exists, so rebuild the media materials when the library reports it.
media.onChange(() => stage.refreshLedMedia());
stage.setLedSurfaces(surfaces);
// TEMP DEBUG
(window as unknown as { __stage: Stage }).__stage = stage;
// The renderer draws into #stage-viewport (window minus the timeline dock), not
// the whole window, so the initial projection must use the viewport's aspect.
stage.camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
stage.camera.updateProjectionMatrix();
const post = new Post(renderer, stage.scene, stage.camera);
const clock = new AudioClock();
const cryoAudio = new CryoJetAudio(clock);
void cryoAudio.load(cryoJetSfxUrl);
clock.setLoop({ startSec: loopStartSec, endSec: loopEndSec }, true);

let volumetrics = true;
let bloomOn = true;
let shadowsOn = true;
let strobesOn = true;
let countIndex = counts.length - 1;
let activeCount = counts[countIndex] ?? show.fixtures.length;

/** Keep the render budget valid after a rig edit. */
const clampActiveCount = (): void => {
  const presets = countPresets();
  countIndex = Math.min(countIndex, presets.length - 1);
  const next = presets[countIndex] ?? show.fixtures.length;
  if (next !== activeCount) setActiveCount(next);
  else syncButtons();
};

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
  strobe: element<HTMLButtonElement>('btn-strobe'),
  strobeStatus: element('strobe-status'),
  haze: element<HTMLInputElement>('haze'),
  hazeValue: element('haze-value'),
  view: element<HTMLButtonElement>('btn-view'),
  orbit: element<HTMLButtonElement>('btn-orbit'),
  orbitPill: element<HTMLElement>('orbit-pill'),
  orbitPillLabel: element('orbit-pill-label'),
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
    cueLookField: element('cue-look-field'),
    lookEdit: element<HTMLButtonElement>('btn-look-edit'),
    lookEditor: element<HTMLElement>('look-editor'),
    lookGlyph: element('le-glyph'),
    lookTitle: element('le-title'),
    lookGrid: element('le-grid'),
    lookControls: element('le-controls'),
    lookChooseGrid: element<HTMLElement>('le-choose-grid'),
    lookUploadGrid: element<HTMLElement>('le-upload-grid'),
    lookUploadEmpty: element<HTMLElement>('le-upload-empty'),
    lookMediaFooter: element<HTMLElement>('le-media-footer'),
    lookMediaCurrent: element<HTMLElement>('le-media-current'),
    lookMediaFit: element<HTMLSelectElement>('le-media-fit'),
    lookMediaRemove: element<HTMLButtonElement>('le-media-remove'),
    lookUpload: element<HTMLButtonElement>('le-upload'),
    lookFile: element<HTMLInputElement>('le-file'),
    lookPresets: element('le-presets'),
    lookClose: element<HTMLButtonElement>('le-close'),
    lookTabLook: element<HTMLButtonElement>('le-tab-look'),
    lookTabChoose: element<HTMLButtonElement>('le-tab-choose'),
    lookTabUpload: element<HTMLButtonElement>('le-tab-upload'),
    lookPanelLook: element<HTMLElement>('le-panel-look'),
    lookPanelChoose: element<HTMLElement>('le-panel-choose'),
    lookPanelUpload: element<HTMLElement>('le-panel-upload'),
    surfacePane: element('surface-pane'),
    surfaceSummary: element('surface-summary'),
    surfaceWidth: element<HTMLInputElement>('surface-width'),
    surfaceWidthValue: element('surface-width-value'),
    surfaceHeight: element<HTMLInputElement>('surface-height'),
    surfaceHeightValue: element('surface-height-value'),
    surfacePitch: element<HTMLInputElement>('surface-pitch'),
    surfacePitchValue: element('surface-pitch-value'),
    surfaceGap: element<HTMLInputElement>('surface-gap'),
    surfaceGapValue: element('surface-gap-value'),
    surfaceBrightness: element<HTMLInputElement>('surface-brightness'),
    surfaceBrightnessValue: element('surface-brightness-value'),
    surfaceBlack: element<HTMLInputElement>('surface-black'),
    surfaceBlackValue: element('surface-black-value'),
    surfaceGamma: element<HTMLInputElement>('surface-gamma'),
    surfaceGammaValue: element('surface-gamma-value'),
    surfaceEmit: element<HTMLInputElement>('surface-emit'),
    surfaceEmitValue: element('surface-emit-value'),
    panelSurfaceCount: element('panel-surface-count'),
    panelSurfaceActive: element('panel-surface-active'),
  waveform: element<HTMLCanvasElement>('waveform'),
  waveformPlayhead: element('waveform-playhead'),
  waveformHover: element('waveform-hover'),
  tooltip: element('timeline-tooltip'),
  arrangement: element('arrangement-rows'),
  arrangementScroll: element('arrangement-scroll'),
  ruler: element<HTMLCanvasElement>('timeline-ruler'),
  cueAction: element<HTMLSelectElement>('cue-action'),
  cueColorField: element('cue-color-field'),
  cueColor: element('cue-color'),
  cueDelete: element<HTMLButtonElement>('btn-cue-delete'),
  colorPicker: element<HTMLElement>('color-picker'),
  colorPalette: element<HTMLElement>('cp-palette'),
  colorPickerClose: element<HTMLButtonElement>('cp-close'),
  colorPreview: element('cp-preview'),
  colorInput: element<HTMLInputElement>('cp-color'),
  hueGrid: element<HTMLElement>('cp-hue-grid'),
  trackFilter: element<HTMLSelectElement>('track-filter'),
  hideUnfiltered: element<HTMLButtonElement>('btn-hide-unfiltered'),
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
  modeDrop: element<HTMLButtonElement>('btn-mode-drop'),
  modeSelect: element<HTMLButtonElement>('btn-mode-select'),
  cueCopy: element<HTMLButtonElement>('btn-cue-copy'),
  cuePaste: element<HTMLButtonElement>('btn-cue-paste'),
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
  setupName: element<HTMLInputElement>('setup-name'),
  setupMount: element<HTMLSelectElement>('setup-mount'),
  setupPositionRow: element('setup-position-row'),
  setupPosition: element<HTMLInputElement>('setup-position'),
  setupPositionValue: element('setup-position-value'),
  setupLaserGroup: element('setup-laser-group'),
  setupLaserPattern: element<HTMLSelectElement>('setup-laser-pattern'),
  setupLaserBeams: element<HTMLInputElement>('setup-laser-beams'),
  setupLaserBeamsValue: element('setup-laser-beams-value'),
  setupLaserFan: element<HTMLInputElement>('setup-laser-fan'),
  setupLaserFanValue: element('setup-laser-fan-value'),
  rigList: element('rig-list'),
  rigPane: element('rig-pane'),
  fixturePane: element('fixture-pane'),
  rigMenu: element<HTMLButtonElement>('btn-rig-menu'),
  rigMenuCount: element('rig-menu-count'),
  addLights: element<HTMLButtonElement>('btn-add-lights'),
  removeFixture: element<HTMLButtonElement>('btn-remove-fixture'),
  addDialog: element<HTMLDialogElement>('add-lights-dialog'),
  addProfile: element<HTMLSelectElement>('add-profile'),
  addMount: element<HTMLSelectElement>('add-mount'),
  addCount: element<HTMLInputElement>('add-count'),
  addSpacing: element<HTMLSelectElement>('add-spacing'),
  addSummary: element('add-summary'),
};

/**
 * The side panel shows one thing at a time: the rig (opened from the timeline's
 * RIG row) or a single fixture's settings (opened from its track name).
 */
type SidePanelMode = 'rig' | 'fixture' | 'surface';
let sidePanelMode: SidePanelMode = 'fixture';
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

/** Laser setup lives on the placement; seed it from the profile defaults. */
const laserSetupFor = (fixture: Fixture): LaserSetup => {
  fixture.laser ??= { ...DEFAULT_LASER_SETUP };
  return fixture.laser;
};

const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
ui.backend.textContent = backend;

const waveform = new WaveformStrip(ui.waveform, (songSec) => clock.seek(songSec));
let cues: readonly Cue[] = [];
// Assigned after the closure below captures it.
// eslint-disable-next-line prefer-const
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
  if (fixture.profile.kind === 'cryo-jet') return ['CO2 jet', 'Spray level'];
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

/**
 * Panel header text. In rig mode the header describes the venue, so the pane
 * does not read as if a fixture were selected.
 */
const syncPanelHeader = (fixture: Fixture | null, surface: LedSurface | null = null): void => {
  if (sidePanelMode === 'surface' && surface !== null) {
    ui.panelFixtureKind.textContent = 'LED wall';
    ui.panelFixtureName.textContent = surface.name;
    ui.panelFixtureMeta.textContent =
      `${surface.widthM.toFixed(1)} × ${surface.heightM.toFixed(1)} m · P${surface.pitchMm.toFixed(1)}`;
    return;
  }
  if (sidePanelMode === 'rig') {
    ui.panelFixtureKind.textContent = 'Venue';
    ui.panelFixtureName.textContent = activeVenue.name;
    ui.panelFixtureMeta.textContent = `${show.fixtures.length} light${show.fixtures.length === 1 ? '' : 's'} · click one to edit it`;
    return;
  }

  ui.panelFixtureKind.textContent = fixture === null ? 'Fixture' : kindLabel(fixture.profile.kind);
  ui.panelFixtureName.textContent = fixture === null
    ? 'No fixture selected'
    : arrangement.labelFor(fixture);
  ui.panelFixtureMeta.textContent = fixture === null
    ? 'Click a track name to open this panel'
    : `${mountLabel(fixture)} · ${fixture.profile.channels.length} DMX channels`;
};

const syncCueInspector = (
  fixture: (typeof show.fixtures)[number] | null,
  cues: readonly Cue[],
  surface: LedSurface | null = null,
): void => {
  const cue = cues[0] ?? null;
  const count = cues.length;
  const isSurface = surface !== null || cue?.surfaceId !== undefined;
  const label = surface !== null
    ? surface.name
    : fixture === null
      ? null
      : arrangement.labelFor(fixture);
  ui.selectedFixture.textContent = count > 1
    ? `${count} clips selected`
    : label ?? 'None selected';
  ui.selectedFixture.classList.toggle('empty', count === 0);
  syncPanelHeader(fixture, surface);
  renderPanelCapabilities(fixture);
  if (sidePanelOpen) sidePanelFixtureId = (fixture ?? surface)?.id ?? null;

  // Mount options are venue data, so rebuild them with the current selection.
  const mountOptions = activeVenue.anchors.map((anchor) => {
    const option = document.createElement('option');
    option.value = anchor.id;
    option.textContent = anchor.name;
    return option;
  });
  ui.setupMount.replaceChildren(...mountOptions);

  if (isSurface) {
    ui.setupDimmer.disabled = true;
    ui.setupYaw.disabled = true;
    ui.setupPitch.disabled = true;
    ui.setupSpread.disabled = true;
    ui.setupSpreadRow.hidden = true;
    ui.setupLaserGroup.hidden = true;
    ui.setupName.disabled = true;
    ui.setupName.value = '';
    ui.setupMount.disabled = true;
    ui.setupPositionRow.hidden = true;
    ui.setupPosition.disabled = true;
    ui.removeFixture.disabled = true;
    ui.setupMount.selectedIndex = -1;
  } else if (fixture === null) {
    ui.setupDimmer.disabled = true;
    ui.setupYaw.disabled = true;
    ui.setupPitch.disabled = true;
    ui.setupSpread.disabled = true;
    ui.setupSpreadRow.hidden = true;
    ui.setupLaserGroup.hidden = true;
    ui.setupName.disabled = true;
    ui.setupName.value = '';
    ui.setupMount.disabled = true;
    ui.setupPositionRow.hidden = true;
    ui.setupPosition.disabled = true;
    ui.removeFixture.disabled = true;
  } else {
    ui.setupName.disabled = false;
    ui.setupName.value = fixture.name ?? '';
    ui.setupName.placeholder = fixture.id;
    ui.setupMount.disabled = false;
    const mounted = fixture.mount !== undefined
      && findAnchor(activeVenue, fixture.mount.anchorId) !== undefined;
    if (mounted && fixture.mount !== undefined) {
      ui.setupMount.value = fixture.mount.anchorId;
    } else {
      // Unattached (for example a v1 file): show the placeholder selection.
      ui.setupMount.selectedIndex = -1;
    }
    const u = fixture.mount?.u ?? 0.5;
    ui.setupPositionRow.hidden = !mounted;
    ui.setupPosition.disabled = !mounted;
    ui.setupPosition.value = String(Math.round(u * 100));
    ui.setupPositionValue.textContent = `${Math.round(u * 100)}%`;
    ui.removeFixture.disabled = show.fixtures.length <= 1;
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

    const isLaser = fixture.profile.kind === 'laser';
    ui.setupLaserGroup.hidden = !isLaser;
    if (isLaser) {
      const limits = fixture.profile.laser;
      const setup = { ...DEFAULT_LASER_SETUP, ...fixture.laser };
      const patterns = limits?.patterns ?? [DEFAULT_LASER_SETUP.pattern];
      ui.setupLaserPattern.replaceChildren(...patterns.map((pattern) => {
        const option = document.createElement('option');
        option.value = pattern;
        option.textContent = kindLabel(pattern);
        return option;
      }));
      ui.setupLaserPattern.value = setup.pattern;
      ui.setupLaserPattern.disabled = false;

      const maxBeams = Math.max(1, Math.round(limits?.maxBeams ?? setup.beams));
      ui.setupLaserBeams.disabled = false;
      ui.setupLaserBeams.max = String(maxBeams);
      const beams = clamp(Math.round(setup.beams), 1, maxBeams);
      ui.setupLaserBeams.value = String(beams);
      ui.setupLaserBeamsValue.textContent = String(beams);

      const [fanMin, fanMax] = limits?.fanDeg ?? [0, 120];
      ui.setupLaserFan.disabled = false;
      ui.setupLaserFan.min = String(fanMin);
      ui.setupLaserFan.max = String(fanMax);
      const fanDeg = clamp(setup.fanDeg, fanMin, fanMax);
      ui.setupLaserFan.value = String(Math.round(fanDeg));
      ui.setupLaserFanValue.textContent = `${Math.round(fanDeg)}°`;
    }
  }
  refreshPanelClipStats();
  renderRigList();

  // Surface clips speak "look", not "action/colour". The look itself is the
  // editor entry point; the color/palette controls remain inside the popover.
  const surfaceLook = isSurface ? cue?.look ?? arrangement.suggestedLook : null;
  (ui.cueAction.parentElement as HTMLElement).hidden = isSurface;
  ui.cueLookField.hidden = !isSurface;
  ui.lookEdit.hidden = !isSurface;
  if (surfaceLook !== null) {
    const definition = lookDefinition(surfaceLook.kind);
    ui.lookEdit.textContent = `${definition.glyph} ${definition.label} ▾`;
    ui.lookEdit.title = `${definition.hint} · Click to edit`;
  }

  const available = arrangement.selectedActions;
  ui.cueAction.replaceChildren(...available.map((action) => {
    const option = document.createElement('option');
    option.value = action;
    option.textContent = action[0]!.toUpperCase() + action.slice(1);
    return option;
  }));
  // A multi-selection with different actions shows "Mixed"; picking an action
  // then applies it to every selected clip the fixture supports.
  const actions = new Set(cues.map((item) => item.action));
  const mixed = actions.size > 1;
  if (mixed) {
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Mixed';
    placeholder.disabled = true;
    ui.cueAction.prepend(placeholder);
  }
  ui.cueAction.disabled = fixture === null;
  ui.cueAction.value = mixed ? '' : cue?.action ?? arrangement.suggestedAction;
  const colorEnabled = !isSurface && fixture !== null && Boolean(fixture.profile.capabilities.color);
  // Do not show a disabled colour picker for fixtures that cannot mix colour.
  ui.cueColorField.hidden = !colorEnabled;
  if (!colorEnabled) closeColorPicker();
  const override = cue?.colorOverride ?? (cue === null ? arrangement.suggestedColorOverride ?? undefined : undefined);
  syncColorSwatches(cue?.colorIndex ?? arrangement.suggestedColorIndex, override, colorEnabled);
  ui.cueDelete.disabled = count === 0;
  ui.cueDelete.hidden = count === 0;
  ui.cueDelete.textContent = count > 1 ? `Delete ${count} clips` : 'Delete clip';
  ui.cueCopy.disabled = count === 0;
  ui.cuePaste.disabled = !arrangement.canPaste;
  syncActiveFixture();
};

/**
 * The 3D marker and the timeline row highlight only appear while the fixture
 * settings are open in the side panel. The rig pane and a closed panel clear
 * both, while selection for editing is left untouched.
 */
const syncActiveFixture = (): void => {
  const activeId = sidePanelOpen && sidePanelMode === 'fixture'
    ? sidePanelFixtureId
    : null;
  stage.setSelectedFixture(activeId);
  arrangement.setActiveFixture(activeId);
};

/**
 * The bar keeps only the current color swatch plus the picker button; the
 * palette and recent colors live inside the popover, so the bar stays one row
 * no matter how many colors the user collects.
 */
const currentSwatch = document.createElement('button');
currentSwatch.type = 'button';
currentSwatch.className = 'color-swatch current';
currentSwatch.style.setProperty('--swatch', CUE_COLORS[0]!.css);
currentSwatch.setAttribute('role', 'radio');
currentSwatch.setAttribute('aria-checked', 'true');
currentSwatch.setAttribute('aria-label', 'Current clip color');
currentSwatch.disabled = true;
currentSwatch.tabIndex = -1;
currentSwatch.title = CUE_COLORS[0]!.name;
const CUSTOM_COLOR_INDEX = CUE_COLORS.length;
const customSwatch = document.createElement('button');
customSwatch.type = 'button';
customSwatch.className = 'color-swatch custom';
customSwatch.dataset.colorIndex = String(CUSTOM_COLOR_INDEX);
customSwatch.title = 'Custom color…';
customSwatch.setAttribute('role', 'radio');
customSwatch.setAttribute('aria-label', 'Custom color');
customSwatch.setAttribute('aria-checked', 'false');
customSwatch.setAttribute('aria-haspopup', 'dialog');
customSwatch.disabled = true;
customSwatch.tabIndex = -1;

/** CSS for an override, used by the swatch, preview and hex field. */
const toHexByte = (value: number): string =>
  Math.round(value * 255).toString(16).padStart(2, '0');
const colorOverrideCss = (override: CueColorOverride): string => {
  if (override.kind === 'white') return kelvinToCss(override.cct);
  return `#${toHexByte(override.r)}${toHexByte(override.g)}${toHexByte(override.b)}`;
};

/**
 * Recent colors learned from custom picks, shown as a row inside the picker
 * popover (most recent first) so frequent custom colors become one click.
 * Persisted per browser.
 */
const USER_COLORS_KEY = STORAGE_KEYS.userColors;
const USER_COLORS_MAX = 7;
const sameColor = (a: CueColorOverride, b: CueColorOverride): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
const loadUserColors = (): CueColorOverride[] => {
  try {
    const raw = readPreference(USER_COLORS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is CueColorOverride => {
      if (typeof item !== 'object' || item === null) return false;
      const c = item as Record<string, unknown>;
      return (c.kind === 'rgb' && ['r', 'g', 'b'].every((k) => typeof c[k] === 'number'))
        || (c.kind === 'white' && typeof c.cct === 'number');
    }).slice(0, USER_COLORS_MAX);
  } catch {
    return [];
  }
};
let userColors: CueColorOverride[] = loadUserColors();
const paletteSwatches: HTMLButtonElement[] = CUE_COLORS.map((color, index) => {
  const swatch = document.createElement('button');
  swatch.type = 'button';
  swatch.className = 'color-swatch';
  swatch.dataset.colorIndex = String(index);
  swatch.style.setProperty('--swatch', color.css);
  swatch.title = color.name[0]!.toUpperCase() + color.name.slice(1);
  swatch.setAttribute('role', 'radio');
  swatch.setAttribute('aria-label', `${swatch.title} color`);
  swatch.setAttribute('aria-checked', 'false');
  swatch.tabIndex = -1;
  return swatch;
});
ui.cueColor.replaceChildren(currentSwatch, customSwatch);
const userSwatches: HTMLButtonElement[] = [];
const renderUserSwatches = (): void => {
  userSwatches.length = 0;
  for (const [index, override] of userColors.entries()) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'color-swatch user';
    swatch.dataset.userIndex = String(index);
    swatch.style.setProperty('--swatch', colorOverrideCss(override));
    swatch.title = override.kind === 'white'
      ? `White · ${Math.round(override.cct)} K`
      : colorOverrideCss(override).toUpperCase();
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', `Recent color ${index + 1}: ${swatch.title}`);
    swatch.setAttribute('aria-checked', 'false');
    swatch.tabIndex = -1;
    userSwatches.push(swatch);
  }
  ui.colorPalette.replaceChildren(...paletteSwatches, ...userSwatches);
};
renderUserSwatches();
const rememberUserColor = (override: CueColorOverride): void => {
  userColors = [override, ...userColors.filter((c) => !sameColor(c, override))].slice(0, USER_COLORS_MAX);
  writePreference(USER_COLORS_KEY, JSON.stringify(userColors));
  renderUserSwatches();
};

/** Which color the bar's current swatch reflects, with its label. */
type CurrentColor = { override?: CueColorOverride; colorIndex: number; label: string };
let currentColor: CurrentColor = { colorIndex: 0, label: CUE_COLORS[0]!.name };

/** Reflect the selected color on the bar's current swatch and the picker. */
function syncColorSwatches(
  selectedIndex: number,
  override: CueColorOverride | undefined,
  enabled: boolean,
): void {
  ui.cueColor.dataset.disabled = String(!enabled);
  const selected = Math.min(Math.max(0, selectedIndex), CUE_COLORS.length - 1);
  const userIndex = override === undefined ? -1 : userColors.findIndex((c) => sameColor(c, override));
  for (const [index, swatch] of paletteSwatches.entries()) {
    const isSelected = override === undefined && index === selected;
    swatch.classList.toggle('selected', isSelected);
    swatch.setAttribute('aria-checked', String(isSelected));
  }
  for (const [index, swatch] of userSwatches.entries()) {
    const isSelected = index === userIndex;
    swatch.classList.toggle('selected', isSelected);
    swatch.setAttribute('aria-checked', String(isSelected));
  }
  const customSelected = override !== undefined && userIndex === -1;
  customSwatch.classList.toggle('selected', customSelected);
  customSwatch.setAttribute('aria-checked', String(customSelected));
  if (override === undefined || userIndex !== -1) {
    customSwatch.removeAttribute('data-has-custom');
    customSwatch.removeAttribute('style');
    customSwatch.title = 'Custom color…';
  } else {
    const css = colorOverrideCss(override);
    customSwatch.dataset.hasCustom = 'true';
    customSwatch.style.setProperty('--swatch', css);
    customSwatch.title = override.kind === 'white'
      ? `Custom white · ${Math.round(override.cct)} K`
      : `Custom color · ${css.toUpperCase()}`;
  }
  // The bar's current swatch always mirrors what a new/selected clip uses.
  currentColor = override === undefined
    ? { colorIndex: selected, label: CUE_COLORS[selected]!.name }
    : { override, colorIndex: CUSTOM_COLOR_INDEX, label: customSwatch.title };
  const [cr, cg, cb] = override === undefined
    ? CUE_COLORS[selected]!.rgb
    : override.kind === 'rgb'
      ? [override.r, override.g, override.b]
      : kelvinToRgb(override.cct);
  currentSwatch.style.setProperty('--swatch', `#${toHexByte(cr)}${toHexByte(cg)}${toHexByte(cb)}`);
  currentSwatch.title = currentColor.label;
  currentSwatch.disabled = !enabled;
  customSwatch.disabled = !enabled;
  currentSwatch.tabIndex = enabled ? 0 : -1;
  customSwatch.tabIndex = enabled ? 0 : -1;
  if (!ui.colorPicker.hidden) syncColorPicker(override);
}

/** Keep the popover's preview and color input in step with the override. */
function syncColorPicker(override: CueColorOverride | undefined): void {
  const css = override === undefined ? undefined : colorOverrideCss(override);
  ui.colorPreview.style.background = css ?? 'conic-gradient(#ff2f2f, #ff8a18, #16d9cc, #397cff, #8c35ff, #ff3380, #ff2f2f)';
  if (override?.kind === 'rgb') ui.colorInput.value = css!.toUpperCase();
}

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
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues, arrangement.selectedSurface);
}, (fixture, selectedCues, surface) => {
  syncCueInspector(fixture, selectedCues, surface);
}, (fixtureId, hidden) => {
  stage.setFixtureHidden(fixtureId, hidden);
  const wall = surfaces.find((entry) => entry.id === fixtureId);
  if (wall !== undefined) stage.setLedSurfaceVisible(wall.id, !hidden);
}, (fixture, surface) => {
  if (fixture !== null) toggleSidePanel(fixture.id);
  else if (surface !== null) toggleSurfacePanel(surface.id);
}, surfaces);

// --- Timeline modes (drop / select) ---------------------------------------

const TIMELINE_MODE_KEY = STORAGE_KEYS.timelineMode;

const applyTimelineMode = (mode: TimelineMode, persist = true): void => {
  arrangement.setMode(mode);
  const dropMode = mode === 'drop';
  ui.modeDrop.setAttribute('aria-pressed', String(dropMode));
  ui.modeSelect.setAttribute('aria-pressed', String(!dropMode));
  ui.modeDrop.classList.toggle('on', dropMode);
  ui.modeSelect.classList.toggle('on', !dropMode);
  if (!dropMode) ui.arrangementScroll.classList.remove('loop-mode');
  if (persist) writePreference(TIMELINE_MODE_KEY, mode);
};

ui.modeDrop.addEventListener('click', () => applyTimelineMode('drop'));
ui.modeSelect.addEventListener('click', () => applyTimelineMode('select'));
applyTimelineMode(readPreference(TIMELINE_MODE_KEY) === 'select' ? 'select' : 'drop', false);

// --- Rig editing (M3) ------------------------------------------------------

/** Anchor display name, or a clear marker for a fixture with no mount. */
const mountLabel = (fixture: FixturePlacement): string => {
  const anchorId = fixture.mount?.anchorId;
  if (anchorId === undefined) return 'Unattached';
  return findAnchor(activeVenue, anchorId)?.name ?? `Missing mount (${anchorId})`;
};

arrangement.setSubtitleResolver(
  (fixture) => `${mountLabel(fixture)} · ${kindLabel(fixture.profile.kind)}`,
);

/** Plural, user-facing names for the track filter's fixture kinds. */
const TRACK_FILTER_LABELS: Record<string, string> = {
  'led-wall': 'LED walls',
  'moving-head': 'Moving heads',
  wash: 'Washes',
  strobe: 'Strobes',
  laser: 'Lasers',
  par: 'Pars',
  blinder: 'Blinders',
  'led-strip': 'LED strips',
};

/**
 * "Hide others" for the scene. Off by default so filtering tracks never
 * changes what the venue looks like until the user asks for it.
 */
let hideUnfiltered = false;

/**
 * Apply the track filter to both halves of the UI: the lanes in the
 * arrangement, and (when "hide others" is on) the fixtures in the 3D scene.
 */
const applyTrackFilter = (): void => {
  const kind = ui.trackFilter.value;
  const filtering = kind !== '';
  arrangement.setKindFilter(filtering ? kind : null);
  if (!filtering) hideUnfiltered = false;
  const canHide = filtering && (show.fixtures.length > 0 || surfaces.length > 0);
  ui.hideUnfiltered.disabled = !canHide;
  ui.hideUnfiltered.classList.toggle('on', hideUnfiltered);
  ui.hideUnfiltered.setAttribute('aria-pressed', String(hideUnfiltered));
  ui.hideUnfiltered.textContent = hideUnfiltered ? '◉' : '◌';
  ui.hideUnfiltered.title = hideUnfiltered
    ? 'Showing only the filtered fixture type in the 3D viewport'
    : 'Hide fixture types that are filtered out of the 3D viewport';
  stage.setKindFilter(hideUnfiltered && canHide ? kind : null);
  for (const surface of surfaces) {
    stage.setLedSurfaceVisible(surface.id, !hideUnfiltered || kind === 'led-wall');
  }
};

/**
 * Rebuild the track filter from the fixtures currently in the rig, keeping a
 * still-valid choice. The filter only hides lanes; clips are untouched.
 */
const rebuildTrackFilter = (): void => {
  const kinds = [
    ...(surfaces.length > 0 ? ['led-wall'] : []),
    ...new Set<string>(show.fixtures.map((fixture) => fixture.profile.kind)),
  ];
  const previous = ui.trackFilter.value;
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All tracks';
  const kindOptions = kinds.map((kind) => {
    const option = document.createElement('option');
    option.value = kind;
    option.textContent = TRACK_FILTER_LABELS[kind] ?? `${kindLabel(kind)}s`;
    return option;
  });
  ui.trackFilter.replaceChildren(allOption, ...kindOptions);
  const active = kinds.includes(previous) ? previous : '';
  ui.trackFilter.value = active;
  applyTrackFilter();
};

rebuildTrackFilter();
ui.trackFilter.disabled = show.fixtures.length === 0;

/**
 * Apply a rig change. `show.fixtures` is the document's source of truth, so
 * replacing the array and rebuilding is simpler and safer than mutating rig
 * objects in place. `rebuildRigs` is false for placement edits, which the rig
 * reads from the placement every frame.
 */
const applyRig = (fixtures: FixturePlacement[], rebuildRigs: boolean): void => {
  show.fixtures = fixtures;
  if (rebuildRigs) stage.setShow(show);
  arrangement.setFixtures(fixtures);
  rebuildTrackFilter();
  ui.trackFilter.disabled = fixtures.length === 0;
  clampActiveCount();
  renderRigList();
};

/** Fixtures grouped by mount in venue anchor order, then unattached ones. */
const renderRigList = (): void => {
  const selectedId = arrangement.selectedFixture?.id ?? null;
  const groups = new Map<string, FixturePlacement[]>();
  for (const fixture of show.fixtures) {
    const key = mountLabel(fixture);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [fixture]);
    else list.push(fixture);
  }

  const fragment = document.createDocumentFragment();
  for (const [label, fixtures] of groups) {
    const heading = document.createElement('p');
    heading.className = 'rig-group';
    heading.textContent = `${label} · ${fixtures.length}`;
    fragment.append(heading);

    for (const fixture of fixtures) {
      const entry = document.createElement('div');
      entry.className = `rig-entry${fixture.id === selectedId ? ' selected' : ''}`;
      entry.dataset.fixtureId = fixture.id;
      entry.title = `${fixture.name ?? fixture.id} — ${fixture.profile.name}`;
      const name = document.createElement('span');
      name.textContent = fixture.name ?? fixture.id;
      const kind = document.createElement('em');
      kind.textContent = kindLabel(fixture.profile.kind);
      entry.append(name, kind);
      fragment.append(entry);
    }
  }

  ui.rigMenuCount.textContent = String(show.fixtures.length);

  if (show.fixtures.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'sp-empty';
    empty.textContent = 'No fixtures.';
    fragment.append(empty);
  }
  ui.rigList.replaceChildren(fragment);
};

/** Picking a light in the rig list selects its lane and opens its settings. */
const selectFixtureFromRig = (fixtureId: string): void => {
  arrangement.selectFixture(fixtureId);
  sidePanelMode = 'fixture';
  setSidePanelOpen(true, { mode: 'fixture', fixtureId });
  renderRigList();
};

ui.rigList.addEventListener('click', (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const entry = target.closest<HTMLElement>('.rig-entry');
  const fixtureId = entry?.dataset.fixtureId;
  if (fixtureId !== undefined) selectFixtureFromRig(fixtureId);
});

/** Remove a light and its clips. The last fixture cannot be removed. */
const removeFixture = (fixtureId: string): void => {
  const fixture = show.fixtures.find((item) => item.id === fixtureId);
  if (fixture === undefined) return;
  if (show.fixtures.length <= 1) {
    setProjectStatus('A show needs at least one light');
    return;
  }

  const clipCount = cues.filter((cue) => cue.fixtureId === fixtureId).length;
  const label = fixture.name ?? fixture.id;
  const clipNote = clipCount === 0
    ? ''
    : ` and its ${clipCount} clip${clipCount === 1 ? '' : 's'}`;
  if (!window.confirm(`Remove ${label}${clipNote}?`)) return;

  applyRig(show.fixtures.filter((item) => item.id !== fixtureId), true);
  // Removal is a rig-level action, so return to the rig list rather than
  // leaving the panel pointed at a fixture that no longer exists. Keep the
  // panel closed if it already was.
  if (sidePanelOpen) setSidePanelOpen(true, { mode: 'rig' });
  setProjectStatus(`Removed ${label}${clipNote}`);
};

ui.removeFixture.addEventListener('click', () => {
  const fixture = arrangement.selectedFixture;
  if (fixture !== null) removeFixture(fixture.id);
});

/** Evenly spaced positions along an anchor, inset from both ends. */
const spreadPositions = (count: number): number[] => {
  if (count <= 1) return [0.5];
  const inset = 0.06;
  return Array.from({ length: count }, (_, index) =>
    inset + ((1 - inset * 2) * index) / (count - 1));
};

const populateAddDialog = (): void => {
  const profiles = Object.values(PROFILE_LIBRARY).map((profile) => {
    const option = document.createElement('option');
    option.value = profile.id;
    option.textContent = `${profile.name} · ${profile.channels.length}ch`;
    return option;
  });
  ui.addProfile.replaceChildren(...profiles);

  const anchors = activeVenue.anchors.map((anchor) => {
    const option = document.createElement('option');
    option.value = anchor.id;
    option.textContent = anchor.name;
    return option;
  });
  ui.addMount.replaceChildren(...anchors);
};

const describeAddDialog = (): void => {
  const profile = PROFILE_LIBRARY[ui.addProfile.value];
  const anchor = findAnchor(activeVenue, ui.addMount.value);
  const count = Number(ui.addCount.value);
  if (profile === undefined || anchor === undefined) {
    ui.addSummary.textContent = '';
    return;
  }
  const safeCount = Number.isFinite(count) ? Math.max(1, Math.min(16, Math.round(count))) : 1;
  ui.addSummary.textContent = `Adds ${safeCount} × ${profile.name} to ${anchor.name}.`;
};

const addFixtures = (): void => {
  const profile = PROFILE_LIBRARY[ui.addProfile.value];
  const anchor = findAnchor(activeVenue, ui.addMount.value);
  if (profile === undefined || anchor === undefined) return;

  const rawCount = Number(ui.addCount.value);
  const count = Math.max(1, Math.min(16, Number.isFinite(rawCount) ? Math.round(rawCount) : 1));
  const spacing = ui.addSpacing.value === 'cluster' ? 'cluster' : 'spread';
  const positions = spreadPositions(count);
  const next = [...show.fixtures];
  const created: FixturePlacement[] = [];
  const kindTitle = kindLabel(profile.kind);

  for (let index = 0; index < count; index += 1) {
    const u = spacing === 'spread' ? (positions[index] ?? 0.5) : 0.5;
    const id = nextFixtureId(next, profile.kind);
    const hang = anchor.mountOffset ?? { x: 0, y: 0, z: 0 };
    // A cluster shares one spot on the anchor and steps sideways instead, so
    // repeated adds do not stack exactly on top of each other.
    const offset = spacing === 'cluster'
      ? { x: hang.x + (index - (count - 1) / 2) * 0.7, y: hang.y, z: hang.z }
      : { ...hang };
    const mount = { anchorId: anchor.id, u, offset };
    const resolved = resolveMount(activeVenue, mount);
    if (resolved === null) continue;

    const suffix = Number(id.slice(id.lastIndexOf('-') + 1));
    const fixture: FixturePlacement = {
      id,
      name: `${kindTitle} ${Number.isFinite(suffix) ? suffix : created.length + 1}`,
      profile,
      position: resolved.position,
      yawDeg: resolved.yawDeg,
      pitchOffsetDeg: resolved.pitchOffsetDeg,
      mount,
    };
    next.push(fixture);
    created.push(fixture);
  }

  if (created.length === 0) return;
  applyRig(next, true);
  const first = created[0];
  if (first !== undefined) {
    arrangement.selectFixture(first.id);
    renderRigList();
    // Stay in the rig pane: adding several batches is the common next step.
    setSidePanelOpen(true, { mode: 'rig' });
  }
  setProjectStatus(`Added ${created.length} light${created.length === 1 ? '' : 's'} to ${anchor.name}`);
};

populateAddDialog();
ui.addDialog.addEventListener('close', () => {
  if (ui.addDialog.returnValue === 'add') addFixtures();
});
ui.addLights.addEventListener('click', () => {
  describeAddDialog();
  ui.addDialog.showModal();
});
for (const control of [ui.addProfile, ui.addMount, ui.addCount, ui.addSpacing]) {
  control.addEventListener('input', describeAddDialog);
  control.addEventListener('change', describeAddDialog);
}
ui.addMount.addEventListener('change', () => {
  // Surface the anchor's recommended profiles first.
  const anchor = findAnchor(activeVenue, ui.addMount.value);
  const suggested = anchor?.suggestedProfiles?.[0];
  if (suggested !== undefined && PROFILE_LIBRARY[suggested] !== undefined) {
    ui.addProfile.value = suggested;
  }
  describeAddDialog();
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

ui.setupLaserPattern.addEventListener('change', () => updateFixtureSetup((fixture) => {
  laserSetupFor(fixture).pattern = ui.setupLaserPattern.value as LaserPattern;
}));
ui.setupLaserBeams.addEventListener('input', () => updateFixtureSetup((fixture) => {
  const beams = Number(ui.setupLaserBeams.value);
  laserSetupFor(fixture).beams = beams;
  ui.setupLaserBeamsValue.textContent = String(beams);
}));
ui.setupLaserFan.addEventListener('input', () => updateFixtureSetup((fixture) => {
  const fanDeg = Number(ui.setupLaserFan.value);
  laserSetupFor(fixture).fanDeg = fanDeg;
  ui.setupLaserFanValue.textContent = `${fanDeg}°`;
}));

ui.setupPosition.addEventListener('input', () => {
  const fixture = arrangement.selectedFixture;
  if (fixture === null || fixture.mount === undefined) return;

  const u = Number(ui.setupPosition.value) / 100;
  fixture.mount.u = u;
  ui.setupPositionValue.textContent = `${Math.round(u * 100)}%`;

  // Only the point on the mount moves; aim and mount pitch stay as authored,
  // so dragging along a truss does not re-aim the light. The rig reads
  // placement every frame, so nothing needs rebuilding — and re-rendering the
  // arrangement on every slider tick would rebuild every clip's DOM.
  const resolved = resolveMount(activeVenue, fixture.mount);
  if (resolved !== null) fixture.position = resolved.position;
});

ui.setupName.addEventListener('change', () => {
  const fixture = arrangement.selectedFixture;
  if (fixture === null) return;
  const value = ui.setupName.value.trim();
  if (value === '') delete fixture.name;
  else fixture.name = value;
  // Lane labels live in the arrangement, so re-render the rows.
  applyRig([...show.fixtures], false);
});

ui.setupMount.addEventListener('change', () => {
  const fixture = arrangement.selectedFixture;
  const anchor = findAnchor(activeVenue, ui.setupMount.value);
  if (fixture === null || anchor === undefined) return;

  // Keep where the fixture sits along the structure; only the structure, and
  // therefore the mounting orientation, changes.
  const mount = {
    anchorId: anchor.id,
    u: fixture.mount?.u ?? 0.5,
    ...(anchor.mountOffset === undefined ? {} : { offset: { ...anchor.mountOffset } }),
  };
  const resolved = resolveMount(activeVenue, mount);
  if (resolved === null) return;

  fixture.mount = mount;
  fixture.position = resolved.position;
  fixture.yawDeg = resolved.yawDeg;
  fixture.pitchOffsetDeg = resolved.pitchOffsetDeg;
  // The rig reads placement every frame, so no rebuild is needed.
  applyRig([...show.fixtures], false);
});

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
const RENDER_KEY = STORAGE_KEYS.render;

interface StoredRenderSettings {
  volumetrics?: boolean;
  bloom?: boolean;
  shadows?: boolean;
  strobes?: boolean;
  activeFixtureCount?: number;
  cameraView?: number;
  /** Slow automatic camera sweep across the front of the stage. */
  orbit?: boolean;
  /** Scene haze 0..1. A render preference, not a project setting: it changes
   * how the room is *shown*, not what the show does. */
  haze?: number;
}

const readStoredRender = (): StoredRenderSettings => {
  try {
    const raw = readPreference(RENDER_KEY);
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
  strobes: strobesOn,
  activeFixtureCount: activeCount,
  cameraView: stage.view,
  orbit: stage.orbitEnabled,
  haze: stage.hazeLevel,
});

let persistedRender = '';
/** Write render prefs only when they actually changed. */
const persistRender = (): void => {
  const next = JSON.stringify(snapshotRender());
  if (next === persistedRender) return;
  persistedRender = next;
  writePreference(RENDER_KEY, next);
};

/**
 * The camera-mode pill always sits on the viewport: "Orbit" while the auto-orbit
 * follows playback, "Static" when it is off. The `o` hotkey hint stays visible.
 */
let orbitPillState = '';
const updateOrbitPill = (): void => {
  const state = stage.orbitEnabled ? 'orbit' : 'static';
  if (state === orbitPillState) return;
  orbitPillState = state;
  ui.orbitPill.dataset.state = state;
  ui.orbitPillLabel.textContent = state === 'orbit' ? 'Orbit' : 'Static';
};

const syncButtons = (): void => {
  ui.play.classList.toggle('on', clock.playing);
  ui.play.textContent = clock.playing ? '❚❚ Pause' : '▶ Play';
  ui.loop.textContent = clock.loopEnabled ? 'on' : 'off';
  ui.vol.classList.toggle('on', volumetrics);
  ui.bloom.classList.toggle('on', bloomOn);
  ui.shadow.classList.toggle('on', shadowsOn);
  ui.strobe.classList.toggle('on', strobesOn);
  ui.strobeStatus.textContent = strobesOn ? 'on' : 'off';
  ui.haze.value = String(Math.round(stage.hazeLevel * 100));
  ui.hazeValue.textContent = String(Math.round(stage.hazeLevel * 100));
  ui.count.querySelector('em')!.textContent = String(activeCount);
  ui.orbit.classList.toggle('on', stage.orbitEnabled);
  ui.orbit.setAttribute('aria-pressed', String(stage.orbitEnabled));
  updateOrbitPill();
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

const VOLUME_KEY = STORAGE_KEYS.volume;
const storedVolume = readNumberPreference(VOLUME_KEY);
let volume = Number.isFinite(storedVolume) ? Math.min(1, Math.max(0, storedVolume)) : 1;
let muted = false;

/**
 * `muted` is a keyboard-only state now (`M`): there is no mute button, so the
 * slider reflects it through color and its tooltip.
 */
const applyVolume = (persist = true): void => {
  clock.setVolume(muted ? 0 : volume);
  ui.volume.value = String(Math.round(volume * 100));
  ui.volume.classList.toggle('muted', muted);
  ui.volume.title = muted ? 'Muted — press M or move the slider to unmute' : 'Playback volume (M mutes)';
  if (persist) writePreference(VOLUME_KEY, String(volume));
};

ui.volume.addEventListener('input', () => {
  volume = Number(ui.volume.value) / 100;
  muted = false;
  applyVolume();
});
applyVolume(false);

// --- View preferences (persisted) -----------------------------------------
const STATS_KEY = STORAGE_KEYS.stats;
let statsVisible = readPreference(STATS_KEY) !== 'off';
const applyStats = (): void => {
  ui.statsPanel.hidden = !statsVisible;
  ui.stats.classList.toggle('on', statsVisible);
  ui.stats.setAttribute('aria-pressed', String(statsVisible));
};
const setStatsVisible = (visible: boolean, persist = true): void => {
  statsVisible = visible;
  if (persist) writePreference(STATS_KEY, visible ? 'on' : 'off');
  applyStats();
};
const toggleStats = (): void => setStatsVisible(!statsVisible);
applyStats();
ui.stats.addEventListener('click', toggleStats);

/** The render/controls panel always starts closed so it never covers the stage. */
let controlsVisible = false;
const applyControls = (): void => {
  ui.controlsPanel.hidden = !controlsVisible;
  ui.controlsToggle.classList.toggle('on', controlsVisible);
  ui.controlsToggle.setAttribute('aria-pressed', String(controlsVisible));
};
const setControlsVisible = (visible: boolean): void => {
  controlsVisible = visible;
  applyControls();
};
const toggleControls = (): void => setControlsVisible(!controlsVisible);
applyControls();
ui.controlsToggle.addEventListener('click', toggleControls);

const DOCK_HEIGHT_KEY = STORAGE_KEYS.dockHeight;
const DOCK_COLLAPSED_KEY = STORAGE_KEYS.dockCollapsed;
const WAVE_HEIGHT_KEY = STORAGE_KEYS.waveHeight;
const COLLAPSED_DOCK_PX = 54;

const storedDockHeight = readNumberPreference(DOCK_HEIGHT_KEY);
let dockHeightPx = Number.isFinite(storedDockHeight) ? storedDockHeight : 0;
let dockCollapsed = readPreference(DOCK_COLLAPSED_KEY) === 'on';

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
  writePreference(DOCK_HEIGHT_KEY, String(Math.round(dockHeightPx)));
};
ui.dockResizer.addEventListener('pointerup', endDockDrag);
ui.dockResizer.addEventListener('pointercancel', endDockDrag);

ui.dockToggle.addEventListener('click', () => {
  dockCollapsed = !dockCollapsed;
  writePreference(DOCK_COLLAPSED_KEY, dockCollapsed ? 'on' : 'off');
  applyDock();
});

const storedWaveHeight = readNumberPreference(WAVE_HEIGHT_KEY);
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
  writePreference(WAVE_HEIGHT_KEY, String(Math.round(waveHeightPx)));
};
ui.waveformResizer.addEventListener('pointerup', endWaveDrag);
ui.waveformResizer.addEventListener('pointercancel', endWaveDrag);

applyDock();

// --- Fixture side panel ---------------------------------------------------
const PANEL_WIDTH_KEY = STORAGE_KEYS.panelWidth;
const PANEL_MIN_WIDTH = 210;
const PANEL_MAX_WIDTH = 520;
const storedPanelWidth = readNumberPreference(PANEL_WIDTH_KEY);
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
  const rigMode = sidePanelOpen && sidePanelMode === 'rig';
  const fixtureMode = sidePanelMode === 'fixture';
  const surfaceMode = sidePanelMode === 'surface';
  ui.sidePanel.hidden = !sidePanelOpen;
  ui.rigPane.hidden = !rigMode;
  ui.fixturePane.hidden = !fixtureMode;
  ui.surfacePane.hidden = !surfaceMode;
  ui.rigMenu.classList.toggle('on', rigMode);
  ui.rigMenu.setAttribute('aria-pressed', String(rigMode));
  ui.dock.classList.toggle('has-panel', sidePanelOpen);
  syncPanelHeader(arrangement.selectedFixture, arrangement.selectedSurface);
  if (surfaceMode) syncSurfacePanel();
  syncActiveFixture();
  requestAnimationFrame(() => {
    refreshScrollMetrics();
    waveform.requestPaint();
  });
};

interface SidePanelOptions {
  mode?: SidePanelMode;
  fixtureId?: string;
}

const setSidePanelOpen = (open: boolean, options: SidePanelOptions = {}): void => {
  sidePanelOpen = open;
  if (open) {
    if (options.mode !== undefined) sidePanelMode = options.mode;
    if (options.fixtureId !== undefined) sidePanelFixtureId = options.fixtureId;
  }
  applySidePanel();
};

/** Clicking a light's name opens its settings; clicking it again closes them. */
const toggleSidePanel = (fixtureId: string): void => {
  if (sidePanelOpen && sidePanelMode === 'fixture' && sidePanelFixtureId === fixtureId) {
    setSidePanelOpen(false);
    return;
  }
  sidePanelMode = 'fixture';
  setSidePanelOpen(true, { mode: 'fixture', fixtureId });
};

/** A wall's name opens its calibration pane, mirroring a fixture's. */
const toggleSurfacePanel = (surfaceId: string): void => {
  if (sidePanelOpen && sidePanelMode === 'surface' && sidePanelFixtureId === surfaceId) {
    setSidePanelOpen(false);
    return;
  }
  sidePanelMode = 'surface';
  setSidePanelOpen(true, { mode: 'surface', fixtureId: surfaceId });
};

/** The RIG row opens the rig pane; clicking it again closes the panel. */
const toggleRigPanel = (): void => {
  if (sidePanelOpen && sidePanelMode === 'rig') {
    setSidePanelOpen(false);
    return;
  }
  setSidePanelOpen(true, { mode: 'rig' });
  renderRigList();
};

ui.rigMenu.addEventListener('click', toggleRigPanel);

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
  writePreference(PANEL_WIDTH_KEY, String(Math.round(panelWidthPx)));
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

// --- Middle-button panning ------------------------------------------------
// The scroller wraps the ruler, waveform and lanes, so one gesture pans the
// whole timeline regardless of which of those the user grabbed. Capture phase
// plus stopImmediatePropagation keeps scrub/draw/seek handlers out of it.
let timelinePan: { pointerId: number; startX: number; startScrollLeft: number } | null = null;

const endTimelinePan = (event?: PointerEvent): void => {
  if (timelinePan === null) return;
  if (event !== undefined && event.pointerId !== timelinePan.pointerId) return;
  const pointerId = timelinePan.pointerId;
  timelinePan = null;
  ui.arrangementScroll.classList.remove('panning');
  if (ui.arrangementScroll.hasPointerCapture(pointerId)) {
    ui.arrangementScroll.releasePointerCapture(pointerId);
  }
};

ui.arrangementScroll.addEventListener('pointerdown', (event) => {
  if (event.button !== 1) return;
  // Claim the middle button so the browser does not start autoscroll or
  // middle-click paste, and so the lane/waveform/ruler handlers never see it.
  event.preventDefault();
  event.stopImmediatePropagation();
  endTimelinePan();
  timelinePan = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startScrollLeft: ui.arrangementScroll.scrollLeft,
  };
  ui.arrangementScroll.classList.add('panning');
  ui.arrangementScroll.setPointerCapture(event.pointerId);
}, { capture: true });

ui.arrangementScroll.addEventListener('pointermove', (event) => {
  if (timelinePan === null || event.pointerId !== timelinePan.pointerId) return;
  event.preventDefault();
  ui.arrangementScroll.scrollLeft = timelinePan.startScrollLeft - (event.clientX - timelinePan.startX);
}, { capture: true });

ui.arrangementScroll.addEventListener('pointerup', endTimelinePan);
ui.arrangementScroll.addEventListener('pointercancel', endTimelinePan);
ui.arrangementScroll.addEventListener('auxclick', (event) => {
  if (event.button === 1) event.preventDefault();
});
window.addEventListener('blur', () => endTimelinePan());

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
  // Select mode reserves Shift for additive card selection, so the
  // Shift-drag loop gesture belongs to drop mode only.
  if (arrangement.timelineMode === 'select') return;
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
  ui.arrangementScroll.classList.toggle('loop-mode', on && arrangement.timelineMode === 'drop');
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
  } else if (event.key === 'c' || event.key === 'C') {
    if (arrangement.selectionCount === 0) return;
    event.preventDefault();
    arrangement.copySelected();
    syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues, arrangement.selectedSurface);
  } else if (event.key === 'v' || event.key === 'V') {
    event.preventDefault();
    // Shift pastes at the pointer instead of after the selection, so a copied
    // block can be dropped exactly where the user is looking.
    if (event.shiftKey) arrangement.pasteAtPointer();
    else arrangement.paste();
  } else if (event.key === 'a' || event.key === 'A') {
    // Only hijack Select All in select mode; drop mode keeps browser behaviour.
    if (arrangement.timelineMode !== 'select') return;
    event.preventDefault();
    arrangement.selectAll();
  }
});
const selectedAction = () => arrangement.selectedActions.find((action) => action === ui.cueAction.value)
  ?? arrangement.suggestedAction;
ui.cueAction.addEventListener('change', () => {
  const action = selectedAction();
  arrangement.setPendingAction(action);
  arrangement.setSelectedAction(action);
});
const chooseColor = (colorIndex: number, override?: CueColorOverride): void => {
  arrangement.setPendingColor(colorIndex, override);
  arrangement.setSelectedColor(colorIndex, override);
};
// The bar's current swatch opens the picker (it doubles as the palette entry
// point); the custom swatch does too, and clicking either one again closes it.
ui.cueColor.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('.color-swatch');
  if (target === null || target.hasAttribute('disabled')) return;
  if (ui.colorPicker.hidden) openColorPicker();
  else closeColorPicker();
});
ui.colorPalette.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('.color-swatch');
  if (target === null) return;
  const userIndex = target.dataset.userIndex;
  if (userIndex !== undefined) {
    const override = userColors[Number(userIndex)];
    if (override !== undefined) chooseColor(CUSTOM_COLOR_INDEX, override);
    return;
  }
  chooseColor(Number(target.dataset.colorIndex));
});
// Arrow keys move within the popover's palette, matching a select's keyboard
// behaviour; Escape closes back to the bar.
ui.colorPalette.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  const list = [...paletteSwatches, ...userSwatches];
  const currentElement = list.find((swatch) => swatch.classList.contains('selected')) ?? list[0]!;
  const current = list.indexOf(currentElement);
  const step = event.key === 'ArrowRight' ? 1 : -1;
  const next = (current + step + list.length) % list.length;
  event.preventDefault();
  const target = list[next]!;
  const userIndex = target.dataset.userIndex;
  if (userIndex !== undefined) {
    const override = userColors[Number(userIndex)];
    if (override !== undefined) chooseColor(CUSTOM_COLOR_INDEX, override);
  } else {
    chooseColor(Number(target.dataset.colorIndex));
  }
  target.focus();
});

function openColorPicker(): void {
  if (customSwatch.disabled) return;
  if (!ui.colorPicker.hidden) return;
  const selected = arrangement.selectedCue ?? null;
  const override = selected?.colorOverride ?? arrangement.suggestedColorOverride ?? undefined;
  syncColorPicker(override);
  ui.colorPicker.hidden = false;
  customSwatch.setAttribute('aria-expanded', 'true');
  ui.colorInput.focus();
}

function closeColorPicker(): void {
  if (ui.colorPicker.hidden) return;
  ui.colorPicker.hidden = true;
  customSwatch.removeAttribute('aria-expanded');
}
ui.colorPickerClose.addEventListener('click', () => {
  closeColorPicker();
  customSwatch.focus();
});
// Clicking elsewhere in the app dismisses the popover, as a menu would.
document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (ui.colorPicker.hidden || !(target instanceof Node)) return;
  if (ui.colorPicker.contains(target) || ui.cueColor.contains(target)) return;
  closeColorPicker();
});
ui.colorPicker.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeColorPicker();
  customSwatch.focus();
});

/** Hex string (`#rrggbb`) to a 0..1 rgb override. */
const parseHex = (value: string): CueColorOverride | null => {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (match === null) return null;
  const hex = match[1]!;
  return {
    kind: 'rgb',
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
};
const applyHex = (hex: string): void => {
  const override = parseHex(hex);
  if (override === null) return;
  rememberUserColor(override);
  chooseColor(CUSTOM_COLOR_INDEX, override);
};
/** Quick swatches compute to `rgb(...)`; normalise to hex for the override. */
const rgbTextToHex = (text: string): string => {
  const [r, g, b] = text.match(/\d+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
};
// The browser's HSV picker does the visual work. Dragging previews live but
// only commits on `change`, so one pick is one undo step.
ui.colorInput.addEventListener('input', () => {
  ui.colorPreview.style.background = ui.colorInput.value;
});
ui.colorInput.addEventListener('change', () => applyHex(ui.colorInput.value));
ui.hueGrid.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>('button');
  if (target === null) return;
  const hex = rgbTextToHex(getComputedStyle(target).backgroundColor);
  ui.colorInput.value = hex;
  applyHex(hex);
});
// --- LED look editor -------------------------------------------------------

/** A surface is the current target when its lane or one of its clips is selected. */
const surfaceTargeted = (): boolean =>
  arrangement.selectedSurface !== null || arrangement.selectedCue?.surfaceId !== undefined;

const currentLook = (): LedLookState | null =>
  surfaceTargeted() ? arrangement.selectedLook ?? arrangement.suggestedLook : null;

const patchLook = (patch: Partial<LedLookState>): void => {
  const look = currentLook();
  if (look === null) return;
  arrangement.setSelectedLook({ ...look, ...patch });
  if (!ui.lookEditor.hidden) renderLookEditor();
};

/** The popover shows one section at a time so it never needs a scrollbar. */
type LookEditorTab = 'look' | 'choose' | 'upload';
let lookEditorTab: LookEditorTab = 'look';

const setLookEditorTab = (tab: LookEditorTab): void => {
  lookEditorTab = tab;
  ui.lookTabLook.setAttribute('aria-selected', String(tab === 'look'));
  ui.lookTabChoose.setAttribute('aria-selected', String(tab === 'choose'));
  ui.lookTabUpload.setAttribute('aria-selected', String(tab === 'upload'));
  ui.lookPanelLook.hidden = tab !== 'look';
  ui.lookPanelChoose.hidden = tab !== 'choose';
  ui.lookPanelUpload.hidden = tab !== 'upload';
  // The footer belongs to the media tabs, and only once a clip is selected.
  ui.lookMediaFooter.hidden = tab === 'look' || currentLook()?.media === undefined;
};

ui.lookTabLook.addEventListener('click', () => setLookEditorTab('look'));
ui.lookTabChoose.addEventListener('click', () => setLookEditorTab('choose'));
ui.lookTabUpload.addEventListener('click', () => setLookEditorTab('upload'));

/** Rebuild the popover from the current look and its generator's param list. */
function renderLookEditor(): void {
  const look = currentLook();
  if (look === null) return;
  setLookEditorTab(lookEditorTab);
  const definition = lookDefinition(look.kind);
  ui.lookGlyph.textContent = definition.glyph;
  ui.lookTitle.textContent = definition.label;
  ui.lookGrid.replaceChildren(...LOOK_DEFINITIONS.map((entry) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'le-tile';
    button.setAttribute('aria-pressed', String(entry.kind === look.kind));
    button.title = entry.hint;
    button.innerHTML = `<b>${entry.glyph}</b><span>${entry.label}</span>`;
    button.addEventListener('click', () => {
      arrangement.setPendingLookKind(entry.kind);
      arrangement.setSelectedLook({ ...defaultLedLook(entry.kind), colors: [...look.colors] });
      renderLookEditor();
    });
    return button;
  }));

  const controls = definition.params.map((param) => {
    if (param.kind === 'palette') {
      const field = document.createElement('label');
      field.className = 'le-field';
      field.innerHTML = `<span>${param.label}</span>`;
      const row = document.createElement('div');
      row.className = 'le-colors';
      for (const [index, css] of look.colors.entries()) {
        const input = document.createElement('input');
        input.type = 'color';
        input.value = css;
        input.setAttribute('aria-label', `Colour ${index + 1}`);
        input.addEventListener('change', () => {
          const colors = [...look.colors];
          colors[index] = input.value;
          patchLook({ colors });
        });
        row.appendChild(input);
      }
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'le-add';
      add.textContent = '+';
      add.title = 'Add a colour stop';
      add.disabled = look.colors.length >= param.max;
      add.addEventListener('click', () => {
        patchLook({ colors: [...look.colors, look.colors.at(-1) ?? '#ffffff'] });
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'le-add';
      remove.textContent = '−';
      remove.title = 'Remove the last colour stop';
      remove.disabled = look.colors.length <= param.min;
      remove.addEventListener('click', () => {
        patchLook({ colors: look.colors.slice(0, -1) });
      });
      row.append(add, remove);
      field.appendChild(row);
      return field;
    }
    if (param.kind === 'seed') {
      const field = document.createElement('label');
      field.className = 'le-field';
      field.innerHTML = `<span>${param.label}</span>`;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sp-btn';
      button.textContent = `Randomise (${Math.round(look.seed)})`;
      button.addEventListener('click', () => patchLook({ seed: Math.random() * 1000 }));
      field.appendChild(button);
      return field;
    }
    if (param.kind === 'select') {
      const field = document.createElement('label');
      field.className = 'le-field';
      field.innerHTML = `<span>${param.label}</span>`;
      const select = document.createElement('select');
      select.className = 'le-select';
      for (const option of param.options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        select.appendChild(element);
      }
      select.value = look.sync;
      select.addEventListener('change', () => patchLook({ sync: select.value as LedLookState['sync'] }));
      field.appendChild(select);
      return field;
    }
    const field = document.createElement('label');
    field.className = 'le-field';
    const value = look[param.key];
    field.innerHTML = `<span>${param.label}</span><output>${formatParam(param.key, value, param.unit)}</output>`;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(param.min);
    input.max = String(param.max);
    input.step = String(param.step);
    input.value = String(value);
    input.setAttribute('aria-label', param.label);
    input.addEventListener('pointerdown', () => arrangement.beginLookEdit());
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight'
        || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        arrangement.beginLookEdit();
      }
    });
    input.addEventListener('input', () => {
      const numeric = Number(input.value);
      field.querySelector('output')!.textContent = formatParam(param.key, numeric, param.unit);
      const target = currentLook();
      if (target === null) return;
      arrangement.previewSelectedLook({ ...target, [param.key]: numeric });
    });
    input.addEventListener('change', () => arrangement.commitLookEdit());
    field.appendChild(input);
    return field;
  });
  ui.lookControls.replaceChildren(...controls);

  ui.lookPresets.replaceChildren(...PALETTE_PRESETS.map((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'le-preset';
    button.title = preset.name;
    button.style.background = `linear-gradient(90deg, ${preset.colors.join(', ')})`;
    button.addEventListener('click', () => patchLook({ colors: [...preset.colors] }));
    return button;
  }));

  renderMediaTabs(look);
}

/** Uploaded assets are read from IndexedDB once per session. */
let localMediaAssets: LedMediaAsset[] = [];
let localMediaRequested = false;

const ensureLocalMedia = (): void => {
  if (localMediaRequested) return;
  localMediaRequested = true;
  void media.listLocalAssets().then((assets) => {
    localMediaAssets = assets;
    if (!ui.lookEditor.hidden) {
      const look = currentLook();
      if (look !== null) renderMediaTabs(look);
    }
  }).catch((error: unknown) => {
    console.warn('could not list uploaded wall media', error);
  });
};

/** Replace the selected look with a media look using `asset`. */
const applyMediaLook = (asset: LedMediaAsset): void => {
  const look = currentLook();
  const fit = look?.media?.fit ?? 'cover';
  mediaNotice = '';
  arrangement.setSelectedLook({ ...defaultLedLook('media'), media: mediaRef(asset, fit) });
  setLookEditorTab(asset.source.startsWith('local:') ? 'upload' : 'choose');
  renderLookEditor();
};

/** Shown in the Upload tab when a dropped file is not image or video. */
let mediaNotice = '';

const mediaKindLabel = (kind: LedMediaAsset['kind']): string =>
  kind === 'video' ? 'Video' : 'Image';

/** One gallery tile: a cached poster frame plus the asset label. */
function mediaTile(
  asset: LedMediaAsset,
  selectedSource: string | undefined,
  onPick: (asset: LedMediaAsset) => void,
): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'le-media-tile';
  button.title = `${asset.label} · ${mediaKindLabel(asset.kind)}`;
  button.setAttribute('aria-pressed', String(selectedSource === asset.source));

  const frame = document.createElement('span');
  frame.className = 'le-media-frame';
  frame.textContent = asset.kind === 'video' ? '▶' : '▣';
  void mediaPoster(asset).then((src) => {
    if (src === '' || !button.isConnected) return;
    const image = document.createElement('img');
    image.src = src;
    image.alt = '';
    image.draggable = false;
    frame.replaceChildren(image);
    if (asset.kind === 'video') {
      const badge = document.createElement('b');
      badge.textContent = '▶';
      frame.appendChild(badge);
    }
  });

  const label = document.createElement('span');
  // Every bundled clip is a Mantissa loop, so the prefix is noise in a narrow
  // tile. Keep the full name in the tooltip.
  label.textContent = asset.source.startsWith('bundled:')
    ? asset.label.replace(/^Mantissa\s+/i, 'Loop ')
    : asset.label;
  button.append(frame, label);
  button.addEventListener('click', () => onPick(asset));
  return button;
}

/**
 * Gallery + current-selection footer for the Choose and Upload tabs.
 *
 * Thumbnails are cached poster frames rather than live `<video>` tiles: ten
 * decoders (and a new burst on every re-render) made the popover stutter and
 * filled the console with aborted requests.
 */
function renderMediaTabs(look: LedLookState): void {
  ensureLocalMedia();
  const selected = look.kind === 'media' ? look.media : undefined;
  const selectedSource = selected?.source;
  const pick = (asset: LedMediaAsset): void => applyMediaLook(asset);

  ui.lookChooseGrid.replaceChildren(...BUNDLED_MEDIA.map((asset) => mediaTile(asset, selectedSource, pick)));
  ui.lookUploadGrid.replaceChildren(...localMediaAssets.map((asset) => mediaTile(asset, selectedSource, pick)));
  ui.lookUploadEmpty.hidden = localMediaAssets.length > 0 || mediaNotice === '';
  ui.lookUploadEmpty.textContent = mediaNotice !== ''
    ? mediaNotice
    : 'Nothing uploaded yet.';

  const isMedia = selected !== undefined;
  ui.lookMediaFooter.hidden = !isMedia || lookEditorTab === 'look';
  if (!isMedia) return;
  const local = selected.source.startsWith('local:');
  ui.lookMediaCurrent.replaceChildren();
  const name = document.createElement('b');
  name.textContent = selected.label ?? selected.source;
  const origin = document.createElement('em');
  origin.textContent = ` · ${mediaKindLabel(selected.kind)} · ${local ? 'upload' : 'bundled'}`;
  ui.lookMediaCurrent.append(name, origin);
  ui.lookMediaFit.value = selected.fit;
  ui.lookMediaRemove.hidden = !local;
}

/** Import files from the upload button or a drop and select the first one. */
function importWallMedia(files: File[]): void {
  if (files.length === 0) return;
  void media.importFiles(files).then((refs) => {
    const first = refs[0];
    if (first === undefined) {
      mediaNotice = 'Only image and video files can be used on the wall.';
      setLookEditorTab('upload');
      renderLookEditor();
      return;
    }
    mediaNotice = '';
    // Force the library to re-list so the new uploads appear in the gallery.
    localMediaAssets = [];
    localMediaRequested = false;
    arrangement.setSelectedLook({ ...defaultLedLook('media'), media: first });
    setLookEditorTab('upload');
    renderLookEditor();
  }).catch((error: unknown) => {
    console.warn('could not import wall media', error);
  });
}

ui.lookMediaFit.addEventListener('change', () => {
  const look = currentLook();
  if (look?.media === undefined) return;
  patchLook({ media: { ...look.media, fit: ui.lookMediaFit.value as LedMediaRef['fit'] } });
});

ui.lookMediaRemove.addEventListener('click', () => {
  const look = currentLook();
  if (look?.media === undefined) return;
  const source = look.media.source;
  void media.removeAsset(source).then(() => {
    localMediaAssets = [];
    localMediaRequested = false;
    const current = currentLook();
    if (current?.kind === 'media' && current.media?.source === source) {
      arrangement.setSelectedLook({ ...defaultLedLook('gradient'), colors: [...current.colors] });
    }
    renderLookEditor();
  });
});

ui.lookUpload.addEventListener('click', () => ui.lookFile.click());
ui.lookFile.addEventListener('change', () => {
  const files = [...(ui.lookFile.files ?? [])];
  ui.lookFile.value = '';
  importWallMedia(files);
});
ui.lookPanelUpload.addEventListener('dragover', (event) => {
  event.preventDefault();
  ui.lookPanelUpload.classList.add('dragging');
});
ui.lookPanelUpload.addEventListener('dragleave', () => {
  ui.lookPanelUpload.classList.remove('dragging');
});
ui.lookPanelUpload.addEventListener('drop', (event) => {
  event.preventDefault();
  ui.lookPanelUpload.classList.remove('dragging');
  importWallMedia([...(event.dataTransfer?.files ?? [])]);
});

const formatParam = (key: string, value: number, unit?: string): string => {
  if (key === 'intensity' || key === 'softness') return `${Math.round(value * 100)}%`;
  if (key === 'speed') {
    const sync = currentLook()?.sync;
    const unit = sync === 'beat' ? 'cycles/beat' : sync === 'bar' ? 'cycles/bar' : 'Hz';
    return `${value.toFixed(2)} ${unit}`;
  }
  return `${value.toFixed(key === 'scale' ? 2 : 0)}${unit ?? ''}`;
};

function openLookEditor(): void {
  if (!surfaceTargeted()) return;
  const look = currentLook();
  lookEditorTab = look?.kind !== 'media'
    ? 'look'
    : look.media?.source.startsWith('local:') ? 'upload' : 'choose';
  renderLookEditor();
  ui.lookEditor.hidden = false;
  ui.lookEdit.setAttribute('aria-expanded', 'true');
}

function closeLookEditor(): void {
  if (ui.lookEditor.hidden) return;
  ui.lookEditor.hidden = true;
  ui.lookEdit.removeAttribute('aria-expanded');
}

ui.lookEdit.addEventListener('click', () => {
  if (ui.lookEditor.hidden) openLookEditor();
  else closeLookEditor();
});
ui.lookClose.addEventListener('click', () => {
  closeLookEditor();
  ui.lookEdit.focus();
});
ui.lookEditor.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  closeLookEditor();
  ui.lookEdit.focus();
});
document.addEventListener('pointerdown', (event) => {
  const target = event.target;
  if (ui.lookEditor.hidden || !(target instanceof Node)) return;
  if (ui.lookEditor.contains(target) || ui.lookEdit.contains(target)) return;
  closeLookEditor();
});

// --- LED wall calibration (side panel) -------------------------------------

const wallById = (id: string | null): LedSurface | null =>
  id === null ? null : surfaces.find((surface) => surface.id === id) ?? null;

const patchSurface = (patch: Partial<LedSurface>): void => {
  const surface = wallById(sidePanelFixtureId);
  if (surface === null) return;
  const next = { ...surface, ...patch };
  surfaces = surfaces.map((entry) => (entry.id === next.id ? next : entry));
  arrangement.setSurfaces(surfaces);
  stage.updateLedSurface(next);
  syncSurfacePanel();
};

function syncSurfacePanel(): void {
  const surface = wallById(sidePanelFixtureId);
  if (surface === null) return;
  ui.surfaceSummary.textContent =
    `${surface.widthM.toFixed(1)} × ${surface.heightM.toFixed(1)} m · ${Math.round(surface.widthM / (surface.pitchMm / 1000))} × ${Math.round(surface.heightM / (surface.pitchMm / 1000))} LEDs`;
  ui.surfaceWidth.value = String(surface.widthM);
  ui.surfaceWidthValue.textContent = `${surface.widthM.toFixed(1)} m`;
  ui.surfaceHeight.value = String(surface.heightM);
  ui.surfaceHeightValue.textContent = `${surface.heightM.toFixed(1)} m`;
  ui.surfacePitch.value = String(surface.pitchMm);
  ui.surfacePitchValue.textContent = `${surface.pitchMm.toFixed(1)} mm`;
  ui.surfaceGap.value = String(Math.round(surface.gap * 100));
  ui.surfaceGapValue.textContent = `${Math.round(surface.gap * 100)}%`;
  ui.surfaceBrightness.value = String(Math.round(surface.brightness * 100));
  ui.surfaceBrightnessValue.textContent = `${Math.round(surface.brightness * 100)}%`;
  ui.surfaceBlack.value = String(Math.round(surface.blackLevel * 100));
  ui.surfaceBlackValue.textContent = `${Math.round(surface.blackLevel * 100)}%`;
  ui.surfaceGamma.value = String(Math.round(surface.gamma * 10));
  ui.surfaceGammaValue.textContent = surface.gamma.toFixed(1);
  ui.surfaceEmit.value = String(Math.round(surface.emit * 100));
  ui.surfaceEmitValue.textContent = `${Math.round(surface.emit * 100)}%`;

  const wallCues = cuesByFixture.get(surface.id) ?? [];
  const now = clock.time;
  ui.panelSurfaceCount.textContent = String(wallCues.length);
  ui.panelSurfaceActive.textContent = String(
    wallCues.filter((cue) => now >= cue.startSec && now <= cue.endSec).length,
  );
  syncPanelHeader(arrangement.selectedFixture, surface);
}

const bindSurfaceSlider = (
  input: HTMLInputElement,
  apply: (value: number) => Partial<LedSurface>,
): void => {
  input.addEventListener('input', () => patchSurface(apply(Number(input.value))));
};
bindSurfaceSlider(ui.surfaceWidth, (value) => ({ widthM: value }));
bindSurfaceSlider(ui.surfaceHeight, (value) => ({ heightM: value }));
bindSurfaceSlider(ui.surfacePitch, (value) => ({ pitchMm: value }));
bindSurfaceSlider(ui.surfaceGap, (value) => ({ gap: value / 100 }));
bindSurfaceSlider(ui.surfaceBrightness, (value) => ({ brightness: value / 100 }));
bindSurfaceSlider(ui.surfaceBlack, (value) => ({ blackLevel: value / 100 }));
bindSurfaceSlider(ui.surfaceGamma, (value) => ({ gamma: value / 10 }));
bindSurfaceSlider(ui.surfaceEmit, (value) => ({ emit: value / 100 }));

ui.cueDelete.addEventListener('click', () => arrangement.deleteSelected());
ui.cueCopy.addEventListener('click', () => {
  arrangement.copySelected();
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues, arrangement.selectedSurface);
});
ui.cuePaste.addEventListener('click', () => arrangement.paste());
ui.trackFilter.addEventListener('change', () => {
  applyTrackFilter();
});
ui.hideUnfiltered.addEventListener('click', () => {
  hideUnfiltered = !hideUnfiltered;
  applyTrackFilter();
});
ui.chooseAudio.addEventListener('click', () => ui.audioFile.click());
ui.audioFile.addEventListener('change', () => {
  const file = ui.audioFile.files?.[0];
  ui.audioFile.value = '';
  if (file === undefined) return;

  ui.chooseAudio.disabled = true;
  ui.audioStatus.textContent = `Loading ${file.name}…`;
  void (async () => {
    try {
      const data = await file.arrayBuffer();
      const buffer = await clock.decode(data);
      clock.load(buffer);
      clock.setLoop({ startSec: 0, endSec: buffer.duration }, true);
      clock.seek(0);
      projectAudio = { source: 'external', fileName: file.name };
      projectAudioFile = {
        bytes: new Uint8Array(data),
        kind: 'audio',
        mime: file.type === '' ? 'application/octet-stream' : file.type,
        fileName: file.name,
      };
      loadedAudioSha = null;
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
ui.strobe.addEventListener('click', () => {
  strobesOn = !strobesOn;
  syncButtons();
});
ui.haze.addEventListener('input', () => {
  stage.setHaze(Number(ui.haze.value) / 100);
  ui.hazeValue.textContent = ui.haze.value;
  persistRender();
});
ui.view.addEventListener('click', () => {
  stage.nextView();
  persistRender();
});
ui.orbit.addEventListener('click', () => {
  stage.toggleOrbit();
  syncButtons();
});
ui.count.addEventListener('click', () => {
  const presets = countPresets();
  countIndex = (countIndex + 1) % presets.length;
  setActiveCount(presets[countIndex] ?? show.fixtures.length);
});

window.addEventListener('keydown', (event) => {
  if (isTextEntry(event.target)) return;
  // Bare-letter shortcuts must not fire as Ctrl/Cmd combos: Ctrl+C copies
  // clips, but it also used to toggle the camera via the `c` shortcut.
  if (event.ctrlKey || event.metaKey || event.altKey) return;
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
    if (!arrangement.hasSelection) return;
    event.preventDefault();
    arrangement.deleteSelected();
  } else if (event.key === 'd' || event.key === 'D') {
    applyTimelineMode('drop');
  } else if (event.key === 'v' || event.key === 'V') {
    applyTimelineMode('select');
  } else if (event.key === 'Escape') {
    arrangement.clearSelection();
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
  } else if (event.key === 'o' || event.key === 'O') {
    stage.toggleOrbit();
  } else if (event.key === 'h' || event.key === 'H') {
    /* Cycle haze: clear → light → club → heavy, so the beam/pool balance can
     * be compared without opening the panel. */
    const next = [0, 0.3, 0.65, 1].find((value) => value > stage.hazeLevel + 0.01) ?? 0;
    stage.setHaze(next);
    syncButtons();
  } else if (event.key === '[' || event.key === ']') {
    const step = event.key === ']' ? 1 : -1;
    const presets = countPresets();
    countIndex = (countIndex + step + presets.length) % presets.length;
    setActiveCount(presets[countIndex] ?? show.fixtures.length);
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

// Assigned after `applyResolutionScale` captures it.
// eslint-disable-next-line prefer-const
let perf: PerfMonitor;
const applyResolutionScale = (): void => {
  renderer.setPixelRatio(baseRatio * perf.resolutionScale);
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
};
perf = new PerfMonitor({
  applyResolutionScale,
  isPlaying: () => clock.playing,
  isHidden: () => document.hidden,
});

// --- Render benchmark -----------------------------------------------------

interface BenchRun {
  recorder: BenchmarkRecorder;
  startedAt: string;
  options: BenchmarkResult['options'];
  restore: () => void;
  resolve: (result: BenchmarkResult) => void;
}

let benchRun: BenchRun | null = null;

/**
 * Identify the GPU without depending on the active backend, so a WebGL2 run on
 * a WebGPU laptop still reports the real hardware. The string is cached: it
 * never changes for the life of the page.
 */
const gpuLabel = (): string => {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    if (gl === null) return 'unknown';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName = info === null
      ? gl.getParameter(gl.RENDERER)
      : gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    return String(rendererName);
  } catch {
    return 'unknown';
  }
};

let cachedMachine: MachineInfo | null = null;
const currentMachine = (): MachineInfo => {
  if (cachedMachine !== null) return cachedMachine;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  cachedMachine = machineInfo({
    gpu: gpuLabel(),
    cores: navigator.hardwareConcurrency || 0,
    ...(memory === undefined ? {} : { memoryGb: memory }),
    devicePixelRatio: window.devicePixelRatio || 1,
    viewport: `${viewport.clientWidth}x${viewport.clientHeight}`,
    userAgent: navigator.userAgent,
  });
  return cachedMachine;
};

/**
 * Measure render cost on a pinned scenario, then put the app back.
 *
 * The scenario is built from the loaded rig, not from the sample project, so
 * editing `koto-chill.dmxsim` cannot invalidate a comparison. Everything that
 * changes the number is pinned for the run: all fixtures visible, orbit on,
 * 100% resolution scale, a fixed zoom, and a fixed song time.
 *
 * Roughly 3.5 s of wall clock at the defaults (0.9 s warmup, 2.4 s sampling),
 * which is enough for ~150 frames at 60 fps.
 */
const runBenchmark = async (options: BenchmarkOptions = {}): Promise<BenchmarkResult> => {
  if (benchRun !== null) throw new Error('a benchmark is already running');
  // A background tab throttles requestAnimationFrame to ~1 Hz, which would
  // report a fake 0.1 fps. Better to fail loudly than to poison the history.
  if (document.hidden) throw new Error('benchmark needs a visible page: background tabs throttle rAF');
  if (currentTimeline === null) throw new Error('benchmark needs a loaded track');
  if (show.fixtures.length === 0) throw new Error('benchmark needs a rig');

  const startSec = options.startSec ?? BENCH_SCENARIO.startSec;
  const warmupMs = options.warmupMs ?? BENCH_SCENARIO.warmupMs;
  const measureMs = options.measureMs ?? BENCH_SCENARIO.measureMs;
  const orbitOn = options.orbit ?? BENCH_SCENARIO.orbit;
  const orbitSpeed = options.orbitSpeed ?? BENCH_SCENARIO.orbitSpeed;

  const previous = {
    cues,
    activeCount,
    zoom: arrangement.zoomLevel,
    orbit: stage.orbitEnabled,
    playing: clock.playing,
    songTime: clock.time,
    loop: { ...loopRegion },
    loopEnabled: clock.loopEnabled,
  };

  const restore = (): void => {
    clock.pause();
    arrangement.setCues(previous.cues);
    setActiveCount(previous.activeCount);
    stage.setOrbitTimeScale(1);
    stage.setOrbit(previous.orbit);
    if (previous.zoom !== arrangement.zoomLevel) setZoom(previous.zoom);
    loopRegion = previous.loop;
    applyLoop(false);
    clock.setLoopEnabled(previous.loopEnabled);
    clock.seek(previous.songTime);
    perf.setAutoResolution(true);
    if (previous.playing) void clock.play();
  };

  // Pin the scenario.
  setActiveCount(show.fixtures.length);
  stage.setView(0, true);
  stage.setOrbit(orbitOn);
  stage.setOrbitTimeScale(orbitSpeed);
  setZoom(PIXELS_PER_SECOND);
  arrangement.setCues([
    ...buildBenchCues(show.fixtures, startSec, BENCH_SCENARIO.windowSec),
    ...buildBenchSurfaceCues(surfaces, startSec, BENCH_SCENARIO.windowSec),
  ]);
  loopRegion = { startSec, endSec: startSec + BENCH_SCENARIO.windowSec };
  applyLoop(false);
  clock.setLoopEnabled(false);
  clock.seek(startSec);
  perf.setAutoResolution(false);
  perf.resetScale();
  applyResolutionScale();
  await clock.play();

  const recorder = new BenchmarkRecorder(warmupMs, measureMs);
  const result = new Promise<BenchmarkResult>((resolve) => {
    benchRun = {
      recorder,
      startedAt: new Date().toISOString(),
      options: { startSec, warmupMs, measureMs, orbit: orbitOn, orbitSpeed },
      restore,
      resolve,
    };
    recorder.start(performance.now());
  });
  return result;
};

/**
 * Persist a run so the next one can be compared against it. The dev server
 * appends it to `docs/agent_docs/perf-runs.jsonl`; static builds have no
 * endpoint, where the returned result is still the source of truth.
 */
const postBenchmarkResult = async (result: BenchmarkResult): Promise<void> => {
  try {
    await fetch('/__bench', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(result),
    });
  } catch {
    // Not running under the dev server; nothing to persist to.
  }
};

/** Read the persisted run history (already-appended runs, oldest first). */
const fetchBenchmarkHistory = async (): Promise<BenchmarkResult[]> => {
  try {
    const response = await fetch('/__bench');
    if (!response.ok) return [];
    return (await response.json()) as BenchmarkResult[];
  } catch {
    return [];
  }
};

/** Called from the frame loop once the recorder's sample window closes. */
const finishBenchmark = (): void => {
  const run = benchRun;
  if (run === null) return;
  benchRun = null;
  const playing = clock.playing;
  run.restore();
  const result = run.recorder.summarize({
    scenario: BENCH_SCENARIO.name,
    startedAt: run.startedAt,
    backend,
    resolutionScale: 1,
    fixtureCount: show.fixtures.length,
    machine: currentMachine(),
    rigSignature: rigSignature(show.fixtures),
    options: run.options,
  });
  if (!playing) result.warnings = ['audio did not start; animation phase is static'];
  // Fewer than ~20 frames over the sample window means the tab lost focus or
  // the machine stalled; the percentiles are not meaningful.
  if (result.frames < 20) {
    result.warnings = [...(result.warnings ?? []), `only ${result.frames} frames sampled; page may have been throttled`];
  }
  void postBenchmarkResult(result);
  run.resolve(result);
};

const updateStats = (now: number, states: readonly FixtureState[], songTime: number): void => {
  if (!perf.shouldRefreshStats(now)) return;
  syncButtons();

  const info = renderer.info.render;
  ui.fps.textContent = (1000 / perf.frameMs).toFixed(0);
  ui.ms.textContent = `${perf.frameMs.toFixed(1)} ms`;
  ui.calls.textContent = String(info.drawCalls);
  ui.tris.textContent = info.triangles.toLocaleString('en-US');
  ui.res.textContent = `${(perf.resolutionScale * 100).toFixed(0)}%`;
  ui.latency.textContent = `${(clock.latencySec * 1000).toFixed(1)} ms`;

  const active = states.slice(0, activeCount).filter((state) => state.active).length;
  ui.fixtures.textContent = `${active} active / ${activeCount} shown`;

  const { beatsPerBar } = show.beatGrid;
  const beat = timeToBeat(show.beatGrid, showTime(songTime));
  const bar = Math.floor(beat / beatsPerBar) + 1;
  const beatInBar = Math.floor(((beat % beatsPerBar) + beatsPerBar) % beatsPerBar) + 1;
  ui.time.textContent = `${bar}.${beatInBar}`;
  ui.transportTime.textContent = `${formatClock(songTime)} / ${formatClock(clock.duration)}`;
  if (sidePanelOpen) {
    if (sidePanelMode === 'surface') syncSurfacePanel();
    else refreshPanelClipStats();
  }
};

const frame = (now: number): void => {
  const workStart = performance.now();
  const deltaMs = perf.sampleFrame(now);

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
      .filter((cue) => cue.surfaceId === undefined)
      .filter((cue) => songTime >= cue.startSec && songTime <= cue.endSec)
      .map((cue) => arrangement.toClip(cue));
    const state = evaluateFixture(fixture, trackClips, songTime);
    return fixture.profile.kind === 'strobe' && !strobesOn
      ? { ...state, intensity: 0, active: false, strobeHz: 0 }
      : state;
  });

  cryoAudio.update(states, songTime, clock.playing, (fixtureId) => {
    let endSec: number | null = null;
    for (const cue of cuesByFixture.get(fixtureId) ?? []) {
      if (songTime < cue.startSec || songTime > cue.endSec) continue;
      if (endSec === null || cue.endSec > endSec) endSec = cue.endSec;
    }
    return endSec;
  });

  /**
   * Resolve each wall's content: the active clip is the newest one, and a
   * short crossfade hands over from the clip underneath. Two additive layers
   * in `LedWall` do the blend, so this stays a pure function of song time.
   */
  const wallPlayback = new Map<string, LedPlaybackLayer[]>();
  for (const surface of surfaces) {
    const wallCues = (cuesByFixture.get(surface.id) ?? [])
      .filter((cue) => cue.look !== undefined)
      .slice()
      .sort((a, b) => a.startSec - b.startSec);
    const current = wallCues
      .filter((cue) => songTime >= cue.startSec && songTime < cue.endSec)
      .at(-1);
    if (current === undefined) continue;
    const earlier = wallCues.filter((cue) => cue.startSec < current.startSec).at(-1);
    const previous = earlier !== undefined && earlier.endSec >= current.startSec - 0.001
      ? earlier
      : undefined;
    // A crossfade needs something to fade *from*. With no adjacent earlier
    // clip the wall cuts to this look, so pausing at its start is never blank.
    const fade = Math.max(0.001, current.fadeInSec ?? 0.35);
    const ramp = previous === undefined
      ? 1
      : Math.min(1, Math.max(0, (songTime - current.startSec) / fade));
    const layers: LedPlaybackLayer[] = [];
    if (previous?.look !== undefined && ramp < 1) {
      layers.push({ look: previous.look, opacity: (1 - ramp) * (previous.opacity ?? 1) });
    }
    layers.push({ look: current.look!, opacity: ramp * (current.opacity ?? 1) });
    wallPlayback.set(surface.id, layers);
  }
  stage.setLedPlayback(wallPlayback);
  stage.update(states, showAt, { volumetrics, playing: clock.playing });
  post.setTime(showAt);
  renderer.info.reset();
  post.render();

  arrangement.setSongTime(songTime);
  const playheadX = songTime * arrangement.zoomLevel;
  setRulerPlayhead(playheadX);
  setWaveformPlayhead(playheadX);

  const cpuMs = performance.now() - workStart;
  perf.sampleCpu(cpuMs);
  if (benchRun !== null) {
    const done = benchRun.recorder.sample({
      frameMs: deltaMs,
      cpuMs,
      drawCalls: renderer.info.render.drawCalls,
      triangles: renderer.info.render.triangles,
    }, now);
    if (done) finishBenchmark();
  }
  perf.adjustResolution(now);
  updateStats(now, states, songTime);

  requestAnimationFrame(frame);
};

// --- Project files --------------------------------------------------------

const setProjectStatus = (message: string): void => {
  ui.projectStatus.textContent = message;
};

const describeAudio = (audio: ProjectFile['audio'], bpm: number | null): string => {
  if (audio.title !== undefined) {
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
  strobesOn = local.strobes ?? settings.render.strobes;
  post.setBloom(bloomOn);
  applyShadows();

  const requested = (local.activeFixtureCount ?? settings.render.activeFixtureCount) > 0
    ? Math.min(local.activeFixtureCount ?? settings.render.activeFixtureCount, show.fixtures.length)
    : show.fixtures.length;
  setActiveCount(requested);
  /* Local haze wins; otherwise start from the venue's own atmosphere. */
  stage.setHaze(local.haze ?? stage.hazeLevel);
  const presets = countPresets();
  const presetIndex = presets.indexOf(requested);
  countIndex = presetIndex >= 0 ? presetIndex : presets.length - 1;
  stage.setView(local.cameraView ?? settings.render.cameraView, true);
  stage.setOrbit(local.orbit ?? true);

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
    writePreference(DOCK_COLLAPSED_KEY, dockCollapsed ? 'on' : 'off');
    writePreference(DOCK_HEIGHT_KEY, String(Math.round(dockHeightPx)));
    applyDock();
    waveHeightPx = Math.max(40, Math.min(200, settings.ui.waveformHeightPx));
    writePreference(WAVE_HEIGHT_KEY, String(Math.round(waveHeightPx)));
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
  surfaces = surfacesFromProject(project, venueSurfaces(activeVenue));
  arrangement.setSurfaces(surfaces);
  stage.setLedSurfaces(surfaces);
  arrangement.setCues([
    ...project.arrangement.clips.map(projectClipToCue),
    ...project.arrangement.surfaceClips.map(projectSurfaceClipToCue),
  ]);
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
  return buildProjectFile({
    name: projectName,
    description: projectDescription,
    venue: { id: activeVenue.id, name: activeVenue.name },
    show: { name: show.name, fixtures: show.fixtures },
    timeline,
    loop: loopRegion,
    cues,
    surfaces,
    render: {
      volumetrics,
      bloom: bloomOn,
      shadows: shadowsOn,
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
    audio: projectAudio,
  });
};

/**
 * Replace the clock with the audio a bundle carries.
 *
 * Bundles are the only source of a project's track now, so opening a shared
 * show plays its own song instead of whatever happened to be loaded. Audio
 * already in the clock is left alone when the digest matches.
 */
const loadProjectAudio = async (bundle: ProjectBundle): Promise<void> => {
  const { audio } = bundle.project;
  if (audio.source !== 'embedded' || audio.sha256 === undefined) return;
  if (audio.sha256 === loadedAudioSha) return;
  const file = bundle.media.get(audio.sha256);
  if (file === undefined) {
    console.warn(`project audio ${audio.fileName ?? audio.sha256} is missing from the bundle`);
    return;
  }
  const buffer = await clock.decode(file.bytes.slice().buffer as ArrayBuffer);
  clock.load(buffer);
  waveform.setPeaks(computePeaks(buffer, 1600));
  projectAudioFile = file;
  loadedAudioSha = audio.sha256;
};

/** Apply a bundle: register its wall media, load its audio, then the document. */
const applyProjectBundle = async (bundle: ProjectBundle): Promise<void> => {
  media.addEmbedded(bundle.media);
  await loadProjectAudio(bundle);
  applyProject(bundle.project);
};

const saveProject = (): void => {
  void saveProjectFile({
    build: buildProject,
    embed: (project) => embedProjectMedia(project, {
      audio: async () => projectAudioFile,
      file: (source) => media.fileFor(source),
    }),
    setStatus: setProjectStatus,
  });
};

const openProject = async (file: File): Promise<void> => {
  await openProjectFile({
    file,
    hasAudio: () => currentTimeline !== null && clock.duration > 0,
    rigMatches: (project) => rigMatches(project, show.fixtures),
    apply: applyProjectBundle,
    setBusy: (busy) => { ui.projectOpen.disabled = busy; },
    setStatus: setProjectStatus,
  });
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
  /* The demo bundle carries its song; the sample track on disk is the fallback
   * when the bundle is unavailable or predates embedded audio. */
  const bundledAudioSha = bundledProject?.audio.source === 'embedded'
    ? bundledProject.audio.sha256
    : undefined;
  const bundledAudio = bundledAudioSha === undefined
    ? undefined
    : bundledBundle?.media.get(bundledAudioSha);
  let audioBytes: Uint8Array;
  if (bundledAudio !== undefined) {
    audioBytes = bundledAudio.bytes;
    projectAudioFile = bundledAudio;
    loadedAudioSha = bundledAudioSha ?? null;
  } else {
    const response = await fetch(TRACK_URL);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    audioBytes = new Uint8Array(await response.arrayBuffer());
  }
  const buffer = await clock.decode(audioBytes.slice().buffer as ArrayBuffer);
  clock.load(buffer);
  waveform.setPeaks(computePeaks(buffer, 1600));
  // The track line already names the song; a generic "Ready" here was noise.
  ui.audioStatus.textContent = '';

  if (bundledProject !== null) {
    applyProject(bundledProject, 'default');
    const clipCount = bundledProject.arrangement.clips.length + bundledProject.arrangement.surfaceClips.length;
    setProjectStatus(`Bundled demo: ${bundledProject.name} · ${clipCount} clips`);
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
    arrangement.setCues([
      ...createDemoCues(show.fixtures, timeline),
      ...createDemoSurfaceCues(timeline),
    ]);
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

/**
 * Programmatic control surface for automated UI checks (Playwright/agent
 * drives). Intentionally minimal and non-authoritative: it reuses the same
 * handlers the UI buttons use, so hooked actions exercise real code paths.
 *
 * ```js
 * await page.evaluate(() => window.__dmxsim.seek(45));   // jump to 45 s
 * await page.evaluate(() => window.__dmxsim.play());
 * window.__dmxsim.time;                                   // current song time
 * ```
 */
(window as unknown as { __dmxsim: unknown }).__dmxsim = {
  /** Jump to a song time in seconds (clamped to the loaded audio). */
  seek: (timeSec: number) => clock.seek(timeSec),
  play: () => clock.play(),
  pause: () => clock.pause(),
  toggle: () => clock.toggle(),
  /** Current song time in seconds; readable without triggering playback. */
  get time() {
    return clock.time;
  },
  get playing() {
    return clock.playing;
  },
  /** Total audio duration in seconds, or `null` before a track loads. */
  get duration() {
    return currentTimeline?.durationSec ?? null;
  },
  /** Active fixture count for the render budget (the `count` button cycles). */
  set fixtureCount(count: number) {
    stage.setActiveCount(count);
  },
  /** Slow auto-orbit state (the `O` shortcut / Orbit button toggles it). */
  set orbit(enabled: boolean) {
    stage.setOrbit(enabled);
    syncButtons();
  },
  get orbit() {
    return stage.orbitEnabled;
  },
  /** Camera and orbit target positions, for framing checks in test drives. */
  get camera() {
    return {
      position: stage.camera.position.toArray(),
      target: stage.controls.target.toArray(),
    };
  },
  /**
   * Measure render cost on a pinned scenario (all fixtures, orbit on).
   * Resolves with percentile frame times after restoring the previous state,
   * and appends the run to the dev-server history file.
   */
  benchmark: (options?: BenchmarkOptions) => runBenchmark(options),
  /** Persisted benchmark runs, oldest first. Empty outside the dev server. */
  benchmarkHistory: () => fetchBenchmarkHistory(),
};
