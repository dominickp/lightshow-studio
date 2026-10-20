import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import type { LedLookKind, LedLookState, LedSurface } from '@dmxsim/show-model';
import {
  applyLook,
  applySurface,
  averageLookColor,
  buildLookNode,
  createLookUniforms,
  lookTime,
  type LookUniforms,
} from './looks';

/** One look contributing to the wall this frame. */
export interface LedPlaybackLayer {
  look: LedLookState;
  /** 0..1 contribution, used for clip crossfades. */
  opacity: number;
}

interface Layer {
  mesh: THREE.Mesh;
  uniforms: LookUniforms;
  materials: Map<LedLookKind, THREE.Material>;
  kind: LedLookKind | null;
}

/**
 * The physical wall is always present, even with no clip: an unlit LED panel
 * is a dark grey surface, not empty space. Two additive content layers sit in
 * front of it, so "off" is the panel alone rather than a hole in the venue.
 */
const OFF_PANEL_COLOR = new THREE.Color(0x14161d);

/**
 * A physical LED surface rendered as two additive layers so two clips can
 * crossfade. Additive blending means a black look does not hide the layer
 * behind it, which is what a real wall does: unlit LEDs are off, not black
 * paint.
 */
export class LedWall {
  readonly group = new THREE.Group();
  private surface: LedSurface;
  private readonly layers: Layer[] = [];
  private readonly panel: THREE.Mesh;
  private maskStrength = 0;

  constructor(surface: LedSurface) {
    this.surface = surface;
    this.group.name = 'venue:led-wall';

    const panelMaterial = new THREE.MeshBasicNodeMaterial();
    panelMaterial.colorNode = vec3(
      OFF_PANEL_COLOR.r,
      OFF_PANEL_COLOR.g,
      OFF_PANEL_COLOR.b,
    );
    panelMaterial.fog = false;
    this.panel = new THREE.Mesh(
      new THREE.PlaneGeometry(surface.widthM, surface.heightM),
      panelMaterial,
    );
    this.panel.position.set(0, surface.y, surface.z - 0.02);
    this.group.add(this.panel);

    for (let index = 0; index < 2; index += 1) {
      const uniforms = createLookUniforms(surface);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(surface.widthM, surface.heightM),
        new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false }),
      );
      mesh.position.set(0, surface.y, surface.z + index * 0.01);
      mesh.renderOrder = 1 + index;
      const layer: Layer = { mesh, uniforms, materials: new Map(), kind: null };
      this.layers.push(layer);
      this.group.add(mesh);
    }
    this.applySurface(surface);
  }

  /** Update wall geometry and calibration without disturbing authored clips. */
  setSurface(surface: LedSurface): void {
    const sizeChanged = surface.widthM !== this.surface.widthM
      || surface.heightM !== this.surface.heightM;
    this.surface = surface;
    if (sizeChanged) {
      const panelGeometry = new THREE.PlaneGeometry(surface.widthM, surface.heightM);
      this.panel.geometry.dispose();
      this.panel.geometry = panelGeometry;
      for (const layer of this.layers) {
        const geometry = new THREE.PlaneGeometry(surface.widthM, surface.heightM);
        layer.mesh.geometry.dispose();
        layer.mesh.geometry = geometry;
      }
    }
    this.panel.position.set(0, surface.y, surface.z - 0.02);
    for (const [index, layer] of this.layers.entries()) {
      layer.mesh.position.set(0, surface.y, surface.z + index * 0.01);
    }
    this.applySurface(surface);
  }

  get currentSurface(): LedSurface {
    return this.surface;
  }

  /**
   * `timeSec` is song time; each look converts it through its own sync mode.
   * `grid` supplies tempo for beat/bar locked looks.
   */
  update(
    layers: readonly LedPlaybackLayer[],
    timeSec: number,
    grid: { bpm: number | null; beatsPerBar: number } | null,
    maskStrength: number,
  ): void {
    this.maskStrength = maskStrength;
    for (let index = 0; index < this.layers.length; index += 1) {
      const layer = this.layers[index]!;
      const playback = layers[index];
      if (playback === undefined || playback.opacity <= 0.001) {
        layer.mesh.visible = false;
        continue;
      }
      const look = playback.look;
      layer.mesh.visible = true;
      this.setKind(layer, look.kind);
      applyLook(layer.uniforms, look);
      layer.uniforms.time.value = lookTime(look, timeSec, grid);
      layer.uniforms.opacity.value = playback.opacity;
      layer.uniforms.maskStrength.value = maskStrength;
    }
  }

  /** Rough colour the wall throws into the room. */
  glowColor(layers: readonly LedPlaybackLayer[]): THREE.Color {
    const color = new THREE.Color(0, 0, 0);
    for (const layer of layers) {
      const contribution = averageLookColor(layer.look);
      color.add(contribution.multiplyScalar(layer.opacity));
    }
    if (layers.length === 0) return color;
    return color.multiplyScalar(
      Math.max(0, Math.min(1, this.surface.emit)) * Math.max(0, this.surface.brightness),
    );
  }

  get mask(): number {
    return this.maskStrength;
  }

  private applySurface(surface: LedSurface): void {
    for (const layer of this.layers) applySurface(layer.uniforms, surface);
  }

  private setKind(layer: Layer, kind: LedLookKind): void {
    if (layer.kind === kind) return;
    layer.kind = kind;
    let material = layer.materials.get(kind);
    if (material === undefined) {
      const created = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      created.colorNode = buildLookNode(kind, layer.uniforms);
      created.fog = false;
      material = created;
      layer.materials.set(kind, material);
    }
    layer.mesh.material = material;
  }

  dispose(): void {
    this.panel.geometry.dispose();
    (this.panel.material as THREE.Material).dispose();
    for (const layer of this.layers) {
      layer.mesh.geometry.dispose();
      for (const material of layer.materials.values()) material.dispose();
      layer.materials.clear();
    }
  }
}
