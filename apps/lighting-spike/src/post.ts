import * as THREE from 'three/webgpu';
import { RenderPipeline } from 'three/webgpu';
import { float, mx_noise_float, pass, screenUV, smoothstep, uniform, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

/* TSL node graphs are not expressible with a stable public type, so the
 * grading helper is intentionally loosely typed. */
type NodeLike = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export class Post {
  private readonly processing: RenderPipeline;
  private readonly withoutBloom: NodeLike;
  private readonly withBloom: NodeLike;
  private readonly uTime = uniform(0);
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
    const grain = mx_noise_float(vec3(screenUV.mul(720), this.uTime.mul(26))).mul(0.03);

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

  setTime(timeSec: number): void {
    this.uTime.value = timeSec;
  }

  render(): void {
    this.processing.render();
  }
}
