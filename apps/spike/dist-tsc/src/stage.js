import * as THREE from 'three/webgpu';
import { float, floor, mix, mx_noise_float, sin, smoothstep, uniform, uv, vec2, vec3 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { secondsPerBeat } from '@dmxsim/show-model';
import { FixtureRig } from './rig';
const VIEWS = [
    { position: [0, 6.5, 16], target: [0, 3.2, -3] },
    { position: [15, 6, 9], target: [0, 3.6, -4] },
    { position: [-15, 6, 9], target: [0, 3.6, -4] },
    { position: [0, 15, 7], target: [0, 1.5, -4] },
    { position: [0, 2.1, 5.5], target: [0, 5.5, -6] },
];
function addRoom(scene) {
    const wall = new THREE.MeshStandardMaterial({ color: 0x0b0d13, roughness: 0.85, metalness: 0.05 });
    const floor = new THREE.MeshStandardMaterial({ color: 0x0c0e14, roughness: 0.38, metalness: 0.25 });
    const stage = new THREE.MeshStandardMaterial({ color: 0x101319, roughness: 0.5, metalness: 0.2 });
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2d34, roughness: 0.4, metalness: 0.9 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 34), floor);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(0, 0, 3);
    ground.receiveShadow = true;
    scene.add(ground);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(40, 14), wall);
    back.position.set(0, 7, -12);
    back.receiveShadow = true;
    scene.add(back);
    for (const side of [-1, 1]) {
        const wallMesh = new THREE.Mesh(new THREE.PlaneGeometry(34, 14), wall);
        wallMesh.position.set(side * 17, 7, 3);
        wallMesh.rotation.y = -side * Math.PI * 0.5;
        wallMesh.receiveShadow = true;
        scene.add(wallMesh);
    }
    const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(40, 34), wall);
    ceiling.position.set(0, 12, 3);
    ceiling.rotation.x = Math.PI / 2;
    scene.add(ceiling);
    const riser = new THREE.Mesh(new THREE.BoxGeometry(24, 0.3, 9.4), stage);
    riser.position.set(0, 0.15, -7.3);
    riser.receiveShadow = true;
    riser.castShadow = true;
    scene.add(riser);
    for (const z of [1.6, -2.0, -5.6]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(21, 0.28, 0.28), metal);
        bar.position.set(0, 8, z);
        scene.add(bar);
        for (const x of [-10.5, 10.5]) {
            const tower = new THREE.Mesh(new THREE.BoxGeometry(0.24, 8.4, 0.24), metal);
            tower.position.set(x, 4.2, z);
            scene.add(tower);
        }
    }
    const booth = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.5, 1.4), stage);
    booth.position.set(0, 1.05, -9.7);
    booth.castShadow = true;
    booth.receiveShadow = true;
    scene.add(booth);
    const boothTop = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.08, 1.1), new THREE.MeshStandardMaterial({ color: 0x05060a, roughness: 0.3, metalness: 0.6 }));
    boothTop.position.set(0, 1.84, -9.7);
    scene.add(boothTop);
    const crowd = new THREE.InstancedMesh(new THREE.CapsuleGeometry(0.22, 0.92, 3, 6), new THREE.MeshStandardMaterial({ color: 0x08090d, roughness: 0.9, metalness: 0 }), 90);
    crowd.castShadow = true;
    crowd.receiveShadow = true;
    let seed = 1337;
    const random = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
    };
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < crowd.count; i += 1) {
        const x = (random() - 0.5) * 26;
        const z = 0.5 + random() * 14;
        const height = 0.85 + random() * 0.35;
        position.set(x, 0.95 * height, z);
        quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
        scale.set(1, height, 1);
        matrix.compose(position, quaternion, scale);
        crowd.setMatrixAt(i, matrix);
    }
    crowd.instanceMatrix.needsUpdate = true;
    scene.add(crowd);
}
export class Stage {
    scene = new THREE.Scene();
    camera;
    controls;
    rigs = [];
    pointLights = [];
    spot;
    ledUniforms = { time: uniform(0), energy: uniform(0.4) };
    edgeMaterial = new THREE.MeshBasicNodeMaterial();
    edgeUniforms = { color: uniform(new THREE.Color(0xffffff)), energy: uniform(0.5) };
    beatSec;
    viewIndex = 0;
    constructor(domElement, show) {
        this.beatSec = secondsPerBeat(show.beatGrid);
        this.scene.background = new THREE.Color(0x04060a);
        this.scene.fog = new THREE.FogExp2(0x05070c, 0.0135);
        this.camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 220);
        this.camera.position.set(...VIEWS[0].position);
        this.camera.lookAt(...VIEWS[0].target);
        this.controls = new OrbitControls(this.camera, domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.target.set(...VIEWS[0].target);
        this.controls.minDistance = 2;
        this.controls.maxDistance = 42;
        this.controls.maxPolarAngle = Math.PI * 0.495;
        this.controls.update();
        addRoom(this.scene);
        this.addLeds();
        this.addAtmosphere();
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
    addLeds() {
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
        const wall = new THREE.Mesh(new THREE.PlaneGeometry(13.5, 6.2), wallMaterial);
        wall.position.set(0, 4.9, -11.85);
        this.scene.add(wall);
        this.edgeMaterial.colorNode = this.edgeUniforms.color.mul(this.edgeUniforms.energy);
        this.edgeMaterial.fog = false;
        const edge = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.07, 0.07), this.edgeMaterial);
        edge.position.set(0, 1.84, -8.95);
        this.scene.add(edge);
        const stageEdge = new THREE.Mesh(new THREE.BoxGeometry(23.5, 0.06, 0.06), this.edgeMaterial);
        stageEdge.position.set(0, 0.32, -2.56);
        this.scene.add(stageEdge);
    }
    addAtmosphere() {
        const haze = new THREE.Mesh(new THREE.PlaneGeometry(40, 30), new THREE.MeshBasicNodeMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        }));
        const material = haze.material;
        const p = uv();
        const band = smoothstep(0.0, 0.55, p.y).mul(float(1).sub(smoothstep(0.55, 1.0, p.y)));
        material.colorNode = vec3(0.05, 0.07, 0.12).mul(band).mul(0.7);
        haze.rotation.x = -Math.PI / 2;
        haze.position.set(0, 0.25, 0);
        this.scene.add(haze);
    }
    setShow(show) {
        for (const rig of this.rigs)
            rig.removeFrom(this.scene);
        this.rigs.length = 0;
        for (const placement of show.fixtures) {
            const rig = new FixtureRig(placement);
            rig.addTo(this.scene);
            this.rigs.push(rig);
        }
    }
    setActiveCount(count) {
        this.rigs.forEach((rig, index) => rig.setVisible(index < count));
    }
    setView(index, immediate = false) {
        this.viewIndex = ((index % VIEWS.length) + VIEWS.length) % VIEWS.length;
        const view = VIEWS[this.viewIndex];
        this.camera.position.set(...view.position);
        if (immediate) {
            this.camera.lookAt(...view.target);
        }
        this.controls?.target.set(...view.target);
        this.controls?.update();
    }
    nextView() {
        this.setView(this.viewIndex + 1, true);
    }
    update(states, timeSec, options) {
        const byId = new Map(states.map((state) => [state.fixtureId, state]));
        for (const rig of this.rigs) {
            const state = byId.get(rig.placement.id);
            if (state)
                rig.update(state, timeSec, options.volumetrics);
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
            if (!state.active)
                continue;
            r += state.color.r * state.intensity;
            g += state.color.g * state.intensity;
            b += state.color.b * state.intensity;
            active += 1;
        }
        if (active > 0) {
            color.setRGB(r / active, g / active, b / active, THREE.SRGBColorSpace);
        }
        else {
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
    setShadows(enabled) {
        this.spot.castShadow = enabled;
    }
    get shadowCasting() {
        return this.spot.castShadow;
    }
}
//# sourceMappingURL=stage.js.map