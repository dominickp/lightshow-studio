import * as THREE from 'three/webgpu';
import { float, floor, mix, mx_noise_float, sin, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  CLUB_STAGE,
  secondsPerBeat,
  type FixtureState,
  type Show,
  type VenueTemplate,
} from '@dmxsim/show-model';
import { FixtureRig } from './rig';
import { buildCrowd, buildVenue, disposeGroup } from './venue-builder';

interface CameraView {
  position: [number, number, number];
  target: [number, number, number];
}

const toTuple = (value: { x: number; y: number; z: number }): [number, number, number] => [value.x, value.y, value.z];

function viewsFrom(template: VenueTemplate): CameraView[] {
  return template.cameraPresets.map((preset) => ({
    position: toTuple(preset.position),
    target: toTuple(preset.target),
  }));
}

export interface StageUpdateOptions {
  volumetrics: boolean;
}

export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private readonly rigs: FixtureRig[] = [];
  private readonly hiddenFixtures = new Set<string>();
  private readonly selectionMarker = new THREE.Group();
  private selectedFixtureId: string | null = null;
  private activeCount = Number.POSITIVE_INFINITY;
  private readonly pointLights: THREE.PointLight[] = [];
  private readonly spot: THREE.SpotLight;
  private readonly ledUniforms = { time: uniform(0), energy: uniform(0.4) };
  private readonly edgeUniforms = { color: uniform(new THREE.Color(0xffffff)), energy: uniform(0.5) };
  private readonly beatSec: number;
  private viewIndex = 0;
  private venue: VenueTemplate;
  /** Camera presets for the active venue. */
  private views: CameraView[];
  /** Everything owned by the venue, removed and disposed when it changes. */
  private venueObjects: THREE.Object3D[] = [];

  constructor(domElement: HTMLElement, show: Show, venue: VenueTemplate = CLUB_STAGE) {
    this.beatSec = secondsPerBeat(show.beatGrid);
    this.venue = venue;
    this.views = viewsFrom(venue);
    this.scene.background = new THREE.Color(0x04060a);
    this.scene.fog = new THREE.FogExp2(0x05070c, 0.0135);

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
    this.controls.update();

    this.rebuildVenue();
    this.addSelectionMarker();

    const spot = new THREE.SpotLight(0xffe6c8, 190, 42, 0.42, 0.7, 2);
    spot.position.set(0, 9.5, -4);
    spot.target.position.set(0, 1.2, -9.6);
    spot.castShadow = true;
    spot.shadow.mapSize.set(1024, 1024);
    spot.shadow.camera.near = 2;
    spot.shadow.camera.far = 40;
    spot.shadow.bias = -0.0006;
    this.scene.add(spot, spot.target);
    this.spot = spot;

    this.scene.add(new THREE.AmbientLight(0x2a3550, 0.38));

    for (let i = 0; i < 4; i += 1) {
      const light = new THREE.PointLight(0x4466ff, 10, 26, 2);
      light.position.set(-9 + i * 6, 5.5, 3 + (i % 2) * 4);
      this.scene.add(light);
      this.pointLights.push(light);
    }

    this.setShow(show);
  }

  /** Active venue template, so the shell can persist it with the project. */
  get activeVenue(): VenueTemplate {
    return this.venue;
  }

  /**
   * Swap the venue. Fixture rigs are owned by `setShow`, so they are untouched
   * here: callers that change stage area should replace the rig too (ADR-011).
   */
  setVenue(template: VenueTemplate): void {
    if (template.id === this.venue.id) return;
    this.venue = template;
    this.views = viewsFrom(template);
    this.rebuildVenue();
    this.setView(Math.min(this.viewIndex, this.views.length - 1), true);
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

    const leds = this.buildLeds();
    if (leds !== null) {
      this.scene.add(leds);
      this.venueObjects.push(leds);
    }

    if (this.venue.features.haze === true) {
      const haze = this.buildAtmosphere();
      this.scene.add(haze);
      this.venueObjects.push(haze);
    }
  }

  /** LED wall plus the emissive accent strips that pulse with the beat. */
  private buildLeds(): THREE.Object3D | null {
    const feature = this.venue.features.ledWall;
    const strips = this.venue.features.accentStrips ?? [];
    if (feature === undefined && strips.length === 0) return null;

    const group = new THREE.Group();
    group.name = 'venue:leds';

    if (feature !== undefined) {
      const wallMaterial = new THREE.MeshBasicNodeMaterial();
      const grid = vec2(26, 14);
      const pixel = floor(uv().mul(grid)).add(0.5).div(grid);
      const wave = sin(pixel.x.mul(34).add(this.ledUniforms.time.mul(1.6))).mul(0.5).add(0.5);
      const scan = sin(pixel.y.mul(46).sub(this.ledUniforms.time.mul(3.4))).mul(0.5).add(0.5);
      const sparkle = mx_noise_float(vec3(pixel.mul(26), this.ledUniforms.time.mul(0.8))).mul(0.5).add(0.5);
      const hue = smoothstep(0, 1, pixel.x.add(sin(pixel.y.mul(3).add(this.ledUniforms.time)).mul(0.2)));
      const base = mix(vec3(0.01, 0.03, 0.16), vec3(0.5, 0.05, 0.65), hue);
      wallMaterial.colorNode = base
        .mul(wave.mul(0.6).add(0.35))
        .mul(scan.mul(0.5).add(0.5))
        .mul(sparkle.mul(0.5).add(0.65))
        .mul(this.ledUniforms.energy)
        .mul(2.1);
      wallMaterial.fog = false;

      const wall = new THREE.Mesh(new THREE.PlaneGeometry(feature.width, feature.height), wallMaterial);
      wall.position.set(0, feature.y, feature.z);
      group.add(wall);
    }

    if (strips.length > 0) {
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
    }

    return group;
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
    material.colorNode = vec3(0.05, 0.07, 0.12).mul(band).mul(0.7);
    haze.rotation.x = -Math.PI / 2;
    haze.position.set(0, 0.25, 0);
    return haze;
  }

  setShow(show: Show): void {
    for (const rig of this.rigs) rig.removeFrom(this.scene);
    this.rigs.length = 0;

    for (const placement of show.fixtures) {
      const rig = new FixtureRig(placement);
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
      rig.setVisible(inCount && !hidden);
    });
    if (this.selectedFixtureId !== null && this.hiddenFixtures.has(this.selectedFixtureId)) {
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
  }

  /** Current camera preset, so it can be saved with the project. */
  get view(): number {
    return this.viewIndex;
  }

  nextView(): void {
    this.setView(this.viewIndex + 1, true);
  }

  update(states: readonly FixtureState[], timeSec: number, options: StageUpdateOptions): void {
    const byId = new Map(states.map((state) => [state.fixtureId, state]));

    for (const rig of this.rigs) {
      const state = byId.get(rig.placement.id);
      if (!state) continue;
      rig.update(state, timeSec, options.volumetrics);
      // Placement is editable, so follow the selected fixture instead of
      // leaving the marker at the position it had when it was selected.
      if (this.selectionMarker.visible && rig.placement.id === this.selectedFixtureId) {
        this.selectionMarker.position.copy(rig.root.position);
      }
    }

    this.controls.update();

    const beatPhase = (timeSec / this.beatSec) % 1;
    const energy = Math.exp(-beatPhase * 3.2) * 0.75 + 0.25;
    this.ledUniforms.time.value = timeSec;
    this.ledUniforms.energy.value = 0.3 + energy * 0.7;

    const color = new THREE.Color();
    let r = 0;
    let g = 0;
    let b = 0;
    let active = 0;
    for (const state of states) {
      if (!state.active) continue;
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

    this.pointLights.forEach((light, index) => {
      const state = states[(index * 7) % Math.max(1, states.length)];
      if (state) {
        light.color.setRGB(state.color.r, state.color.g, state.color.b, THREE.SRGBColorSpace);
        light.intensity = 6 + state.intensity * 20;
      }
    });

    this.spot.intensity = 140 + energy * 90;
  }

  setShadows(enabled: boolean): void {
    this.spot.castShadow = enabled;
  }

  get shadowCasting(): boolean {
    return this.spot.castShadow;
  }
}
