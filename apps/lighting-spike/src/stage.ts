import * as THREE from 'three/webgpu';
import { float, smoothstep, uniform, uv, vec3 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CLUB_STAGE,
  secondsPerBeat,
  type FixtureState,
  type LedSurface,
  type Show,
  type VenueTemplate,
} from '@dmxsim/show-model';
import { LedWall, type LedPlaybackLayer } from './led/led-wall';
import { ledMaskStrength } from './led/looks';
import { createFixtureRig, type LaserRig } from './laser-rig';
import type { FixtureRig } from './rig';
import type { CryoJetRig } from './cryo-jet-rig';
import { buildCrowd, buildVenue, disposeGroup } from './venue-builder';

interface CameraView {
  position: [number, number, number];
  target: [number, number, number];
}

/**
 * Real lights driven by the rig.
 *
 * Every fixture used to render only additive geometry, so the room itself was
 * lit by one hardcoded warm spot and four point lights parked at arbitrary
 * coordinates. This pool instead promotes the brightest fixtures that are
 * actually on. That is what turns beams into lighting: truss highlights and
 * crowd silhouettes. The floor itself is lit per fixture by the additive pool
 * decal, so identical fixtures always look identical no matter which four won
 * a slot in this budget.
 */
/* Dynamic lights are the main GPU cost of lighting the room, so the budget is
 * explicit (ADR-007). Both pools are selected evenly across the rig, never as
 * "the first N fixtures". The count must also stay *constant*: three/webgpu
 * recompiles every material when the visible light count changes, which shows
 * up as a ~1 s freeze exactly when a cue adds or drops a fixture. */
const LIGHT_POOL_SIZE = 4;

/**
 * Orbit camera. The stage faces +Z (the LED wall sits at negative Z, camera
 * presets and the crowd on positive Z), so the orbit is limited to a frontal
 * arc rather than a full revolution: it sweeps across the front of the stage
 * and reverses at each edge instead of passing behind the set.
 *
 * The sweep also breathes in height and distance. Polar and zoom oscillations
 * use co-prime-ish periods so the combined motion does not read as a mechanical
 * loop, and both are relative to the framing the user had when the orbit
 * started (or last dragged), so the default presets are respected.
 */
const ORBIT_ARC_RAD = (65 * Math.PI) / 180;
/** 6°/s: a slow sweep, roughly 22 s from one edge of the arc to the other. */
const ORBIT_SPEED_RAD_PER_SEC = (6 * Math.PI) / 180;
/** Height bob, ±8° of polar angle over a 19 s cycle. */
const ORBIT_POLAR_AMPLITUDE_RAD = (8 * Math.PI) / 180;
const ORBIT_HEIGHT_PERIOD_SEC = 19;
/** Dolly in/out by ±12% of the orbit radius over a 23 s cycle. */
const ORBIT_ZOOM_AMPLITUDE = 0.12;
const ORBIT_ZOOM_PERIOD_SEC = 23;
/** Keep the orbit clear of the straight-down view. */
const ORBIT_MIN_POLAR_RAD = 0.08;

interface PoolLight {
  light: THREE.SpotLight;
  target: THREE.Object3D;
}

const toTuple = (value: { x: number; y: number; z: number }): [number, number, number] => [value.x, value.y, value.z];

function viewsFrom(template: VenueTemplate): CameraView[] {
  return template.cameraPresets.map((preset) => ({
    position: toTuple(preset.position),
    target: toTuple(preset.target),
  }));
}

interface StageUpdateOptions {
  volumetrics: boolean;
  /** True while the transport is playing; cue effects freeze when paused. */
  playing?: boolean;
}

