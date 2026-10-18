import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { FixtureState, Show } from '@dmxsim/show-model';
export interface StageUpdateOptions {
    volumetrics: boolean;
}
export declare class Stage {
    readonly scene: THREE.Scene<THREE.Object3DEventMap>;
    readonly camera: THREE.PerspectiveCamera;
    readonly controls: OrbitControls;
    private readonly rigs;
    private readonly pointLights;
    private readonly spot;
    private readonly ledUniforms;
    private readonly edgeMaterial;
    private readonly edgeUniforms;
    private readonly beatSec;
    private viewIndex;
    constructor(domElement: HTMLElement, show: Show);
    private addLeds;
    private addAtmosphere;
    setShow(show: Show): void;
    setActiveCount(count: number): void;
    setView(index: number, immediate?: boolean): void;
    nextView(): void;
    update(states: readonly FixtureState[], timeSec: number, options: StageUpdateOptions): void;
    setShadows(enabled: boolean): void;
    get shadowCasting(): boolean;
}
//# sourceMappingURL=stage.d.ts.map