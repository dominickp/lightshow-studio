import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import type { LedLookState, LedSurface } from '@dmxsim/show-model';
import {
  applyLook,
  applySurface,
  averageLookColor,
  buildLookNode,
  createLookUniforms,
  lookTime,
  type LookUniforms,
} from './looks';

/**
 * Supplies media textures and keeps video playback aligned with song time.
 * Implemented by the app's media library so the renderer stays DOM-free.
 */
export interface LedMediaRuntime {
  /** Null while a local upload is still being restored from storage. */
  texture(source: string): THREE.Texture | null;
  /** Seek/play a source so its frame matches the clip time. */
  sync(source: string, timeSec: number, playing: boolean): void;
}

/** One look contributing to the wall this frame. */
export interface LedPlaybackLayer {
  look: LedLookState;
  /** 0..1 contribution, used for clip crossfades. */
  opacity: number;
}

interface Layer {
  mesh: THREE.Mesh;
  uniforms: LookUniforms;
  /** Keyed by kind plus media source; two clips may share a generator. */
  materials: Map<string, THREE.Material>;
  materialKey: string | null;
}

/**
 * Cache key for a look's material. Media is keyed by source and fit so two
 * clips never share a texture; every generator is shared by kind.
 */
const materialKey = (look: LedLookState): string => (look.kind === 'media'
  ? `media:${look.media?.source ?? ''}:${look.media?.fit ?? 'cover'}`
  : look.kind);

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
  private media: LedMediaRuntime | null;

  constructor(surface: LedSurface, media: LedMediaRuntime | null = null) {
    this.surface = surface;
    this.media = media;
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
      const layer: Layer = { mesh, uniforms, materials: new Map(), materialKey: null };
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

  /** Replace the media provider, e.g. when Stage swaps in its library. */
  setMediaRuntime(media: LedMediaRuntime | null): void {
    this.media = media;
    this.refreshMedia();
  }

  /** Rebuild media materials after a texture finishes loading. */
  refreshMedia(): void {
    for (const layer of this.layers) {
      for (const [key, material] of layer.materials) {
        if (!key.startsWith('media:')) continue;
        material.dispose();
        layer.materials.delete(key);
      }
      /* Only media materials depend on a texture landing, and the picture is
       * rebuilt by the next `update`. Clearing the key is enough — assigning
       * the black placeholder here would flash it for a frame. */
      if (layer.materialKey?.startsWith('media:')) layer.materialKey = null;
    }
  }

  /**
   * Build media materials for looks that are about to appear.
   *
   * The frame a clip fades in used to pay for its node graph as well as its
   * texture, which is one of the reasons a video cue arrived late. Nothing
   * here is assigned to a layer; the material is simply cached early so the
   * real draw only has to swap it in.
   */
  prewarm(looks: readonly LedLookState[]): void {
    for (const look of looks) {
      if (look.kind !== 'media' || look.media === undefined) continue;
      for (const layer of this.layers) this.materialFor(layer, look);
    }
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
    playing = true,
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
      this.setMaterial(layer, look);
      applyLook(layer.uniforms, look);
      const time = lookTime(look, timeSec, grid);
      layer.uniforms.time.value = time;
      layer.uniforms.opacity.value = playback.opacity;
      layer.uniforms.maskStrength.value = maskStrength;
      if (look.media !== undefined) {
        this.media?.sync(look.media.source, time, playing);
      }
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

  private setMaterial(layer: Layer, look: LedLookState): void {
    const key = materialKey(look);
    if (layer.materialKey === key) return;
    layer.materialKey = key;
    layer.mesh.material = this.materialFor(layer, look);
  }

  /** The cached material for a look, building it the first time it is needed. */
  private materialFor(layer: Layer, look: LedLookState): THREE.Material {
    const key = materialKey(look);
    const cached = layer.materials.get(key);
    if (cached !== undefined) return cached;
    const created = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mediaTexture = look.kind === 'media' && look.media !== undefined
      ? this.media?.texture(look.media.source) ?? null
      : null;
    created.colorNode = buildLookNode(look.kind, layer.uniforms, {
      texture: mediaTexture,
      fit: look.media?.fit ?? 'cover',
    });
    created.fog = false;
    layer.materials.set(key, created);
    return created;
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
