import * as THREE from 'three/webgpu';
import {
  CLUB_STAGE,
  DEFAULT_LASER_SETUP,
  DEFAULT_VENUE_ID,
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
  type LaserSetup,
  type LedSurface,
  type ProjectBundle,
  type ProjectFile,
  type ProjectMediaFile,
  type ProjectSettings,
} from '@dmxsim/show-model';
import type { LedPlaybackLayer } from './led/led-wall';
import { LedMediaLibrary } from './led/media';
import { lookDefinition } from './led/look-definitions';
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
import { analyzeAudioBuffer, type TempoCandidate } from './audio-analysis';
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
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  PIXELS_PER_SECOND,
  TRACK_LABEL_WIDTH,
  type Cue,
  type CueTimeline,
  type TimelineMode,
  createRuler,
} from './arrangement';
import {
  barBeatLabel,
  barLengthSec,
  formatClock,
  showTime,
  snapTimeToBar,
  snapTimeToGrid,
} from './arrangement/time';
import {
  activeCuesAt,
  activeFixtureCuesAt,
  cuesForLane,
  indexCuesByLane,
  latestActiveEndSec,
  type CueIndex,
} from './arrangement/active';
import { wallPlaybackLayers } from './led/playback';
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
import { collectUi } from './ui/elements';
import {
  bootFailed,
  readWithProgress,
  setBootStatus,
} from './ui/boot-status';
import { installKeyboardShortcuts } from './ui/keyboard';
import { enhanceSlider, parseNumericText } from './ui/slider';
import { setupPhotosensitivityNotice } from './ui/photosensitivity';
import { createTimingEditor } from './ui/timing-editor';
import { createColorPicker } from './ui/color-picker';
import { installLookEditor } from './ui/look-editor';
import { Stage } from './stage';
import { Post } from './post';

// Shown before the async startup below so a first visit sees the notice
// immediately rather than after the renderer and project bundle are ready.
setupPhotosensitivityNotice();

/* Startup is a chain of top-level awaits, so an unhandled rejection or a thrown
 * error would leave the `#loading` overlay up with stale text and no hint about
 * what broke. On a hosted build the common cases are a browser without WebGPU
 * or WebGL2, and a failed asset request. */
window.addEventListener('error', (event) => {
  bootFailed('Could not start Lightshow Studio', event.error ?? event.message);
});
window.addEventListener('unhandledrejection', (event) => {
  bootFailed('Could not start Lightshow Studio', event.reason);
});

/**
 * The demo is a project bundle, not generated code: the app loads
 * `resources/sample_projects/koto-chill/koto-chill.dmxsim` at startup so the
 * show (and its audio) can be replaced as a single file. The procedural
 * rig/cues remain as a fallback if the bundle is missing or invalid.
 */
