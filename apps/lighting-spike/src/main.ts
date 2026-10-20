import * as THREE from 'three/webgpu';
import {
  CLUB_STAGE,
  DEFAULT_VENUE_ID,
  evaluateFixture,
  findAnchor,
  nextFixtureId,
  parseProject,
  resolveMount,
  timeToBeat,
  venueById,
  type FixtureDefaults,
  type FixturePlacement,
  type FixtureState,
  type ProjectFile,
  type ProjectSettings,
} from '@dmxsim/show-model';
import { PROFILE_LIBRARY } from '@dmxsim/fixtures';
import { createDemoRig } from './demo-rig';
import { createDemoCues } from './demo-arrangement';
import { AudioClock } from './audio-clock';
import { loopEndSec, loopStartSec, TRACK, TRACK_URL } from './track';
import { computePeaks, WaveformStrip } from './waveform';
import demoProjectUrl from '../../../resources/sample_projects/koto-chill/koto-chill.dmxsim?url';
import {
  applyProjectFixtureSetup,
  cueTimelineFromProject,
  projectClipToCue,
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
  type CueColorOverride,
  type CueTimeline,
  type TimelineMode,
  createRuler,
} from './arrangement';
import { kelvinToCss, kelvinToRgb } from './kelvin';
import { clamp } from './lib/math';
import { PerfMonitor } from './app/perf';
import { buildProjectFile } from './project/build';
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
let projectAudio: ProjectFile['audio'] = bundledProject?.audio ?? {
  source: 'bundled',
  id: 'koto-chill',
  title: TRACK.title,
  artist: TRACK.artist,
  fileName: 'The Koto Chill.ogg',
};
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
// TEMP DEBUG
(window as unknown as { __stage: Stage }).__stage = stage;
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
  cueAction: element<HTMLSelectElement>('cue-action'),
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
type SidePanelMode = 'rig' | 'fixture';
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

/**
 * Panel header text. In rig mode the header describes the venue, so the pane
 * does not read as if a fixture were selected.
 */
const syncPanelHeader = (fixture: Fixture | null): void => {
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
): void => {
  const cue = cues[0] ?? null;
  const count = cues.length;
  const label = fixture === null ? null : arrangement.labelFor(fixture);
  ui.selectedFixture.textContent = count > 1
    ? `${count} clips selected`
    : label ?? 'None selected';
  ui.selectedFixture.classList.toggle('empty', count === 0);
  syncPanelHeader(fixture);
  renderPanelCapabilities(fixture);
  if (sidePanelOpen) sidePanelFixtureId = fixture?.id ?? null;

  // Mount options are venue data, so rebuild them with the current selection.
  const mountOptions = activeVenue.anchors.map((anchor) => {
    const option = document.createElement('option');
    option.value = anchor.id;
    option.textContent = anchor.name;
    return option;
  });
  ui.setupMount.replaceChildren(...mountOptions);

  if (fixture === null) {
    ui.setupDimmer.disabled = true;
    ui.setupYaw.disabled = true;
    ui.setupPitch.disabled = true;
    ui.setupSpread.disabled = true;
    ui.setupSpreadRow.hidden = true;
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
  }
  refreshPanelClipStats();
  renderRigList();

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
  const colorEnabled = fixture !== null && Boolean(fixture.profile.capabilities.color);
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
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues);
}, (fixture, selectedCues) => {
  syncCueInspector(fixture, selectedCues);
}, (fixtureId, hidden) => {
  stage.setFixtureHidden(fixtureId, hidden);
}, (fixture) => {
  toggleSidePanel(fixture.id);
});

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
  const canHide = filtering && show.fixtures.length > 0;
  ui.hideUnfiltered.disabled = !canHide;
  ui.hideUnfiltered.classList.toggle('on', hideUnfiltered);
  ui.hideUnfiltered.setAttribute('aria-pressed', String(hideUnfiltered));
  ui.hideUnfiltered.textContent = hideUnfiltered ? '◉' : '◌';
  ui.hideUnfiltered.title = hideUnfiltered
    ? 'Showing only the filtered fixture type in the 3D viewport'
    : 'Hide fixture types that are filtered out of the 3D viewport';
  stage.setKindFilter(hideUnfiltered && canHide ? kind : null);
};

/**
 * Rebuild the track filter from the fixtures currently in the rig, keeping a
 * still-valid choice. The filter only hides lanes; clips are untouched.
 */
const rebuildTrackFilter = (): void => {
  const kinds = [...new Set<string>(show.fixtures.map((fixture) => fixture.profile.kind))];
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
  ui.sidePanel.hidden = !sidePanelOpen;
  ui.rigPane.hidden = !rigMode;
  ui.fixturePane.hidden = rigMode;
  ui.rigMenu.classList.toggle('on', rigMode);
  ui.rigMenu.setAttribute('aria-pressed', String(rigMode));
  ui.dock.classList.toggle('has-panel', sidePanelOpen);
  syncPanelHeader(arrangement.selectedFixture);
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
    syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues);
  } else if (event.key === 'v' || event.key === 'V') {
    event.preventDefault();
    // Shift pastes at the pointer instead of the playhead, so a copied block
    // can be dropped exactly where the user is looking.
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
ui.cueDelete.addEventListener('click', () => arrangement.deleteSelected());
ui.cueCopy.addEventListener('click', () => {
  arrangement.copySelected();
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues);
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
  if (sidePanelOpen) refreshPanelClipStats();
};

const frame = (now: number): void => {
  const workStart = performance.now();
  perf.sampleFrame(now);

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
  perf.sampleCpu(cpuMs);
  perf.adjustResolution(now);
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
  stage.setOrbit(local.orbit ?? false);

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
  return buildProjectFile({
    name: projectName,
    description: projectDescription,
    venue: { id: activeVenue.id, name: activeVenue.name },
    show: { name: show.name, fixtures: show.fixtures },
    timeline,
    loop: loopRegion,
    cues,
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

const saveProject = (): void => {
  saveProjectFile({ build: buildProject, setStatus: setProjectStatus });
};

const openProject = async (file: File): Promise<void> => {
  await openProjectFile({
    file,
    hasAudio: () => currentTimeline !== null && clock.duration > 0,
    rigMatches: (project) => rigMatches(project, show.fixtures),
    apply: applyProject,
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
};
