import * as THREE from 'three/webgpu';
import type { FixturePlacement, FixtureState } from '@dmxsim/show-model';
export declare class FixtureRig {
    readonly placement: FixturePlacement;
    readonly root: THREE.Group<THREE.Object3DEventMap>;
    private readonly yoke;
    private readonly head;
    private readonly beam;
    private readonly beamMaterial;
    private readonly pool;
    private readonly poolMaterial;
    private readonly lensMaterial;
    private readonly lensColor;
    private readonly lensGlow;
    private readonly beamLength;
    private readonly color;
    private readonly beamOrigin;
    private readonly beamDirection;
    private enabled;
    constructor(placement: FixturePlacement);
    addTo(scene: THREE.Scene): void;
    removeFrom(scene: THREE.Scene): void;
    setVisible(visible: boolean): void;
    update(state: FixtureState, timeSec: number, volumetrics: boolean): void;
}
//# sourceMappingURL=rig.d.ts.map