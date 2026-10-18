import * as THREE from 'three/webgpu';
export declare class Post {
    private readonly processing;
    private readonly withoutBloom;
    private readonly withBloom;
    private readonly uLofi;
    private readonly uTime;
    private bloomEnabled;
    constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.Camera);
    private grade;
    setBloom(enabled: boolean): void;
    get bloom(): boolean;
    setLofi(enabled: boolean): void;
    setTime(timeSec: number): void;
    render(): void;
}
//# sourceMappingURL=post.d.ts.map