export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly rigs: (FixtureRig | LaserRig | CryoJetRig)[] = [];
  private readonly hiddenFixtures = new Set<string>();
  /**
   * When set, rigs whose fixture kind does not match are hidden from the
   * scene. Driven by the timeline's track filter + "hide others" toggle, so
   * it layers on top of per-fixture visibility rather than replacing it.
   */
  private kindFilter: string | null = null;
  private readonly selectionMarker = new THREE.Group();
  private selectedFixtureId: string | null = null;
  private activeCount = Number.POSITIVE_INFINITY;
  private readonly poolLights: PoolLight[] = [];
  private readonly ambient: THREE.AmbientLight;
  private shadowsEnabled = true;
  private readonly edgeUniforms = { color: uniform(new THREE.Color(0xffffff)), energy: uniform(0.5) };
  /** LED walls by surface id. Geometry is static; content is clip playback. */
  private readonly ledWalls = new Map<string, LedWall>();
  private ledSurfaces: LedSurface[] = [];
  private ledPlayback: ReadonlyMap<string, readonly LedPlaybackLayer[]> = new Map();
  /** Approximate room fill thrown by the walls. */
  private readonly ledGlow: THREE.PointLight;
  private beatGrid: { bpm: number | null; beatsPerBar: number };
  /** Scene haze, 0..1. Beams are only visible where light scatters off it. */
  private readonly hazeUniform = uniform(0.65);
  private haze = 0.65;
  private readonly beatSec: number;
  private viewIndex = 0;
  private orbit = false;
  /** Sweep direction: +1 towards +X, -1 back towards -X. */
  private orbitDirection = 1;
  private orbitLastMs = 0;
  private orbitInteracting = false;
  /** Seconds elapsed since the framing was anchored; drives the bob/dolly. */
  private orbitPhase = 0;
  /** Framing the orbit oscillates around. Re-anchored on drag end / view change. */
  private orbitAzimuth = 0;
  private orbitPolar = Math.PI / 2;
  private orbitRadius = 12;
  private venue: VenueTemplate;
  /** Camera presets for the active venue. */
  private views: CameraView[];
  /** Everything owned by the venue, removed and disposed when it changes. */
  private venueObjects: THREE.Object3D[] = [];

  constructor(private readonly domElement: HTMLElement, show: Show, venue: VenueTemplate = CLUB_STAGE) {
    this.beatSec = secondsPerBeat(show.beatGrid);
    this.beatGrid = { bpm: show.beatGrid.bpm, beatsPerBar: show.beatGrid.beatsPerBar };
    this.venue = venue;
    this.views = viewsFrom(venue);
    this.haze = venue.features.haze === true ? 0.65 : 0.05;
    this.hazeUniform.value = this.haze;
    this.scene.background = new THREE.Color(0x04060a);
    this.scene.fog = new THREE.FogExp2(0x05070c, this.fogDensity());

    this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 220);
    this.camera.position.set(...this.views[0]!.position);
    this.camera.lookAt(...this.views[0]!.target);

    this.controls = new OrbitControls(this.camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(...this.views[0]!.target);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 42;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.addEventListener('start', () => {
      this.orbitInteracting = true;
    });
    this.controls.addEventListener('end', () => {
      this.orbitInteracting = false;
      this.orbitLastMs = 0;
      if (this.orbit) this.anchorOrbit();
    });
    this.controls.update();

    this.rebuildVenue();
    this.addSelectionMarker();

    /* Shadow budget (ADR-007): only the brightest fixture casts shadows. */
    for (let i = 0; i < LIGHT_POOL_SIZE; i += 1) {
      const light = new THREE.SpotLight(0xffffff, 0, 40, 0.4, 0.45, 2);
      /* Stay visible for the whole session. Toggling `visible` changes the
       * light count, and every material in the scene then recompiles its light
       * loop — a multi-hundred-ms stall in the middle of a cue change. Idle
       * slots keep intensity 0 instead. */
      light.visible = true;
      if (i === 0) {
        light.castShadow = this.shadowsEnabled;
        light.shadow.mapSize.set(1024, 1024);
        light.shadow.camera.near = 0.5;
        light.shadow.camera.far = 40;
        light.shadow.bias = -0.0008;
      }
      const target = new THREE.Object3D();
      this.scene.add(light, target);
      light.target = target;
      this.poolLights.push({ light, target });
    }

    this.ambient = new THREE.AmbientLight(0x2a3550, 0.16);
    this.scene.add(this.ambient);

    /* A soft fill that approximates the wall throwing light into the room.
     * It is a single light, not GI: enough to make the stage react to a bright
     * wall without pretending to be a radiance transfer solution. */
    this.ledGlow = new THREE.PointLight(0xffffff, 0, 34, 2);
    this.scene.add(this.ledGlow);

    this.setShow(show);
  }

  /** Active venue template, so the shell can persist it with the project. */
  get activeVenue(): VenueTemplate {
    return this.venue;
  }

  /** Scene haze. Drives beam visibility and matches the fog density. */
  setHaze(value: number): void {
    this.haze = Math.min(1, Math.max(0, value));
    this.hazeUniform.value = this.haze;
    if (this.scene.fog instanceof THREE.FogExp2) this.scene.fog.density = this.fogDensity();
  }

  get hazeLevel(): number {
    return this.haze;
  }

  private fogDensity(): number {
    return 0.004 + this.haze * 0.016;
  }

  /** Rebuild venue geometry, crowd, LED wall, and haze from the template. */
  private rebuildVenue(): void {
    for (const object of this.venueObjects) {
      this.scene.remove(object);
      disposeGroup(object);
    }
    this.venueObjects = [];

    const structure = buildVenue(this.venue);
    this.scene.add(structure);
    this.venueObjects.push(structure);

    const crowdFeature = this.venue.features.crowd;
    if (crowdFeature !== undefined) {
      const crowd = buildCrowd(crowdFeature);
      this.scene.add(crowd);
      this.venueObjects.push(crowd);
    }

    const strips = this.buildAccentStrips();
    if (strips !== null) {
      this.scene.add(strips);
      this.venueObjects.push(strips);
    }

    if (this.venue.features.haze === true) {
      const haze = this.buildAtmosphere();
      this.scene.add(haze);
      this.venueObjects.push(haze);
    }
  }

  /** Emissive accent strips that pulse with the beat. */
  private buildAccentStrips(): THREE.Object3D | null {
    const strips = this.venue.features.accentStrips ?? [];
    if (strips.length === 0) return null;

    const group = new THREE.Group();
    group.name = 'venue:accent-strips';
    const edgeMaterial = new THREE.MeshBasicNodeMaterial();
    edgeMaterial.colorNode = this.edgeUniforms.color.mul(this.edgeUniforms.energy);
    edgeMaterial.fog = false;

    for (const strip of strips) {
      const stripMesh = new THREE.Mesh(
        new THREE.BoxGeometry(strip.size.x, strip.size.y, strip.size.z),
        edgeMaterial,
      );
      stripMesh.position.set(strip.position.x, strip.position.y, strip.position.z);
      group.add(stripMesh);
    }
    return group;
  }

  /**
   * Replace the rendered walls. Geometry and calibration live on the surface;
   * content arrives per frame through `setLedPlayback`.
   */
  setLedSurfaces(surfaces: readonly LedSurface[]): void {
    this.ledPlayback = new Map();
    this.ledGlow.intensity = 0;
    this.ledSurfaces = [...surfaces];
    for (const wall of this.ledWalls.values()) {
      this.scene.remove(wall.group);
      wall.dispose();
    }
    this.ledWalls.clear();
    for (const surface of surfaces) {
      const wall = new LedWall(surface);
      this.ledWalls.set(surface.id, wall);
      this.scene.add(wall.group);
      this.syncVenueLedSurface(surface);
    }
  }

  /** Active look layers per wall. Crossfades are resolved by the caller. */
  setLedPlayback(playback: ReadonlyMap<string, readonly LedPlaybackLayer[]>): void {
    this.ledPlayback = playback;
  }

  /** Lane visibility toggle: hide the wall without removing its content. */
  setLedSurfaceVisible(surfaceId: string, visible: boolean): void {
    const wall = this.ledWalls.get(surfaceId);
    if (wall !== undefined) wall.group.visible = visible;
  }

  /** Re-render wall calibration from the side panel sliders. */
  updateLedSurfaceById(surfaceId: string, patch: Partial<LedSurface>): void {
    const surface = this.ledSurfaces.find((entry) => entry.id === surfaceId);
    if (surface === undefined) return;
    this.updateLedSurface({ ...surface, ...patch });
  }

  /** Wall calibration from the project, without rebuilding scene objects. */
  updateLedSurface(surface: LedSurface): void {
    const wall = this.ledWalls.get(surface.id);
    if (wall === undefined) return;
    wall.setSurface(surface);
    const index = this.ledSurfaces.findIndex((entry) => entry.id === surface.id);
    if (index >= 0) this.ledSurfaces[index] = surface;
    this.syncVenueLedSurface(surface);
  }

  /**
   * Keep beam termination aligned with the rendered panel. The venue declares
   * the LED wall as a static surface, so resizing the wall has to update that
   * plane or lights would stop at the panel's original footprint.
   */
  private syncVenueLedSurface(surface: LedSurface): void {
    const target = this.venue.surfaces.find((entry) => entry.kind === 'led');
    if (target === undefined) return;
    target.value = surface.z;
    target.bounds = {
      x: [-surface.widthM / 2, surface.widthM / 2],
      y: [surface.y - surface.heightM / 2, surface.y + surface.heightM / 2],
      z: [surface.z - 0.05, surface.z + 0.05],
    };
  }

  get ledWallSurfaces(): readonly LedSurface[] {
    return this.ledSurfaces;
  }

  private addSelectionMarker(): void {
    const material = new THREE.MeshBasicMaterial({
      color: 0x7ad1ff,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.022, 8, 40), material);
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 999;
    const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.075, 0.2, 10), material);
    pointer.rotation.x = Math.PI;
    pointer.position.y = 0.62;
    pointer.renderOrder = 999;
    this.selectionMarker.add(ring, pointer);
    this.selectionMarker.visible = false;
    this.scene.add(this.selectionMarker);
  }

  private buildAtmosphere(): THREE.Mesh {
    const haze = new THREE.Mesh(
      new THREE.PlaneGeometry(this.venue.bounds.width, this.venue.bounds.depth - 4),
      new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    const material = haze.material as THREE.MeshBasicNodeMaterial;
    const p = uv();
    const band = smoothstep(0.0, 0.55, p.y).mul(float(1).sub(smoothstep(0.55, 1.0, p.y)));
    material.colorNode = vec3(0.05, 0.07, 0.12).mul(band).mul(this.hazeUniform).mul(1.1);
    haze.rotation.x = -Math.PI / 2;
    haze.position.set(0, 0.25, 0);
    return haze;
  }

  setShow(show: Show): void {
    this.beatGrid = { bpm: show.beatGrid.bpm, beatsPerBar: show.beatGrid.beatsPerBar };
    for (const rig of this.rigs) rig.removeFrom(this.scene);
    this.rigs.length = 0;

    for (const placement of show.fixtures) {
      const rig = createFixtureRig(placement);
      rig.addTo(this.scene);
      this.rigs.push(rig);
    }
    // Rebuilding rigs resets their visibility, so re-apply the render budget
    // and per-lane hides that were in effect before the edit.
    this.applyVisibility();
  }

  setActiveCount(count: number): void {
    this.activeCount = count;
    this.applyVisibility();
  }

  setFixtureHidden(fixtureId: string, hidden: boolean): void {
    if (hidden) this.hiddenFixtures.add(fixtureId);
    else this.hiddenFixtures.delete(fixtureId);
    this.applyVisibility();
  }

  /**
   * Hide every rig whose fixture kind differs from `kind` (`null` shows all).
   * This is the scene half of the track filter's "hide others" toggle.
   */
  setKindFilter(kind: string | null): void {
    if (this.kindFilter === kind) return;
    this.kindFilter = kind;
    this.applyVisibility();
  }

  setSelectedFixture(fixtureId: string | null): void {
    this.selectedFixtureId = fixtureId;
    const rig = this.rigs.find((item) => item.placement.id === fixtureId);
    if (rig === undefined || fixtureId === null) {
      this.selectionMarker.visible = false;
      return;
    }
    this.selectionMarker.position.copy(rig.root.position);
    this.selectionMarker.visible = true;
  }

  private applyVisibility(): void {
    this.rigs.forEach((rig, index) => {
      const inCount = index < this.activeCount;
      const hidden = this.hiddenFixtures.has(rig.placement.id);
      const filtered = this.kindFilter !== null
        && rig.placement.profile.kind !== this.kindFilter;
      rig.setVisible(inCount && !hidden && !filtered);
    });
    const selectedHidden = this.selectedFixtureId !== null
      && (this.hiddenFixtures.has(this.selectedFixtureId)
        || (this.kindFilter !== null
          && this.rigs.find((rig) => rig.placement.id === this.selectedFixtureId)
            ?.placement.profile.kind !== this.kindFilter));
    if (selectedHidden) {
      this.selectionMarker.visible = false;
    } else {
      this.setSelectedFixture(this.selectedFixtureId);
    }
  }

  setView(index: number, immediate = false): void {
    const count = this.views.length;
    if (count === 0) return;
    this.viewIndex = ((index % count) + count) % count;
    const view = this.views[this.viewIndex]!;
    this.camera.position.set(...view.position);
    if (immediate) {
      this.camera.lookAt(...view.target);
    }
    this.controls?.target.set(...view.target);
    this.controls?.update();
    if (this.orbit) this.anchorOrbit();
  }

  /** Current camera preset, so it can be saved with the project. */
  get view(): number {
    return this.viewIndex;
  }

  nextView(): void {
    this.setView(this.viewIndex + 1, true);
  }

  /**
   * Slow orbit across the front of the stage, with a gentle height bob and
   * dolly in/out. The sweep reverses at a frontal arc limit (never passing
   * behind the set) and pauses while the user drags.
   */
  setOrbit(enabled: boolean): void {
    this.orbit = enabled;
    this.orbitLastMs = 0;
    if (enabled) this.anchorOrbit();
  }

  toggleOrbit(): void {
    this.setOrbit(!this.orbit);
  }

  get orbitEnabled(): boolean {
    return this.orbit;
  }

  /** Capture the current framing as the centre of the orbit oscillations. */
  private anchorOrbit(): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const radius = offset.length();
    this.orbitRadius = Math.min(this.controls.maxDistance,
      Math.max(this.controls.minDistance, radius));
    this.orbitAzimuth = Math.min(ORBIT_ARC_RAD,
      Math.max(-ORBIT_ARC_RAD, Math.atan2(offset.x, offset.z)));
    this.orbitPolar = Math.min(this.controls.maxPolarAngle,
      Math.max(ORBIT_MIN_POLAR_RAD,
        Math.acos(Math.min(1, Math.max(-1, offset.y / Math.max(radius, 1e-4))))));
    this.orbitPhase = 0;
  }

  /** Advance the orbit by one frame's worth of time. */
  private stepOrbit(): void {
    const now = performance.now();
    const deltaSec = this.orbitLastMs === 0 ? 0 : Math.min(0.1, (now - this.orbitLastMs) / 1000);
    this.orbitLastMs = now;
    if (this.orbitInteracting) return;
    this.orbitPhase += deltaSec;

    let azimuth = this.orbitAzimuth + this.orbitDirection * ORBIT_SPEED_RAD_PER_SEC * deltaSec;
    if (azimuth >= ORBIT_ARC_RAD) {
      azimuth = ORBIT_ARC_RAD;
      this.orbitDirection = -1;
    } else if (azimuth <= -ORBIT_ARC_RAD) {
      azimuth = -ORBIT_ARC_RAD;
      this.orbitDirection = 1;
    }
    this.orbitAzimuth = azimuth;

    const polar = Math.min(this.controls.maxPolarAngle,
      Math.max(ORBIT_MIN_POLAR_RAD,
        this.orbitPolar
          + ORBIT_POLAR_AMPLITUDE_RAD * Math.sin((this.orbitPhase / ORBIT_HEIGHT_PERIOD_SEC) * Math.PI * 2)));
    const radius = Math.min(this.controls.maxDistance,
      Math.max(this.controls.minDistance,
        this.orbitRadius
          * (1 + ORBIT_ZOOM_AMPLITUDE * Math.sin((this.orbitPhase / ORBIT_ZOOM_PERIOD_SEC) * Math.PI * 2))));

    const target = this.controls.target;
    const horizontal = Math.sin(polar) * radius;
    this.camera.position.set(
      target.x + Math.sin(azimuth) * horizontal,
      target.y + Math.cos(polar) * radius,
      target.z + Math.cos(azimuth) * horizontal,
    );
    this.camera.lookAt(target);
  }

  update(states: readonly FixtureState[], timeSec: number, options: StageUpdateOptions): void {
    const byId = new Map(states.map((state) => [state.fixtureId, state]));

    for (const rig of this.rigs) {
      const state = byId.get(rig.placement.id);
      if (!state) continue;
      rig.update(state, timeSec, {
        volumetrics: options.volumetrics,
        playing: options.playing ?? true,
        haze: this.haze,
        camera: this.camera,
        surfaces: this.venue.surfaces,
      });
      // Placement is editable, so follow the selected fixture instead of
      // leaving the marker at the position it had when it was selected.
      if (this.selectionMarker.visible && rig.placement.id === this.selectedFixtureId) {
        this.selectionMarker.position.copy(rig.root.position);
      }
    }

    this.controls.update();
    if (this.orbit) this.stepOrbit();

    const beatPhase = (timeSec / this.beatSec) % 1;
    const energy = Math.exp(-beatPhase * 3.2) * 0.75 + 0.25;

    this.updateLedWalls(timeSec);

    const color = new THREE.Color();
    let r = 0;
    let g = 0;
    let b = 0;
    let active = 0;
    for (const state of states) {
      // A cryo jet emits vapour, not light: keep it out of the room ambience.
      if (!state.active || state.kind === 'cryo-jet') continue;
      r += state.color.r * state.intensity;
      g += state.color.g * state.intensity;
      b += state.color.b * state.intensity;
      active += 1;
    }

    if (active > 0) {
      color.setRGB(r / active, g / active, b / active, THREE.SRGBColorSpace);
    } else {
      color.setHex(0x223355);
    }

    this.edgeUniforms.color.value.copy(color);
    this.edgeUniforms.energy.value = 0.4 + energy * 1.4;

    this.ambient.color.copy(color);
    this.ambient.intensity = active > 0 ? 0.1 + energy * 0.14 : 0.06;

    this.updateLights(states);
  }

  /**
   * Advance every wall's content and derive one room-fill light from it.
   *
   * The wall is emissive geometry, so it does not light the room by itself.
   * A single soft point light in front of the busiest wall approximates the
   * spill cheaply; it is deliberately not per-pixel GI.
   */
  private updateLedWalls(timeSec: number): void {
    if (this.ledWalls.size === 0) return;
    const viewportHeight = Math.max(1, this.domElement.clientHeight);
    const glow = new THREE.Color(0, 0, 0);
    let glowWeight = 0;
    for (const [surfaceId, wall] of this.ledWalls) {
      const layers = this.ledPlayback.get(surfaceId) ?? [];
      const surface = wall.currentSurface;
      wall.update(
        layers,
        timeSec,
        this.beatGrid,
        ledMaskStrength(surface, this.camera, viewportHeight),
      );
      if (layers.length > 0 && wall.group.visible) {
        glow.add(wall.glowColor(layers));
        glowWeight += surface.emit;
      }
    }
    if (glowWeight > 0) {
      glow.multiplyScalar(1 / Math.max(1, this.ledWalls.size));
      this.ledGlow.color.copy(glow);
      this.ledGlow.intensity = Math.min(24, glowWeight * 14);
      this.ledGlow.position.set(0, 3.4, -7.5);
    } else {
      this.ledGlow.intensity = 0;
    }
  }

  /**
   * Promote live fixtures into the spotlight pool and put fill lights at their
   * beam hits. Fixtures below a threshold release their light so a dark cue
   * does not leave the room lit.
   *
   * Selection is stratified across the rig, not just "the brightest N". Most
   * fixtures sit at full dimmer at the same time, so taking the first N would
   * give the same handful of lights a real light and leave the rest of the rig
   * unable to light anything — which reads as uneven blobs on a few fixtures.
   */
  private updateLights(states: readonly FixtureState[]): void {
    const byId = new Map(states.map((state) => [state.fixtureId, state]));
    /* Rig order is spatially even, which is what the stratification needs. */
    const active = this.rigs
      .filter((rig) => rig.root.visible)
      .map((rig) => {
        const info = rig.beamInfo;
        return byId.get(rig.placement.id) !== undefined && info.level > 0.01
          ? { info, kind: rig.placement.profile.kind, power: info.level }
          : null;
      })
      .filter((entry) => entry !== null);

    const chosen: typeof active = [];
    if (active.length <= LIGHT_POOL_SIZE) {
      chosen.push(...active);
    } else {
      /* One slot per slice of the rig, keeping the brightest in each slice so
       * a busy side still gets the light it earned. */
      const slice = active.length / LIGHT_POOL_SIZE;
      for (let i = 0; i < LIGHT_POOL_SIZE; i += 1) {
        const bucket = active.slice(Math.floor(i * slice), Math.floor((i + 1) * slice));
        if (bucket.length === 0) continue;
        let best = bucket[0]!;
        for (const entry of bucket) if (entry.power > best.power) best = entry;
        chosen.push(best);
      }
    }

    /* Never toggle `visible` here: keep the light count constant so cue
     * changes cannot trigger a shader recompile. An idle slot is intensity 0. */
    this.poolLights.forEach((slot, index) => {
      const entry = chosen[index];
      if (entry === undefined) {
        slot.light.intensity = 0;
        return;
      }

      const { info } = entry;
      const halfAngle = THREE.MathUtils.degToRad(Math.min(info.spreadDeg, 140) / 2);
      /* Narrow beams land more candela per steradian at the same dimmer
       * level, which is why a tight spot looks hotter than a wide wash.
       * Keep this low: the per-fixture floor decals carry the floor look, and
       * a bright spot here would give the four promoted fixtures a halo the
       * rest of the rig can never match. */
      const concentration = THREE.MathUtils.clamp(22 / info.spreadDeg, 0.35, 3.2);
      const isWide = entry.kind === 'blinder' || entry.kind === 'strobe' || entry.kind === 'led-strip';

      slot.light.color.copy(info.color);
      slot.light.angle = halfAngle;
      slot.light.penumbra = isWide ? 1 : 0.55;
      slot.light.decay = 2;
      slot.light.distance = Math.min(46, info.length * 1.35 + 6);
      slot.light.intensity = info.level * (isWide ? 12 : 34) * concentration;
      slot.light.position.copy(info.origin);
      slot.target.position.copy(info.origin).addScaledVector(info.direction, Math.max(0.5, info.length));
    });
  }

  setShadows(enabled: boolean): void {
    this.shadowsEnabled = enabled;
    const key = this.poolLights[0];
    if (key !== undefined) key.light.castShadow = enabled;
  }
}