const loadBundledProject = async (): Promise<ProjectBundle | null> => {
  try {
    setBootStatus('Loading demo project…');
    const response = await fetch(demoProjectUrl);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await readProjectBundle(await readWithProgress(response, 'Loading demo project'));
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

setBootStatus('Starting renderer…');
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
/* Draw a few dim frames with every fixture lit before playback is possible.
 * Fixtures are lazily drawn, so without this the first cue that brings a group
 * in (in the demo, all heads/lasers/strobes at measure 5) pays the one-time
 * pipeline cost as a single long frame. */
stage.warmup();
const clock = new AudioClock();
const cryoAudio = new CryoJetAudio(clock);
void cryoAudio.load(cryoJetSfxUrl);
clock.setLoop({ startSec: loopStartSec, endSec: loopEndSec }, true);

let volumetrics = true;
let bloomOn = true;
let strobesOn = true;
/** Fixtures rendered from the top of the rig. No UI sets this any more; it is
 * always the whole rig, and only the benchmark rewinds it temporarily. */
let activeCount = show.fixtures.length;

stage.setActiveCount(activeCount);

const ui = collectUi();

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
  const trackCues = fixture === null ? [] : cuesForLane(cuesByFixture, fixture.id);
  ui.panelClipCount.textContent = String(trackCues.length);
  ui.panelClipActive.textContent = String(activeCuesAt(trackCues, clock.time).length);
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
    ui.panelFixtureMeta.textContent = `${show.fixtures.length} light${show.fixtures.length === 1 ? '' : 's'}`;
    return;
  }

  ui.panelFixtureKind.textContent = fixture === null ? 'Fixture' : kindLabel(fixture.profile.kind);
  ui.panelFixtureName.textContent = fixture === null
    ? 'No fixture selected'
    : arrangement.labelFor(fixture);
  ui.panelFixtureMeta.textContent = fixture === null
    ? 'Click a track name to open this panel'
    : '';
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
  /* Select mode edits existing clips only, so with an empty selection every
     clip-scoped control here is inert. Drop mode is different: action and
     colour are the defaults the next drawn clip inherits, so they stay. */
  const selectModeEmpty = arrangement.timelineMode === 'select' && count === 0;
  (ui.selectedFixture.parentElement as HTMLElement).hidden = selectModeEmpty;
  (ui.cueAction.parentElement as HTMLElement).hidden = isSurface || selectModeEmpty;
  (ui.cueCopy.parentElement as HTMLElement).hidden = selectModeEmpty;
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

  /* One compact button carries the summary; the popover does the editing. */
  timingEditor.sync(isSurface ? null : cue, fixture);

  const colorEnabled = !isSurface && fixture !== null && Boolean(fixture.profile.capabilities.color);
  // Do not show a disabled colour picker for fixtures that cannot mix colour,
  // or one that would edit nothing while select mode has nothing selected.
  ui.cueColorField.hidden = !colorEnabled || selectModeEmpty;
  if (!colorEnabled) colorPicker.close();
  const override = cue?.colorOverride ?? (cue === null ? arrangement.suggestedColorOverride ?? undefined : undefined);
  colorPicker.sync(cue?.colorIndex ?? arrangement.suggestedColorIndex, override, colorEnabled);
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

let cuesByFixture: CueIndex = new Map();
const indexCues = (): void => {
  cuesByFixture = indexCuesByLane(cues);
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

/**
 * The inspector popovers own their markup and wiring; they are created here,
 * before the first selection fires, so `syncCueInspector` can call into them.
 */
const timingEditor = createTimingEditor({
  ui,
  arrangement,
  getTimeline: () => currentTimeline,
});
const colorPicker = createColorPicker({ ui, arrangement });
installLookEditor({ ui, arrangement, media });

// --- Timeline modes (drop / select) ---------------------------------------

const TIMELINE_MODE_KEY = STORAGE_KEYS.timelineMode;

/**
 * Re-syncs the tools bar after a mode switch. `applyTimelineMode` also runs
 * during module boot, before `syncCueInspector`'s dependencies (for example
 * `renderRigList`) are initialised, so the call is installed later.
 */
let syncInspectorForMode: (() => void) | null = null;

const applyTimelineMode = (mode: TimelineMode, persist = true): void => {
  arrangement.setMode(mode);
  const dropMode = mode === 'drop';
  ui.modeDrop.setAttribute('aria-pressed', String(dropMode));
  ui.modeSelect.setAttribute('aria-pressed', String(!dropMode));
  ui.modeDrop.classList.toggle('on', dropMode);
  ui.modeSelect.classList.toggle('on', !dropMode);
  if (!dropMode) ui.arrangementScroll.classList.remove('loop-mode');
  if (persist) writePreference(TIMELINE_MODE_KEY, mode);
  // Select mode hides the clip-scoped tools while nothing is selected, so the
  // bar has to be rebuilt for the new mode rather than waiting for a click.
  syncInspectorForMode?.();
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
  (fixture) => kindLabel(fixture.profile.kind),
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
  if (rebuildRigs) {
    stage.setShow(show);
    /* New rigs mean new materials; warm them before the next cue draws them. */
    stage.warmup();
  }
  arrangement.setFixtures(fixtures);
  rebuildTrackFilter();
  ui.trackFilter.disabled = fixtures.length === 0;
  /* The rig shrank: never leave fixtures hidden that no longer exist. */
  if (activeCount > show.fixtures.length) setActiveCount(show.fixtures.length);
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
  strobes?: boolean;
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
  strobes: strobesOn,
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
 * The camera-mode pill always sits on the viewport: "Orbit on" while the
 * auto-orbit follows playback, "Orbit off" when it is off. The underlined `O`
 * doubles as the hotkey hint, so no separate key badge is needed.
 */
let orbitPillState = '';
const updateOrbitPill = (): void => {
  const state = stage.orbitEnabled ? 'orbit' : 'static';
  if (state === orbitPillState) return;
  orbitPillState = state;
  ui.orbitPill.dataset.state = state;
  ui.orbitPill.setAttribute('aria-pressed', String(state === 'orbit'));
  ui.orbitPillLabel.innerHTML = `<u>O</u>rbit ${state === 'orbit' ? 'on' : 'off'}`;
};

const syncButtons = (): void => {
  ui.play.classList.toggle('on', clock.playing);
  ui.play.textContent = clock.playing ? '❚❚ Pause' : '▶ Play';
  ui.loop.textContent = clock.loopEnabled ? 'on' : 'off';
  ui.vol.classList.toggle('on', volumetrics);
  ui.bloom.classList.toggle('on', bloomOn);
  ui.grain.classList.toggle('on', post.grain);
  ui.audience.classList.toggle('on', stage.audienceVisible);
  ui.strobe.classList.toggle('on', strobesOn);
  ui.strobeStatus.textContent = strobesOn ? 'on' : 'off';
  ui.haze.value = String(Math.round(stage.hazeLevel * 100));
  ui.hazeValue.textContent = String(Math.round(stage.hazeLevel * 100));
  updateOrbitPill();
  persistRender();
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

/* The orbit chip is a button as well as a status badge, mirroring the `o`
 * shortcut. */
ui.orbitPill.addEventListener('click', () => {
  stage.toggleOrbit();
  syncButtons();
});

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

/** Timeline world width in CSS px at the current zoom. */
const timelineWidth = (): number =>
  currentTimeline === null ? 0 : currentTimeline.durationSec * arrangement.zoomLevel;

/** Visible time-axis width, excluding the sticky track labels. */
const timeAxisViewportWidth = (): number =>
  Math.max(1, ui.arrangementScroll.clientWidth - labelWidth());

/**
 * The ruler/waveform tracks stay full-song wide (so the playheads and layout
 * hold), while their canvases are only one viewport wide. A full-song canvas
 * exceeds the browser's maximum canvas dimension on long songs at high zoom,
 * which used to paint blank.
 */
const setTimeAxisWidth = (width: number): void => {
  const px = `${Math.max(1, Math.round(width))}px`;
  const rulerTrack = ui.ruler.parentElement;
  const waveformTrack = ui.waveform.parentElement;
  // Avoid style writes (and the layout they dirty) when nothing changed.
  if (rulerTrack !== null && rulerTrack.style.width !== px) rulerTrack.style.width = px;
  if (waveformTrack !== null && waveformTrack.style.width !== px) waveformTrack.style.width = px;
};

/** Repaint the visible ruler and waveform at the current zoom/scroll. */
let timeAxisFrame = 0;
let timeAxisScrollLeft = -1;

const paintTimeAxis = (): void => {
  if (currentTimeline === null) return;
  setTimeAxisWidth(timelineWidth());
  const scrollLeft = ui.arrangementScroll.scrollLeft;
  const viewportWidth = timeAxisViewportWidth();
  timeAxisScrollLeft = scrollLeft;
  waveform.setViewport(viewportWidth, arrangement.zoomLevel, scrollLeft);
  waveform.paint();
  createRuler(ui.ruler, currentTimeline, arrangement.zoomLevel, viewportWidth, scrollLeft);
};

const requestTimeAxisPaint = (): void => {
  if (timeAxisFrame !== 0) return;
  timeAxisFrame = requestAnimationFrame(() => {
    timeAxisFrame = 0;
    paintTimeAxis();
  });
};
ui.arrangementScroll.addEventListener('scroll', () => {
  // Vertical scrolling cannot change the painted window.
  if (ui.arrangementScroll.scrollLeft === timeAxisScrollLeft) return;
  requestTimeAxisPaint();
}, { passive: true });
// Scrollbar appearance, panel changes and window resizes alter the visible
// width without moving the scroll offset.
new ResizeObserver(() => requestTimeAxisPaint()).observe(ui.arrangementScroll);

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

/** M key: flip mute without persisting the change. */
const toggleMute = (): void => {
  muted = !muted;
  applyVolume(false);
};

ui.volume.addEventListener('input', () => {
  volume = Number(ui.volume.value) / 100;
  muted = false;
  applyVolume();
});
applyVolume(false);

// --- View preferences (persisted) -----------------------------------------
const STATS_KEY = STORAGE_KEYS.stats;
/** Render stats start hidden; only an explicit "on" from the user shows them. */
let statsVisible = readPreference(STATS_KEY) === 'on';
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
    paintTimeAxis();
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
  paintTimeAxis();
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

/** Zoom that fits the whole current timeline into the scroll viewport. */
const fitZoom = (): number => {
  if (currentTimeline === null) return MIN_PIXELS_PER_SECOND;
  const trackWidth = labelWidth();
  const availableWidth = Math.max(1, ui.arrangementScroll.clientWidth - trackWidth - 18);
  return availableWidth / currentTimeline.durationSec;
};

/** Smallest useful zoom: below it the whole show is already visible. */
const minZoom = (): number => Math.max(MIN_PIXELS_PER_SECOND, fitZoom());

/** Zoom out one step, but never further than the fit zoom. */
const zoomOut = (zoom: number): number => Math.max(minZoom(), zoom);

/** Log slider range, recomputed per call so the low end tracks the fit zoom. */
const zoomRange = (): number => MAX_PIXELS_PER_SECOND / minZoom();
const zoomToSlider = (zoom: number): number =>
  Math.round((Math.log(zoom / minZoom()) / Math.log(zoomRange())) * ZOOM_SLIDER_STEPS);
const sliderToZoom = (value: number): number =>
  minZoom() * Math.pow(zoomRange(), value / ZOOM_SLIDER_STEPS);

const setZoom = (nextZoom: number, anchorClientX?: number): void => {
  if (currentTimeline === null) return;
  const previousZoom = arrangement.zoomLevel;
  // Only the explicit zoom-out paths clamp to the fit zoom; loading a
  // project at its stored zoom must not be pushed around by a stale layout.
  const zoom = Math.max(MIN_PIXELS_PER_SECOND, Math.min(MAX_PIXELS_PER_SECOND, nextZoom));
  const trackWidth = labelWidth();
  const bounds = ui.arrangementScroll.getBoundingClientRect();
  const anchorX = anchorClientX === undefined
    ? Math.max(trackWidth, ui.arrangementScroll.clientWidth / 2)
    : Math.max(trackWidth, anchorClientX - bounds.left);
  const anchorTime = Math.max(0, ui.arrangementScroll.scrollLeft + anchorX - trackWidth) / previousZoom;
  arrangement.setZoom(zoom);
  ui.zoomLevel.value = String(zoomToSlider(zoom));
  ui.zoomPercent.textContent = `${Math.round((zoom / PIXELS_PER_SECOND) * 100)}%`;
  const nextScroll = Math.max(0, anchorTime * zoom + trackWidth - anchorX);
  ui.arrangementScroll.scrollLeft = nextScroll;
  scrollMetrics.left = nextScroll;
  paintTimeAxis();
  setRulerPlayhead(clock.time * zoom);
};

const setRulerPlayhead = (x: number): void => {
  ui.rulerPlayhead.style.transform = `translate3d(${x}px, 0, 0)`;
};
const setWaveformPlayhead = (x: number): void => {
  ui.waveformPlayhead.style.transform = `translate3d(${x}px, 0, 0)`;
};
ui.zoomIn.addEventListener('click', () => setZoom(arrangement.zoomLevel * 1.25));
ui.zoomOut.addEventListener('click', () => setZoom(zoomOut(arrangement.zoomLevel * 0.8)));
ui.zoomLevel.addEventListener('input', () => setZoom(sliderToZoom(Number(ui.zoomLevel.value))));
ui.zoomFit.addEventListener('click', () => {
  if (currentTimeline === null) return;
  const trackWidth = labelWidth();
  const availableWidth = Math.max(1, ui.arrangementScroll.clientWidth - trackWidth - 18);
  setZoom(fitZoom(), trackWidth + availableWidth / 2);
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
  setZoom(factor < 1 ? zoomOut(arrangement.zoomLevel * factor) : arrangement.zoomLevel * factor, event.clientX);
}, { passive: false });

const MIN_LOOP_SEC = 0.25;

/** Arrow-key seek: one 1/16 by default, one bar with Shift. */
const seekBy = (direction: 1 | -1, coarse: boolean): void => {
  const timeline = currentTimeline;
  if (timeline === null) return;
  const bpm = timeline.bpm;
  const stepSec = bpm !== null && bpm > 0
    ? (coarse ? (60 / bpm) * timeline.beatsPerBar : 60 / bpm / 4)
    : (coarse ? 5 : 1);
  clock.seek(snapTimeToGrid(timeline, clock.time) + direction * stepSec);
};

const showTimelineTooltip = (event: PointerEvent, timeSec: number, hint: string): void => {
  ui.tooltip.hidden = false;
  ui.tooltip.textContent = `${barBeatLabel(currentTimeline, timeSec)} · ${formatClock(timeSec)} · ${hint}`;
  ui.tooltip.style.left = `${event.clientX + 14}px`;
  ui.tooltip.style.top = `${event.clientY + 16}px`;
};
const hideTimelineTooltip = (): void => {
  ui.tooltip.hidden = true;
};
ui.waveform.addEventListener('pointermove', (event) => {
  const scrollLeft = ui.arrangementScroll.scrollLeft;
  ui.waveformHover.hidden = false;
  ui.waveformHover.style.transform = `translate3d(${event.offsetX + scrollLeft}px, 0, 0)`;
  showTimelineTooltip(event, (event.offsetX + scrollLeft) / arrangement.zoomLevel, 'click to seek');
});
ui.waveform.addEventListener('pointerleave', () => {
  ui.waveformHover.hidden = true;
  hideTimelineTooltip();
});
ui.ruler.addEventListener('pointermove', (event) => {
  const scrollLeft = ui.arrangementScroll.scrollLeft;
  showTimelineTooltip(event, (event.offsetX + scrollLeft) / arrangement.zoomLevel, 'click to seek · Shift-drag for loop');
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

/** A region covering the whole song is the "no loop" state set by `L`. */
const hasLoopRegion = (): boolean => {
  const timeline = currentTimeline;
  if (timeline === null) return false;
  return loopRegion.startSec > 1e-3
    || loopRegion.endSec < timeline.durationSec - 1e-3;
};

const updateLoopUi = (): void => {
  const hasRegion = hasLoopRegion();
  const enabled = hasRegion && clock.loopEnabled;
  ui.loopBtn.classList.toggle('on', enabled);
  ui.loopBtn.setAttribute('aria-pressed', String(enabled));
  const range = hasRegion ? loopRangeLabel() : '';
  ui.loopBtn.textContent = !hasRegion ? 'No loop' : enabled ? `Loop ${range}` : 'Loop off';
  ui.loopBtn.title = !hasRegion
    ? 'No loop · Shift-drag the ruler, waveform or a lane to draw one'
    : `${enabled ? 'Looping' : 'Loop off'}${range === '' ? '' : ` ${range}`} · L removes the loop`;
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
    paintTimeAxis();
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

/** `L` removes the loop: the whole song plays free and nothing is shaded out. */
const clearLoop = (): void => {
  const timeline = currentTimeline;
  if (timeline === null) return;
  clock.setLoopEnabled(false);
  setLoopRegion(0, timeline.durationSec);
  updateLoopUi();
  syncButtons();
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

/** Begin replacing the loop from `timeSec`, opened as one full measure. */
const beginLoopDraw = (timeSec: number): void => {
  const timeline = currentTimeline;
  if (timeline === null) return;
  const barSec = barLengthSec(currentTimeline);
  const anchor = Math.min(snapTimeToBar(currentTimeline, timeSec), Math.max(0, timeline.durationSec - barSec));
  loopGesture = { edge: 'new', anchorSec: anchor };
  setLoopRegion(anchor, Math.min(timeline.durationSec, anchor + barSec), false);
};

/** Extend the loop being drawn; both edges stay on measure lines. */
const updateLoopDraw = (timeSec: number): void => {
  if (loopGesture === null || loopGesture.edge !== 'new' || currentTimeline === null) return;
  const barSec = barLengthSec(currentTimeline);
  const anchor = loopGesture.anchorSec;
  const time = snapTimeToBar(currentTimeline, timeSec);
  let start = Math.min(anchor, time);
  let end = Math.max(anchor, time);
  if (end - start < barSec - 1e-6) {
    if (time < anchor) start = end - barSec;
    else end = start + barSec;
  }
  setLoopRegion(start, end, false);
};

const rulerTimeAt = (clientX: number): number => {
  const timeline = currentTimeline;
  if (timeline === null) return 0;
  const rect = ui.arrangementScroll.getBoundingClientRect();
  const x = clientX - rect.left - labelWidth() + ui.arrangementScroll.scrollLeft;
  return Math.max(0, Math.min(timeline.durationSec, x / Math.max(1e-6, arrangement.zoomLevel)));
};

/** Viewport x of a song time, relative to the ruler canvas's left edge. */
const rulerXFor = (timeSec: number): number =>
  timeSec * arrangement.zoomLevel - ui.arrangementScroll.scrollLeft;

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
    beginLoopDraw(rulerTimeAt(event.clientX));
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
  const time = snapTimeToGrid(currentTimeline, rulerTimeAt(event.clientX));
  if (loopGesture === null) {
    clock.seek(time);
    return;
  }
  if (loopGesture.edge === 'start') {
    setLoopRegion(Math.min(time, loopGesture.anchorSec - MIN_LOOP_SEC), loopGesture.anchorSec, false);
  } else if (loopGesture.edge === 'end') {
    setLoopRegion(loopGesture.anchorSec, Math.max(time, loopGesture.anchorSec + MIN_LOOP_SEC), false);
  } else {
    updateLoopDraw(rulerTimeAt(event.clientX));
  }
});

const endLoopGesture = (event: PointerEvent): void => {
  const gesture = loopGesture;
  loopGesture = null;
  if (ui.ruler.hasPointerCapture(event.pointerId)) ui.ruler.releasePointerCapture(event.pointerId);
  if (gesture === null) return;
  // A newly drawn loop becomes the active loop, even after `L` cleared it.
  if (gesture.edge === 'new') clock.setLoopEnabled(true);
  applyLoop(true);
};
ui.ruler.addEventListener('pointerup', endLoopGesture);
ui.ruler.addEventListener('pointercancel', endLoopGesture);

// Shift+drag anywhere in the timeline (ruler, waveform, or a fixture lane)
// draws a loop. Capture phase keeps the lane/waveform gesture handlers out of it.
const isPointing = (target: Element, event: PointerEvent): boolean =>
  target.hasPointerCapture(event.pointerId);

const isTimeAxisTarget = (target: EventTarget | null): boolean =>
  target === ui.ruler
  || target === ui.waveform
  || (target instanceof Element && target.closest('.ruler-track') !== null);

ui.arrangementScroll.addEventListener('pointerdown', (event) => {
  // Select mode reserves Shift for additive card selection, but the ruler and
  // waveform are not clip surfaces: Shift-drag there always draws a loop.
  if (arrangement.timelineMode === 'select' && !isTimeAxisTarget(event.target)) return;
  if (!event.shiftKey || currentTimeline === null) return;
  event.preventDefault();
  event.stopPropagation();
  beginLoopDraw(rulerTimeAt(event.clientX));
  ui.arrangementScroll.setPointerCapture(event.pointerId);
}, { capture: true });

ui.arrangementScroll.addEventListener('pointermove', (event) => {
  if (loopGesture === null || loopGesture.edge !== 'new' || currentTimeline === null) return;
  if (!isPointing(ui.arrangementScroll, event)) return;
  updateLoopDraw(rulerTimeAt(event.clientX));
});

const endScrollLoopGesture = (event: PointerEvent): void => {
  if (loopGesture === null || loopGesture.edge !== 'new') return;
  loopGesture = null;
  if (ui.arrangementScroll.hasPointerCapture(event.pointerId)) {
    ui.arrangementScroll.releasePointerCapture(event.pointerId);
  }
  // A newly drawn loop becomes the active loop, even after `L` cleared it.
  clock.setLoopEnabled(true);
  applyLoop(true);
  syncButtons();
};
ui.arrangementScroll.addEventListener('pointerup', endScrollLoopGesture);
ui.arrangementScroll.addEventListener('pointercancel', endScrollLoopGesture);

const setLoopMode = (on: boolean): void => {
  const drop = arrangement.timelineMode === 'drop';
  ui.arrangementScroll.classList.toggle('loop-mode', on && drop);
  ui.ruler.classList.toggle('loop-mode', on && !drop);
  ui.waveform.classList.toggle('loop-mode', on && !drop);
};
window.addEventListener('keydown', (event) => {
  if (event.key === 'Shift') setLoopMode(true);
});
window.addEventListener('keyup', (event) => {
  if (event.key === 'Shift') setLoopMode(false);
});
window.addEventListener('blur', () => setLoopMode(false));

const selectedAction = () => arrangement.selectedActions.find((action) => action === ui.cueAction.value)
  ?? arrangement.suggestedAction;
ui.cueAction.addEventListener('change', () => {
  const action = selectedAction();
  arrangement.setPendingAction(action);
  arrangement.setSelectedAction(action);
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

  const wallCues = cuesForLane(cuesByFixture, surface.id);
  ui.panelSurfaceCount.textContent = String(wallCues.length);
  ui.panelSurfaceActive.textContent = String(activeCuesAt(wallCues, clock.time).length);
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

// --- Slider ergonomics -----------------------------------------------------
// Drags snap to ~5% of the track and the readout next to each slider accepts a
// typed exact value (Enter commits, Escape cancels). Arrow keys keep their
// native fine step, so nothing extra is needed for precision.

/** Readout shows beam degrees while the slider stores 0..1 zoom. */
const parseSpreadText = (text: string): number | null => {
  const fixture = arrangement.selectedFixture;
  const degrees = parseNumericText(text);
  if (fixture === null || degrees === null) return null;
  const [spreadMin, spreadMax] = fixture.profile.beam.spreadDeg;
  return spreadMax === spreadMin ? null : ((degrees - spreadMin) / (spreadMax - spreadMin)) * 100;
};

for (const [input, output] of [
  [ui.haze, ui.hazeValue],
  [ui.setupPosition, ui.setupPositionValue],
  [ui.setupYaw, ui.setupYawValue],
  [ui.setupPitch, ui.setupPitchValue],
  [ui.setupDimmer, ui.setupDimmerValue],
  [ui.setupSpread, ui.setupSpreadValue],
  [ui.setupLaserFan, ui.setupLaserFanValue],
  [ui.surfaceWidth, ui.surfaceWidthValue],
  [ui.surfaceHeight, ui.surfaceHeightValue],
  [ui.surfacePitch, ui.surfacePitchValue],
  [ui.surfaceGap, ui.surfaceGapValue],
  [ui.surfaceBrightness, ui.surfaceBrightnessValue],
  [ui.surfaceBlack, ui.surfaceBlackValue],
  [ui.surfaceEmit, ui.surfaceEmitValue],
] as Array<[HTMLInputElement, HTMLElement]>) {
  enhanceSlider(input, output, input === ui.setupSpread ? { parse: parseSpreadText } : {});
}
enhanceSlider(ui.setupLaserBeams, ui.setupLaserBeamsValue, { snap: 1 });
enhanceSlider(ui.surfaceGamma, ui.surfaceGammaValue, {
  snap: 1,
  parse: (text) => {
    const value = parseNumericText(text);
    return value === null ? null : value * 10;
  },
});
// Volume has no numeric readout; snapping alone is enough there.
enhanceSlider(ui.volume);

const copySelection = (): void => {
  arrangement.copySelected();
  syncCueInspector(arrangement.selectedFixture, arrangement.selectedCues, arrangement.selectedSurface);
};

ui.cueDelete.addEventListener('click', () => arrangement.deleteSelected());
ui.cueCopy.addEventListener('click', copySelection);
ui.cuePaste.addEventListener('click', () => arrangement.paste());
ui.trackFilter.addEventListener('change', () => {
  applyTrackFilter();
});
ui.hideUnfiltered.addEventListener('click', () => {
  hideUnfiltered = !hideUnfiltered;
  applyTrackFilter();
});
/** Audio chosen in the import dialog, kept until the dialog is confirmed. */
interface PendingAudio {
  buffer: AudioBuffer;
  bytes: Uint8Array;
  fileName: string;
  mime: string;
}

type ImportMode = 'new' | 'edit';

let importMode: ImportMode = 'new';
let pendingAudio: PendingAudio | null = null;
/** Candidate tempos from the last analysis, in the order they were found. */
let pendingCandidates: TempoCandidate[] = [];
/** Bumped on every file choice so a slow decode cannot overwrite a newer one. */
let analysisToken = 0;

/**
 * The dialog is used for two things: creating a project (a song is required)
 * and editing the open one (the song is optional, and leaving it alone keeps
 * the arrangement). Only replacing the song of an existing project loses work,
 * so that warning has its own line and is shown only then.
 */
const updateImportWarning = (): void => {
  const replacingSong = importMode === 'edit' && pendingAudio !== null;
  ui.newProjectWarning.hidden = !replacingSong;
  ui.newProjectWarning.textContent = replacingSong
    ? 'Replacing the song clears the clips in the open project.'
    : '';
};

/**
 * Preview the loop the values above will create.
 *
 * Duration, tempo, offset and beats-per-bar are already on screen (in the
 * analysis line and in the fields themselves), so repeating them here only
 * made the dialog read like a log dump. The loop region is the one derived
 * result the user cannot see yet.
 */
const updateNewProjectSummary = (): void => {
  const audio = pendingAudio;
  const durationSec = audio?.buffer.duration ?? currentTimeline?.durationSec ?? 0;
  const bpm = Number(ui.newProjectBpm.value);
  const offset = Number(ui.newProjectOffset.value);
  const beats = ui.newProjectBeats.value === '3' ? 3 : 4;
  if (!(Number.isFinite(bpm) && bpm > 0) || durationSec <= 0) {
    ui.newProjectSummary.textContent = 'No beat grid — clips are placed by time only.';
    updateImportWarning();
    return;
  }
  const barSec = (60 / bpm) * beats;
  const firstBeat = Number.isFinite(offset) ? offset : 0;
  const bars = Math.min(16, Math.max(1, Math.floor((durationSec - firstBeat) / barSec)));
  const loopStart = Math.max(0, Math.min(firstBeat, durationSec - barSec));
  const loopEnd = Math.min(durationSec, loopStart + bars * barSec);
  ui.newProjectSummary.textContent = bars === 1
    ? `Loop: 1 bar (${formatClock(loopStart)}–${formatClock(loopEnd)}).`
    : `Loop: ${bars} bars (${formatClock(loopStart)}–${formatClock(loopEnd)}).`;
  updateImportWarning();
};

/**
 * Show the analysed tempos as one-click buttons.
 *
 * Tempo detection is genuinely ambiguous (half time, double time, 3:2), so the
 * dialog never forces the user to type a number when a relative is the answer.
 * The button matching the current BPM field is marked pressed, which also makes
 * the ÷2 / ×2 state obvious after a correction.
 */
const renderCandidates = (): void => {
  const container = ui.newProjectCandidates;
  const current = Number(ui.newProjectBpm.value);
  container.replaceChildren();
  if (pendingCandidates.length === 0) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const label = document.createElement('span');
  label.className = 'np-candidates-label';
  label.textContent = 'Tempo options';
  container.append(label);
  for (const candidate of pendingCandidates) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = candidate.bpm.toFixed(candidate.bpm < 100 ? 2 : 1);
    button.title = describeCandidate(candidate);
    button.setAttribute(
      'aria-pressed',
      String(Number.isFinite(current) && Math.abs(current - candidate.bpm) < 0.05),
    );
    button.addEventListener('click', () => {
      ui.newProjectBpm.value = candidate.bpm.toFixed(2);
      ui.newProjectOffset.value = candidate.offsetSec.toFixed(3);
      renderCandidates();
      updateNewProjectSummary();
    });
    container.append(button);
  }
};

/** Tooltip text for a candidate: how it relates to the best guess. */
const describeCandidate = (candidate: TempoCandidate): string => {
  if (candidate.relation === 1) return 'Best guess';
  if (candidate.relation === 2) return 'Double time';
  if (candidate.relation === 0.5) return 'Half time';
  if (candidate.relation === 3) return 'Triple time';
  if (candidate.relation === 1 / 3) return 'One third time';
  if (candidate.relation === 4) return 'Quadruple time';
  if (candidate.relation === 0.25) return 'Quarter time';
  if (candidate.relation === 1.5) return 'Three against two';
  if (candidate.relation === 0.75) return 'Three quarters';
  if (candidate.relation === 2 / 3) return 'Two thirds';
  return 'Also fits the audio';
};

const openProjectDialog = (mode: ImportMode): void => {
  importMode = mode;
  analysisToken += 1;
  pendingAudio = null;
  pendingCandidates = [];
  renderCandidates();
  ui.newProjectDialog.returnValue = 'cancel';
  ui.newProjectAudio.value = '';

  const editing = mode === 'edit';
  const timeline = currentTimeline;
  ui.newProjectDialog.setAttribute('aria-label', editing ? 'Edit project' : 'New project');
  ui.newProjectTitle.textContent = editing ? 'Edit project' : 'New project';
  ui.newProjectNameRow.hidden = false;
  ui.newProjectName.value = editing ? projectName : 'Untitled project';
  ui.newProjectAudioLabel.textContent = editing ? 'Replace song (optional)' : 'Audio file';
  ui.newProjectBpm.value = editing && timeline?.bpm != null ? timeline.bpm.toFixed(2) : '';
  ui.newProjectOffset.value = editing ? (timeline?.firstBeatSec ?? 0).toFixed(3) : '0';
  ui.newProjectBeats.value = editing && timeline?.beatsPerBar === 3 ? '3' : '4';
  ui.newProjectAnalysis.textContent = editing
    ? `Current song: ${describeAudio(projectAudio, timeline?.bpm ?? null)}. Choose a file to replace it.`
    : 'Choose an audio file to detect its beat grid.';
  ui.newProjectCreate.textContent = editing ? 'Save changes' : 'Create project';
  // Editing needs no new file, so the action is available immediately.
  ui.newProjectCreate.disabled = !editing;
  updateNewProjectSummary();
  ui.newProjectDialog.showModal();
};

ui.projectEdit.addEventListener('click', () => openProjectDialog('edit'));
ui.projectNew.addEventListener('click', () => openProjectDialog('new'));

ui.newProjectAudio.addEventListener('change', () => {
  const file = ui.newProjectAudio.files?.[0];
  if (file === undefined) return;
  const token = analysisToken + 1;
  analysisToken = token;
  pendingAudio = null;
  ui.newProjectCreate.disabled = true;
  ui.newProjectAnalysis.textContent = `Decoding ${file.name}…`;
  ui.newProjectSummary.textContent = '';
  updateImportWarning();

  void (async () => {
    try {
      const data = await file.arrayBuffer();
      // `decodeAudioData` detaches its input, so keep the bytes for saving.
      const bytes = new Uint8Array(data.slice(0));
      const buffer = await clock.decode(data);
      if (token !== analysisToken) return;
      pendingAudio = {
        buffer,
        bytes,
        fileName: file.name,
        mime: file.type === '' ? 'application/octet-stream' : file.type,
      };

      ui.newProjectAnalysis.textContent = 'Analysing beat grid…';
      const analysis = analyzeAudioBuffer(buffer);
      if (token !== analysisToken) return;

      const duration = formatClock(buffer.duration);
      pendingCandidates = analysis.candidates;
      if (analysis.bpm === null) {
        ui.newProjectBpm.value = '';
        ui.newProjectOffset.value = '0';
        /*
         * Only silence or a clip too short to frame gets here. Wording matches
         * the real reason, because the usual cause (a tempo outside the search
         * range, or a weak pulse) no longer produces a null result.
         */
        ui.newProjectAnalysis.textContent =
          `${duration} · no pulse found in this audio; enter the BPM by hand.`;
      } else {
        ui.newProjectBpm.value = analysis.bpm.toFixed(2);
        ui.newProjectOffset.value = analysis.offsetSec.toFixed(3);
        const confidence = analysis.confidence < 0.35 ? ' · low confidence, please check' : '';
        const others =
          analysis.candidates.length > 1 ? ' · other tempos fit this audio' : '';
        ui.newProjectAnalysis.textContent =
          `${duration} · detected ${analysis.bpm.toFixed(1)} BPM, first beat ${analysis.offsetSec.toFixed(3)} s${confidence}${others}`;
      }
      renderCandidates();

      if (importMode === 'new' && ui.newProjectName.value === 'Untitled project') {
        const title = file.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
        if (title !== '') ui.newProjectName.value = title;
      }
      ui.newProjectCreate.disabled = false;
      updateNewProjectSummary();
    } catch (error) {
      if (token !== analysisToken) return;
      console.error(`could not analyse audio file "${file.name}"`, error);
      ui.newProjectAnalysis.textContent = `Could not read ${file.name}; choose another file.`;
    }
  })();
});

for (const control of [ui.newProjectBpm, ui.newProjectOffset, ui.newProjectBeats]) {
  control.addEventListener('input', updateNewProjectSummary);
  control.addEventListener('change', updateNewProjectSummary);
}
// Typing a BPM by hand should also update which tempo option reads as active.
ui.newProjectBpm.addEventListener('input', renderCandidates);
ui.newProjectBpm.addEventListener('change', renderCandidates);

/**
 * Apply freshly imported audio: replace the song, set its beat grid and start
 * a clean arrangement. Used both for New project and for replacing the song in
 * the current project, so the two paths cannot drift apart.
 */
const importAudio = (
  audio: PendingAudio,
  options: {
    name: string;
    /** A new project also resets surfaces; editing keeps the current stage. */
    fresh: boolean;
    bpm: number | null;
    offsetSec: number;
    beatsPerBar: number;
  },
): void => {
  const { buffer } = audio;
  const bpm = options.bpm;
  const durationSec = buffer.duration;
  const hadClips = cues.length > 0;

  clock.pause();
  clock.load(buffer);
  clock.setLoopEnabled(true);
  projectAudio = { source: 'external', fileName: audio.fileName };
  projectAudioFile = {
    bytes: audio.bytes,
    kind: 'audio',
    mime: audio.mime,
    fileName: audio.fileName,
  };
  loadedAudioSha = null;

  projectName = options.name;
  if (options.fresh) {
    projectDescription = undefined;
    // A new project starts on the venue's own wall rather than the previous
    // project's custom surfaces.
    surfaces = venueSurfaces(activeVenue);
    arrangement.setSurfaces(surfaces);
    stage.setLedSurfaces(surfaces);
  }

  const firstBeatSec = bpm === null ? 0 : options.offsetSec;
  const barSec = bpm === null ? 0 : (60 / bpm) * options.beatsPerBar;
  const loopStartSec = bpm === null ? 0 : Math.min(firstBeatSec, Math.max(0, durationSec - MIN_LOOP_SEC));
  const loopEndSec = Math.min(
    durationSec,
    bpm === null
      ? durationSec
      : Math.max(loopStartSec + MIN_LOOP_SEC, loopStartSec + barSec * 16),
  );
  const timeline: CueTimeline = {
    durationSec,
    firstBeatSec,
    bpm,
    beatsPerBar: options.beatsPerBar,
    loopStartSec,
    loopEndSec,
  };

  currentTimeline = timeline;
  loopRegion = { startSec: loopStartSec, endSec: loopEndSec };
  waveform.setPeaks(computePeaks(buffer, 1600));
  waveform.setTimeline({
    durationSec,
    loopStartSec,
    loopEndSec: loopRegion.endSec,
    firstBeatSec,
    bpm,
    beatsPerBar: options.beatsPerBar,
  });
  // `setTimeline` clears the clips: the old arrangement belonged to the old song.
  arrangement.setTimeline(timeline);

  ui.transportTrack.textContent = describeAudio(projectAudio, bpm);
  ui.transportTime.textContent = `${formatClock(loopStartSec)} / ${formatClock(durationSec)}`;
  ui.audioStatus.textContent = '';
  clock.setLoop({ startSec: loopStartSec, endSec: loopRegion.endSec }, true);
  clock.seek(loopStartSec);
  paintTimeAxis();
  enableTimelineControls();
  setZoom(PIXELS_PER_SECOND);
  applyLoop();
  ui.arrangementScroll.scrollLeft = Math.max(0, loopStartSec * arrangement.zoomLevel);
  syncButtons();

  const grid = bpm === null ? 'no beat grid' : `${bpm.toFixed(1)} BPM · ${options.beatsPerBar}/4`;
  if (options.fresh) {
    setProjectStatus(`New project “${options.name}” · ${grid}`);
  } else {
    setProjectStatus(`Updated “${options.name}” · song replaced · ${grid}${hadClips ? ' · clips cleared' : ''}`);
  }
};

/**
 * Rename the project and/or correct its beat grid without touching the clips.
 *
 * Clips keep their absolute song times; only the grid they snap to and the
 * bar labels change. That makes it safe to fix a wrong BPM after authoring.
 */
const applyProjectEdit = (options: {
  name: string;
  bpm: number | null;
  offsetSec: number;
  beatsPerBar: number;
}): void => {
  const previous = currentTimeline;
  if (previous === null) return;
  projectName = options.name;
  const durationSec = previous.durationSec;
  const loopStartSec = Math.min(loopRegion.startSec, Math.max(0, durationSec - MIN_LOOP_SEC));
  const loopEndSec = Math.max(loopStartSec + MIN_LOOP_SEC, Math.min(durationSec, loopRegion.endSec));
  const timeline: CueTimeline = {
    durationSec,
    firstBeatSec: options.bpm === null ? 0 : options.offsetSec,
    bpm: options.bpm,
    beatsPerBar: options.beatsPerBar,
    loopStartSec,
    loopEndSec,
  };
  currentTimeline = timeline;
  loopRegion = { startSec: loopStartSec, endSec: loopEndSec };
  arrangement.setBeatGrid(timeline);
  ui.transportTrack.textContent = describeAudio(projectAudio, options.bpm);
  setZoom(arrangement.zoomLevel);
  applyLoop();
  syncButtons();
  const grid = options.bpm === null ? 'no beat grid' : `${options.bpm.toFixed(1)} BPM · ${options.beatsPerBar}/4`;
  setProjectStatus(`Updated “${options.name}” · ${grid}`);
};

ui.newProjectDialog.addEventListener('close', () => {
  if (ui.newProjectDialog.returnValue !== 'create') {
    pendingAudio = null;
    return;
  }
  const audio = pendingAudio;
  pendingAudio = null;
  if (importMode === 'new' && audio === null) {
    setProjectStatus('Choose an audio file before creating a project');
    return;
  }
  const rawBpm = Number(ui.newProjectBpm.value);
  const bpm = Number.isFinite(rawBpm) && rawBpm > 0
    ? Math.max(40, Math.min(300, rawBpm))
    : null;
  const rawOffset = Number(ui.newProjectOffset.value);
  const offsetSec = bpm === null
    ? 0
    : Math.max(0, Number.isFinite(rawOffset) ? rawOffset : 0) % (60 / bpm);
  const beatsPerBar = ui.newProjectBeats.value === '3' ? 3 : 4;
  const name = ui.newProjectName.value.trim() === '' ? 'Untitled project' : ui.newProjectName.value.trim();
  if (audio === null) {
    applyProjectEdit({ name, bpm, offsetSec, beatsPerBar });
    return;
  }
  importAudio(audio, {
    name,
    fresh: importMode === 'new',
    bpm,
    offsetSec,
    beatsPerBar,
  });
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
ui.grain.addEventListener('click', () => {
  post.setGrain(!post.grain);
  syncButtons();
});
ui.audience.addEventListener('click', () => {
  stage.toggleAudience();
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

const resizeViewport = (): void => {
  measureTrackWidth();
  applyPanelWidth();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  stage.camera.aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  stage.camera.updateProjectionMatrix();
  refreshScrollMetrics();
  paintTimeAxis();
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
  // `/__bench` is a dev-server middleware; a static build has no such endpoint
  // and would log a 404 per run. Guard on DEV rather than on the response.
  if (!import.meta.env.DEV) return;
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
  if (!import.meta.env.DEV) return [];
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
  const beat = timeToBeat(show.beatGrid, showTime(loopRegion, songTime));
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
  const showAt = showTime(loopRegion, songTime);
  const states = show.fixtures.map((fixture) => {
    const trackClips = activeFixtureCuesAt(cuesForLane(cuesByFixture, fixture.id), songTime)
      .map((cue) => arrangement.toClip(cue));
    const state = evaluateFixture(fixture, trackClips, songTime);
    return fixture.profile.kind === 'strobe' && !strobesOn
      ? { ...state, intensity: 0, active: false, strobeHz: 0, strobeLevel: 1 }
      : state;
  });

  cryoAudio.update(states, songTime, clock.playing, (fixtureId) =>
    latestActiveEndSec(cuesForLane(cuesByFixture, fixtureId), songTime));

  const wallPlayback = new Map<string, LedPlaybackLayer[]>();
  for (const surface of surfaces) {
    const layers = wallPlaybackLayers(cuesForLane(cuesByFixture, surface.id), songTime);
    if (layers !== null) wallPlayback.set(surface.id, layers);
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

let projectStatusTimer: number | null = null;

/**
 * Project feedback (saved, opened, renamed) is transient: the transport has no
 * permanent status row, so the message takes over the audio line for a few
 * seconds and then clears. Failures are also logged so they stay diagnosable.
 */
const setProjectStatus = (message: string): void => {
  if (/could not|cannot|missing|before/i.test(message)) console.warn(message);
  ui.audioStatus.textContent = message;
  if (projectStatusTimer !== null) window.clearTimeout(projectStatusTimer);
  projectStatusTimer = window.setTimeout(() => {
    ui.audioStatus.textContent = '';
    projectStatusTimer = null;
  }, 5000);
};

const describeAudio = (audio: ProjectFile['audio'], bpm: number | null): string => {
  const tempo = bpm === null ? '' : ` · ${Math.round(bpm)} BPM`;
  if (audio.title !== undefined) {
    const artist = audio.artist === undefined ? '' : ` — ${audio.artist}`;
    return `${audio.title}${artist}${tempo}`;
  }
  return `${audio.fileName ?? 'Local audio'}${tempo}`;
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
  strobesOn = local.strobes ?? settings.render.strobes;
  post.setBloom(bloomOn);

  /* The fixture-count budget has no UI: the whole rig is always rendered, so
   * `render.activeFixtureCount` is accepted but not applied. */
  setActiveCount(show.fixtures.length);
  /* Local haze wins; otherwise start from the venue's own atmosphere. */
  stage.setHaze(local.haze ?? stage.hazeLevel);
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

/** Load a project into the running app. The rig is fixed for the app. */
const applyProject = (project: ProjectFile, source: 'project' | 'default' = 'project'): void => {
  projectName = project.name;
  projectDescription = project.description;
  projectAudio = project.audio;
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
  // Park on the first beat rather than a hair before it. Clips authored at the
  // start of the timeline snap to the beat grid, so resting at raw 0 would sit
  // in a dead gap and show an empty stage until the user pressed play.
  clock.seek(Math.max(loopRegion.startSec, timeline.firstBeatSec));
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
      /* Shadows always render; the toggle was removed as visually inert. */
      shadows: true,
      strobes: strobesOn,
      /* No fixture-count control: saved projects always carry the full rig. */
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

/* Every UI function the mode switch needs now exists, so the tools bar can be
 * refreshed on mode changes — and once here, because a stored "select" mode
 * would otherwise show the clip tools until the first interaction. */
syncInspectorForMode = (): void => {
  syncCueInspector(
    arrangement.selectedFixture,
    arrangement.selectedCues,
    arrangement.selectedSurface,
  );
};
syncInspectorForMode();

installKeyboardShortcuts({
  ui,
  arrangement,
  stage,
  post,
  syncButtons,
  togglePlay,
  toggleMute,
  toggleStats,
  toggleControls,
  seekBy,
  applyTimelineMode,
  clearLoop,
  setZoom,
  zoomOut,
  copySelection,
  saveProject,
});

ui.projectSave.addEventListener('click', saveProject);
ui.projectOpen.addEventListener('click', () => ui.projectFile.click());
ui.projectFile.addEventListener('change', () => {
  const file = ui.projectFile.files?.[0];
  ui.projectFile.value = '';
  if (file !== undefined) void openProject(file);
});

setBootStatus('Loading audio…');

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
