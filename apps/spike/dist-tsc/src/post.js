import * as THREE from 'three/webgpu';
import { RenderPipeline } from 'three/webgpu';
import { float, floor, mix, mx_noise_float, pass, screenUV, smoothstep, uniform, vec3 } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
export class Post {
    processing;
    withoutBloom;
    withBloom;
    uLofi = uniform(0);
    uTime = uniform(0);
    bloomEnabled = true;
    constructor(renderer, scene, camera) {
        const scenePass = pass(scene, camera);
        const sceneColor = scenePass.getTextureNode();
        const bloomPass = bloom(sceneColor, 0.55, 0.35, 1.0);
        this.withoutBloom = this.grade(sceneColor);
        this.withBloom = this.grade(sceneColor.add(bloomPass));
        this.processing = new RenderPipeline(renderer, this.withBloom);
    }
    grade(input) {
        const distance = screenUV.sub(0.5).length();
        const vignette = float(1).sub(smoothstep(0.3, 0.92, distance).mul(0.55));
        const grain = mx_noise_float(vec3(screenUV.mul(720), this.uTime.mul(26))).mul(0.03);
        const graded = input.mul(vignette).add(vec3(grain));
        const posterized = floor(graded.mul(24)).div(24);
        return mix(graded, posterized, this.uLofi);
    }
    setBloom(enabled) {
        this.bloomEnabled = enabled;
        this.processing.outputNode = enabled ? this.withBloom : this.withoutBloom;
        this.processing.needsUpdate = true;
    }
    get bloom() {
        return this.bloomEnabled;
    }
    setLofi(enabled) {
        this.uLofi.value = enabled ? 1 : 0;
    }
    setTime(timeSec) {
        this.uTime.value = timeSec;
    }
    render() {
        this.processing.render();
    }
}
//# sourceMappingURL=post.js.map