import * as THREE from 'three/webgpu';
import {
  cos,
  float,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { FixturePlacement, FixtureState } from '@dmxsim/show-model';
import type { FixtureUpdateOptions } from './rig';

const DEG = Math.PI / 180;
/** Seconds for the plume to grow from the nozzle to full height. */
const RISE_SEC = 0.16;
/** Seconds for the plume to collapse once the clip ends. */
const FALL_SEC = 0.1;

/**
 * A CO2/cryo plume is a column of condensed vapour, not light. It is drawn as
 * a widening, turbulent cone with normal alpha blending so it reads as a solid
 * cold cloud rather than an additive glow. The noise scrolls downward, which
 * makes the vapour appear to travel away from the nozzle.
 */
function createPlumeMaterial() {
  const uTime = uniform(0);
  const uLevel = uniform(0);
  const uSeed = uniform(Math.random() * 64);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  // Cylinder UVs run 0 at the far end to 1 at the nozzle; flip so 0 is the
  // nozzle and 1 is the dissipating tip.
  const axial = float(1).sub(uv().y);
  /* Swirl the object-space sample coordinates so the vapour visibly churns
   * around the column; rotating the mesh itself would not move object-space
   * noise. */
  const swirl = uTime.mul(1.1).add(uSeed);
  const swirlX = positionLocal.x.mul(cos(swirl)).sub(positionLocal.z.mul(sin(swirl)));
  const swirlZ = positionLocal.x.mul(sin(swirl)).add(positionLocal.z.mul(cos(swirl)));
  /* Two noise octaves: large billows and finer churn. The fine octave moves
   * faster, which reads as turbulent vapour instead of a smooth cone. */
  const coarse = mx_noise_float(
    vec3(
      swirlX.mul(4.2).add(uSeed),
      positionLocal.y.mul(1.8).sub(uTime.mul(3.6)),
      swirlZ.mul(4.2).sub(uTime.mul(1.4)),
    ),
  );
  const fine = mx_noise_float(
    vec3(
      swirlX.mul(11.0).add(uSeed.mul(1.7)),
      positionLocal.y.mul(5.5).sub(uTime.mul(6.5)),
      swirlZ.mul(11.0).add(uSeed.mul(0.6)),
    ),
  );
  const billow = coarse.mul(0.9).add(fine.mul(0.55)).add(0.45).clamp(0, 1.8);

  const nozzleFade = smoothstep(0.0, 0.035, axial);
  const tailFade = float(1).sub(smoothstep(0.58, 1.0, axial));
  /* Fade the shell where it turns away from the camera, so the plume has a
   * soft volumetric edge instead of a cut-out cylinder silhouette. */
  const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
  const soft = smoothstep(0.02, 0.62, facing);
  const wisps = billow.mul(0.62).add(0.18);

  /* Keep the vapour below the bloom threshold: white-on-white turned the
   * plume into a flat glowing sheet. Cold grey-blue picks up the stage wash. */
  material.colorNode = mix(vec3(0.42, 0.52, 0.68), vec3(0.8, 0.88, 1.0), billow.mul(0.4));
  material.opacityNode = nozzleFade
    .mul(tailFade)
    .mul(wisps)
    .mul(soft)
    .mul(uLevel)
    .mul(0.56);
  material.fog = true;

  return { material, uTime, uLevel };
}

/** Thin cold mist pooling around the nozzle. */
function createSplashMaterial() {
  const uLevel = uniform(0);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
  const radius = uv().sub(0.5).length().mul(2);
  const core = float(1).sub(smoothstep(0.1, 1.0, radius));
  material.colorNode = vec3(0.82, 0.9, 1);
  material.opacityNode = core.mul(uLevel).mul(0.34);
  material.fog = true;
  return { material, uLevel };
}

/**
 * Camera-facing billow. A cone shell alone has a suspiciously clean edge; a
 * handful of noisy sprites stacked along the jet give it a broken, puffy
 * silhouette without a stateful particle system.
 */
function createPuffMaterial(seed: number) {
  const uTime = uniform(0);
  const uLevel = uniform(0);
  const uSeed = uniform(seed);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  const centered = uv().sub(0.5);
  const radius = centered.length().mul(2);
  const radial = float(1).sub(smoothstep(0.05, 1.0, radius));
  const coarse = mx_noise_float(
    vec3(
      centered.x.mul(7.0).add(uSeed),
      centered.y.mul(7.0).sub(uTime.mul(1.3)),
      uSeed,
    ),
  );
  const fine = mx_noise_float(
    vec3(
      centered.x.mul(17.0).sub(uTime.mul(2.8)),
      centered.y.mul(17.0).add(uSeed.mul(2.1)),
      uSeed,
    ),
  );
  const noise = coarse.mul(0.85).add(fine.mul(0.5)).add(0.5).clamp(0, 1.7);

  material.colorNode = mix(vec3(0.38, 0.48, 0.64), vec3(0.76, 0.84, 1.0), noise.mul(0.35));
  material.opacityNode = radial.mul(radial).mul(noise).mul(uLevel).mul(0.5);
  material.fog = true;

  return { material, uLevel, uTime };
}

interface Puff {
  mesh: THREE.Mesh;
  /** Position along the plume, 0 = nozzle, 1 = tip. */
  along: number;
}

/**
 * Renderer for cryo jets. The nozzle follows the fixture mount exactly like a
 * fixed light, while the plume always extends along the fixture's local -Y:
 * a floor jet authored with a 180° mount pitch therefore fires straight up.
 */
export class CryoJetRig {
  readonly root = new THREE.Group();

  /** Cryo jets are not room lights, so the light pool never promotes them. */
  readonly beamInfo = {
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(0, -1, 0),
    length: 1,
    spreadDeg: 1,
    level: 0,
    color: new THREE.Color(1, 1, 1),
    hit: null as { point: THREE.Vector3; normal: THREE.Vector3 } | null,
  };

  private readonly mount = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly nozzle: THREE.Mesh;
  private readonly plume: THREE.Mesh;
  private readonly plumeMaterial: ReturnType<typeof createPlumeMaterial>;
  private readonly splash: THREE.Mesh;
  private readonly splashMaterial: ReturnType<typeof createSplashMaterial>;
  private readonly puffMaterial: ReturnType<typeof createPuffMaterial>;
  private readonly puffs: Puff[] = [];
  /** Compile the effect pipelines while idle instead of on the first fire. */
  private warmupFrames = 3;
  private readonly headWorldQuaternion = new THREE.Quaternion();
  private readonly cameraLocalQuaternion = new THREE.Quaternion();
  private readonly flutterPhase = Math.random() * Math.PI * 2;
  private rise = 0;
  private fireStartSec: number | null = null;
  private lastSongSec: number | null = null;
  private enabled = true;

  constructor(readonly placement: FixturePlacement) {
    const { profile } = placement;
    this.root.position.set(placement.position.x, placement.position.y, placement.position.z);
    this.root.add(this.mount);
    this.applyMountAngle();

    this.head.rotation.y = placement.yawDeg * DEG;
    this.mount.add(this.head);

    const nozzleMaterial = new THREE.MeshStandardMaterial({
      color: 0x1a1e25,
      roughness: 0.42,
      metalness: 0.85,
    });
    this.nozzle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.11, 0.14, 0.26, 12),
      nozzleMaterial,
    );
    this.nozzle.position.y = -0.13;
    this.nozzle.castShadow = true;
    this.head.add(this.nozzle);

    // Unit cone: narrow at the nozzle (y = 0) and wide at the far end (y = -1).
    const plumeGeometry = new THREE.CylinderGeometry(0.13, 1, 1, 32, 12, true);
    plumeGeometry.translate(0, -0.5, 0);
    this.plumeMaterial = createPlumeMaterial();
    this.plume = new THREE.Mesh(plumeGeometry, this.plumeMaterial.material);
    this.plume.position.y = -0.3;
    this.plume.renderOrder = 2;
    this.plume.visible = false;
    this.head.add(this.plume);

    this.splash = new THREE.Mesh(
      new THREE.CircleGeometry(1, 32),
      (this.splashMaterial = createSplashMaterial()).material,
    );
    this.splash.position.y = -0.31;
    this.splash.rotation.x = -Math.PI / 2;
    this.splash.renderOrder = 1;
    this.splash.visible = false;
    this.head.add(this.splash);

    this.puffMaterial = createPuffMaterial(Math.random() * 64);
    for (const along of [0.14, 0.3, 0.46, 0.62, 0.78, 0.92]) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.puffMaterial.material);
      mesh.renderOrder = 3;
      mesh.visible = false;
      this.head.add(mesh);
      this.puffs.push({ mesh, along });
    }

    const nozzleRadius = profile.beam.apertureDiameterM / 2;
    this.nozzle.scale.setScalar(Math.max(0.5, nozzleRadius / 0.12));
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.root);
  }

  removeFrom(scene: THREE.Scene): void {
    scene.remove(this.root);
  }

  setVisible(visible: boolean): void {
    this.enabled = visible;
    this.root.visible = visible;
    if (!visible) {
      this.plume.visible = false;
      this.splash.visible = false;
      for (const puff of this.puffs) puff.mesh.visible = false;
    }
  }

  private applyMountAngle(): void {
    this.mount.rotation.x = -(this.placement.pitchOffsetDeg ?? 0) * DEG;
  }

  update(state: FixtureState, timeSec: number, options: FixtureUpdateOptions): void {
    this.root.position.set(
      this.placement.position.x,
      this.placement.position.y,
      this.placement.position.z,
    );
    this.applyMountAngle();
    this.head.rotation.y = this.placement.yawDeg * DEG;

    const level = this.enabled ? Math.min(1, Math.max(0, state.intensity)) : 0;
    const firing = level > 0.004;
    const warming = !firing && this.warmupFrames > 0;
    if (warming) this.warmupFrames -= 1;

    const jumped = this.lastSongSec !== null && Math.abs(timeSec - this.lastSongSec) > 0.3;
    const dt = this.lastSongSec === null
      ? 0
      : Math.max(0, Math.min(0.1, timeSec - this.lastSongSec));
    this.lastSongSec = timeSec;

    if (!options.playing) {
      // Editing/scrubbing shows the settled plume rather than a frozen start.
      this.rise = firing ? 1 : 0;
      this.fireStartSec = firing ? timeSec - RISE_SEC : null;
    } else if (!firing) {
      this.fireStartSec = null;
      this.rise = Math.max(0, this.rise - dt / FALL_SEC);
    } else {
      if (this.fireStartSec === null || jumped) {
        this.fireStartSec = jumped ? timeSec - RISE_SEC : timeSec;
      }
      this.rise = Math.min(1, Math.max(0, (timeSec - this.fireStartSec) / RISE_SEC));
    }

    const riseEase = this.rise * (2 - this.rise);
    /* The whole column shakes up and down, with a small lateral wander so
     * the jet does not read as a rigid cone. Frozen when paused because it is
     * driven by song time. */
    const flutter = Math.sin(timeSec * 55 + this.flutterPhase) * 0.10
      + Math.sin(timeSec * 87 + this.flutterPhase * 1.9) * 0.05
      + Math.sin(timeSec * 131 + this.flutterPhase * 0.7) * 0.02;
    const width = (0.42 + level * 0.18)
      * (0.68 + 0.32 * riseEase)
      * (1 + Math.sin(timeSec * 37 + this.flutterPhase) * 0.075 * riseEase);
    const length = Math.max(0.02, (3.4 + level * 3.6) * riseEase * (1 + flutter * riseEase));

    this.plumeMaterial.uTime.value = timeSec;
    this.plumeMaterial.uLevel.value = level * Math.min(1, 0.3 + riseEase * 0.9);
    this.plume.scale.set(width, length, width);
    this.plume.visible = (firing && this.rise > 0.02) || warming;

    this.splash.scale.setScalar((0.34 + level * 0.75) * (0.5 + 0.5 * riseEase));
    this.splashMaterial.uLevel.value = level * riseEase;
    this.splash.visible = (firing && this.rise > 0.02) || warming;

    // Puffs follow the camera and counter the fixture's own rotation so each
    // billow stays a flat card facing the viewer.
    this.head.updateWorldMatrix(true, false);
    this.head.getWorldQuaternion(this.headWorldQuaternion).invert();
    this.cameraLocalQuaternion.copy(this.headWorldQuaternion).multiply(options.camera.quaternion);
    this.puffMaterial.uTime.value = timeSec;
    this.puffMaterial.uLevel.value = level * (0.3 + riseEase * 0.7);
    for (const puff of this.puffs) {
      const along = puff.along;
      const puffPhase = timeSec * 52 + along * 6.5 + this.flutterPhase;
      const vertical = Math.sin(puffPhase) * 0.14 * riseEase;
      const swayX = Math.sin(timeSec * 38 + along * 4.2 + this.flutterPhase) * 0.16 * along * riseEase;
      const swayZ = Math.cos(timeSec * 31 + along * 3.4 + this.flutterPhase) * 0.16 * along * riseEase;
      const size = width * (1.35 + along * 3.4) * (0.45 + 0.55 * riseEase)
        * (1 + Math.sin(puffPhase * 1.9) * 0.14);
      puff.mesh.position.set(swayX, -0.3 - along * length + vertical, swayZ);
      puff.mesh.scale.set(size, size, 1);
      puff.mesh.quaternion.copy(this.cameraLocalQuaternion);
      puff.mesh.rotateZ(along * 2.4 + Math.sin(timeSec * 26 + along * 6 + this.flutterPhase) * 0.5);
      puff.mesh.visible = (firing && this.rise > 0.02) || warming;
    }

    this.beamInfo.origin.copy(this.root.position);
    this.beamInfo.level = 0;
  }
}
