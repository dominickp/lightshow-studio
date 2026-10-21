import * as THREE from 'three/webgpu';
import { RenderPipeline } from 'three/webgpu';
import { float, mx_noise_float, pass, screenUV, smoothstep, uniform, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

/* TSL node graphs are not expressible with a stable public type, so the
 * grading helper is intentionally loosely typed. */
type NodeLike = any;

export class Post {
  private readonly processing: RenderPipeline;
  private readonly withoutBloom: NodeLike;
  private readonly withBloom: NodeLike;
  private readonly uTime = uniform(0);
  /* Grain strength is a uniform so the `g` shortcut / Render menu button can
   * toggle it without rebuilding the node graph. Off by default: it is an
   * opt-in look, not part of the baseline image. */
  private readonly uGrain = uniform(0);
  private grainEnabled = false;
  private bloomEnabled = true;

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const scenePass = pass(scene, camera);
    const sceneColor = scenePass.getTextureNode();
    const bloomPass = bloom(sceneColor, 0.55, 0.35, 1.0);

    this.withoutBloom = this.grade(sceneColor);
    this.withBloom = this.grade(sceneColor.add(bloomPass));

    this.processing = new RenderPipeline(renderer, this.withBloom);
  }

  private grade(input: NodeLike): NodeLike {
    const distance = screenUV.sub(0.5).length();
    const vignette = float(1).sub(smoothstep(0.3, 0.92, distance).mul(0.55));
    const grain = mx_noise_float(vec3(screenUV.mul(720), this.uTime.mul(26))).mul(this.uGrain);

    const graded = input.mul(vignette).add(vec3(grain));

    return graded;
  }

  setBloom(enabled: boolean): void {
    this.bloomEnabled = enabled;
    this.processing.outputNode = enabled ? this.withBloom : this.withoutBloom;
    this.processing.needsUpdate = true;
  }

  get bloom(): boolean {
    return this.bloomEnabled;
  }

  /** Opt-in film grain (key `g` / the Render menu button). */
  setGrain(enabled: boolean): void {
    this.grainEnabled = enabled;
    this.uGrain.value = enabled ? 0.03 : 0;
  }

  get grain(): boolean {
    return this.grainEnabled;
  }

  setTime(timeSec: number): void {
    this.uTime.value = timeSec;
  }

  render(): void {
    this.processing.render();
  }
}
