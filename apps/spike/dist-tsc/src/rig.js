import * as THREE from 'three/webgpu';
import { float, mx_noise_float, normalView, positionLocal, positionViewDirection, smoothstep, uniform, uv, vec3, } from 'three/tsl';
const DEG = Math.PI / 180;
const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.6, metalness: 0.65 });
const yokeMaterial = new THREE.MeshStandardMaterial({ color: 0x0e1014, roughness: 0.45, metalness: 0.8 });
function createBeamMaterial() {
    const uColor = uniform(new THREE.Color(1, 1, 1));
    const uIntensity = uniform(0);
    const uTime = uniform(0);
    const uSeed = uniform(Math.random() * 64);
    const material = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
    });
    const axial = positionLocal.y.negate();
    const axialFade = smoothstep(0, 0.04, axial).mul(float(1).sub(axial.mul(0.85)));
    const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
    const soft = smoothstep(0, 0.9, facing);
    const noise = mx_noise_float(vec3(positionLocal.x.mul(3.2).add(uSeed), positionLocal.y.mul(1.6).sub(uTime.mul(0.55)), positionLocal.z.mul(3.2)));
    const haze = noise.mul(0.32).add(0.82);
    const brightness = axialFade.mul(soft).mul(haze).mul(uIntensity);
    material.colorNode = uColor.mul(brightness);
    material.fog = true;
    return { material, uColor, uIntensity, uTime };
}
function createPoolMaterial() {
    const uColor = uniform(new THREE.Color(1, 1, 1));
    const uIntensity = uniform(0);
    const uTime = uniform(0);
    const material = new THREE.MeshBasicNodeMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
    });
    const radius = uv().sub(0.5).length().mul(2);
    const falloff = float(1).sub(smoothstep(0.1, 1.0, radius));
    const ring = smoothstep(0.55, 0.92, radius).mul(float(1).sub(smoothstep(0.92, 1.0, radius))).mul(0.4);
    const noise = mx_noise_float(vec3(uv().mul(7), uTime.mul(0.25))).mul(0.2).add(0.9);
    material.colorNode = uColor.mul(falloff.add(ring)).mul(noise).mul(uIntensity);
    material.fog = true;
    return { material, uColor, uIntensity, uTime };
}
export class FixtureRig {
    placement;
    root = new THREE.Group();
    yoke = new THREE.Group();
    head = new THREE.Group();
    beam;
    beamMaterial;
    pool;
    poolMaterial;
    lensMaterial;
    lensColor = uniform(new THREE.Color(0x000000));
    lensGlow = uniform(0);
    beamLength;
    color = new THREE.Color();
    beamOrigin = new THREE.Vector3();
    beamDirection = new THREE.Vector3();
    enabled = true;
    constructor(placement) {
        this.placement = placement;
        const { profile } = placement;
        const kind = profile.kind;
        this.root.position.set(placement.position.x, placement.position.y, placement.position.z);
        const isMovingFixture = kind === 'moving-head' || kind === 'wash' || kind === 'laser';
        if (isMovingFixture) {
            const baseGeometry = kind === 'laser'
                ? new THREE.BoxGeometry(0.36, 0.2, 0.3)
                : new THREE.CylinderGeometry(0.24, 0.3, 0.16, 10);
            const base = new THREE.Mesh(baseGeometry, bodyMaterial);
            base.castShadow = true;
            this.root.add(base);
            this.yoke.position.y = -0.14;
            this.root.add(this.yoke);
            const arm = new THREE.BoxGeometry(0.07, 0.42, 0.18);
            const left = new THREE.Mesh(arm, yokeMaterial);
            left.position.set(-0.22, -0.21, 0);
            left.castShadow = true;
            const right = new THREE.Mesh(arm, yokeMaterial);
            right.position.set(0.22, -0.21, 0);
            right.castShadow = true;
            this.yoke.add(left, right);
            this.head.position.y = -0.44;
            this.yoke.add(this.head);
        }
        else {
            const housingGeometry = kind === 'par'
                ? new THREE.CylinderGeometry(0.2, 0.25, 0.46, 12)
                : kind === 'strobe'
                    ? new THREE.BoxGeometry(0.82, 0.22, 0.34)
                    : kind === 'blinder'
                        ? new THREE.BoxGeometry(0.95, 0.24, 0.4)
                        : new THREE.BoxGeometry(1.1, 0.12, 0.16);
            const housing = new THREE.Mesh(housingGeometry, bodyMaterial);
            housing.position.y = kind === 'par' ? 0 : -0.05;
            housing.castShadow = true;
            this.root.add(housing);
            this.head.position.y = kind === 'par' ? 0 : -0.05;
            this.root.add(this.head);
        }
        if (kind === 'strobe' || kind === 'blinder') {
            const face = new THREE.Mesh(new THREE.BoxGeometry(kind === 'strobe' ? 0.58 : 0.72, 0.04, 0.2), yokeMaterial);
            face.position.y = -0.17;
            this.head.add(face);
        }
        else if (kind === 'led-strip') {
            const strip = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.04), yokeMaterial);
            strip.position.y = -0.1;
            this.head.add(strip);
        }
        const headMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.44, 12), bodyMaterial);
        headMesh.castShadow = true;
        if (isMovingFixture)
            this.head.add(headMesh);
        this.lensMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
        this.lensMaterial.colorNode = this.lensColor.mul(this.lensGlow);
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.17, 16), this.lensMaterial);
        lens.position.y = -0.23;
        lens.rotation.x = Math.PI / 2;
        this.head.add(lens);
        const cone = new THREE.ConeGeometry(1, 1, 30, 1, true);
        cone.translate(0, -0.5, 0);
        this.beamMaterial = createBeamMaterial();
        this.beam = new THREE.Mesh(cone, this.beamMaterial.material);
        this.beam.position.y = -0.24;
        this.beam.renderOrder = 2;
        this.beam.visible = false;
        this.head.add(this.beam);
        this.beamLength = profile.beam.throwM;
        this.poolMaterial = createPoolMaterial();
        const poolGeometry = new THREE.CircleGeometry(1, 36);
        poolGeometry.rotateX(-Math.PI / 2);
        this.pool = new THREE.Mesh(poolGeometry, this.poolMaterial.material);
        this.pool.renderOrder = 1;
        this.pool.visible = false;
    }
    addTo(scene) {
        scene.add(this.root, this.pool);
    }
    removeFrom(scene) {
        scene.remove(this.root, this.pool);
    }
    setVisible(visible) {
        this.enabled = visible;
        this.root.visible = visible;
        if (!visible)
            this.pool.visible = false;
    }
    update(state, timeSec, volumetrics) {
        const yaw = this.placement.yawDeg + state.panDeg;
        this.yoke.rotation.y = yaw * DEG;
        this.head.rotation.x = -state.tiltDeg * DEG;
        const strobeOn = state.strobeHz > 0 ? Math.floor(timeSec * state.strobeHz) % 2 === 0 : true;
        const level = state.intensity * (strobeOn ? 1 : 0);
        const color = this.color.setRGB(state.color.r, state.color.g, state.color.b, THREE.SRGBColorSpace);
        const spread = Math.max(0.2, state.spreadDeg);
        const isLaser = this.placement.profile.kind === 'laser';
        const gain = isLaser ? 9 : 1;
        this.beamMaterial.uColor.value.copy(color);
        this.beamMaterial.uIntensity.value = level * 1.05 * gain;
        this.beamMaterial.uTime.value = timeSec;
        this.lensColor.value.copy(color);
        this.lensGlow.value = level > 0.004 ? 0.12 + level * 5 : 0;
        this.poolMaterial.uColor.value.copy(color);
        this.poolMaterial.uTime.value = timeSec;
        this.poolMaterial.uIntensity.value = level * 0.16;
        this.head.updateWorldMatrix(true, false);
        const origin = this.head.localToWorld(this.beamOrigin.set(0, -0.24, 0));
        const direction = this.beamDirection.set(0, -1, 0).transformDirection(this.head.matrixWorld);
        let floorY = 0;
        let hitDistance = direction.y < -0.02 ? (origin.y - floorY) / -direction.y : Number.POSITIVE_INFINITY;
        let hitX = origin.x + direction.x * hitDistance;
        let hitZ = origin.z + direction.z * hitDistance;
        if (hitX > -11 && hitX < 11 && hitZ > -12 && hitZ < -2.6) {
            floorY = 0.3;
            hitDistance = direction.y < -0.02 ? (origin.y - floorY) / -direction.y : Number.POSITIVE_INFINITY;
            hitX = origin.x + direction.x * hitDistance;
            hitZ = origin.z + direction.z * hitDistance;
        }
        const length = Math.min(this.beamLength, Math.max(0.6, hitDistance));
        const radius = Math.tan((spread * DEG) / 2) * length;
        this.beam.scale.set(radius, length, radius);
        this.beam.visible = this.enabled && volumetrics && level > 0.004;
        if (this.enabled && level > 0.004 && Number.isFinite(hitDistance) && hitDistance > 0.5) {
            this.pool.position.set(hitX, floorY + 0.012, hitZ);
            const poolRadius = Math.max(0.35, Math.tan((spread * DEG) / 2) * hitDistance * 2.4);
            this.pool.scale.set(poolRadius, 1, poolRadius);
            this.poolMaterial.uIntensity.value = (level * 0.16 * (isLaser ? 0.05 : 1)) / (1 + hitDistance * 0.12);
            this.pool.visible = level > 0.004;
        }
        else {
            this.pool.visible = false;
        }
    }
}
//# sourceMappingURL=rig.js.map