import * as THREE from 'three/webgpu';
import {
  attribute,
  cameraPosition,
  float,
  mix,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3,
} from 'three/tsl';
import { DEFAULT_LASER_SETUP } from '@dmxsim/show-model';
import type {
  FixturePlacement,
  FixtureState,
  LaserPattern,
  LaserState,
} from '@dmxsim/show-model';
import { FixtureRig, intersectSurfaces, type SurfaceHit } from './rig';
import type { FixtureUpdateOptions } from './rig';

const DEG = Math.PI / 180;

/**
 * Camera-facing ribbon for one beam (ADR-012). Each beam is 4 vertices and 2
 * triangles; the shader builds the ribbon in world space from the beam's
 * direction so the quad always faces the camera, which keeps razor-thin
 * beams visible from every angle without a 30-sided cone silhouette.
 */
function createLaserBeamMaterial(halfWidthM: number) {
  const uColor = uniform(new THREE.Color(1, 1, 1));
  const uIntensity = uniform(0);
  /** World-space aperture position of the projector. */
  const uOrigin = uniform(new THREE.Vector3());
  /** Scene haze, 0..1. Beams are only visible where light scatters off it. */
  const uHaze = uniform(1);

  const aDir = attribute('aDir', 'vec3');
  const aT = attribute('aT', 'float');
  const aW = attribute('aW', 'float');
  const aLen = attribute('aLen', 'float');

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const world = uOrigin.add(aDir.mul(aT.mul(aLen)));
  const viewDir = cameraPosition.sub(world).normalize();
  /* Perpendicular to the beam and in the camera plane, so the ribbon always
   * faces the viewer. The +1e-5 keeps a dead-centre view of the beam axis
   * from producing a zero-length cross product (NaN). */
  const sideCross = aDir.cross(viewDir);
  const side = sideCross.div(sideCross.length().add(1e-5));
  const distance = cameraPosition.sub(world).length();
  /* Width is world-space, with a floor in angular terms so distant beams do
   * not alias. The floor is ~3 px of half-width at typical FOV: at 1 px the
   * ribbon under-samples and breaks into dashes. Bloom supplies the glow on
   * top of this. */
  const halfWidth = float(halfWidthM).max(distance.mul(0.0022));

  material.positionNode = world.add(side.mul(aW.mul(halfWidth)));
  material.fog = true;

  const vT = varying(aT, 'vT');
  const vW = varying(aW, 'vW');
  const vEnd = varying(attribute('aEnd', 'float'), 'vEnd');

  /* Cross-section: a hot near-white core with a saturated coloured halo.
   * The profile is smooth (no hard edge at w = ±1) so the widened ribbon does
   * not show a stair-step edge; additive blending accumulates overlapping
   * neighbours into a continuous line. */
  const across = float(1).sub(vW.mul(vW));
  const core = across.mul(across).mul(across);
  const halo = across.mul(across).mul(1.6).add(across.mul(0.35));
  const beamColor = mix(uColor, vec3(1), 0.55).mul(core.mul(1.4)).add(uColor.mul(halo.mul(0.45)));
  /* A laser stays bright across the room; only a shallow axial falloff. */
  const axial = mix(1, 0.55, vT);
  /* A beam with nowhere to land dissolves over the tail instead of ending in
   * a flat cap; a surface hit keeps the hard end because the dot carries it. */
  const endFade = mix(float(1).sub(smoothstep(0.88, 1, vT)), 1, vEnd);
  const haze = uHaze.clamp(0, 1);

  material.colorNode = beamColor
    .mul(axial)
    .mul(endFade)
    .mul(haze.mul(haze))
    .mul(uIntensity);

  return { material, uColor, uIntensity, uOrigin, uHaze };
}

/** Additive splat where a beam lands on a surface. */
function createDotMaterial() {
  const uColor = uniform(new THREE.Color(1, 1, 1));
  const uIntensity = uniform(1);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const d = uv().sub(0.5).length().mul(2);
  const core = float(1).sub(smoothstep(0.0, 0.35, d));
  const halo = float(1).sub(smoothstep(0.2, 1.0, d));

  material.colorNode = mix(uColor, vec3(1), core.mul(0.6))
    .mul(core.mul(core).mul(1.6).add(halo.mul(0.4)))
    .mul(uIntensity);
  material.fog = false;

  return { material, uColor, uIntensity };
}

/** Per-beam arrangement directions, computed on the CPU (at most 32 beams). */
function patternDirections(
  pattern: LaserPattern,
  beams: number,
  fanRad: number,
  phase: number,
  out: Float32Array,
): void {
  const count = beams;
  for (let i = 0; i < count; i += 1) {
    let dx = 0;
    let dy = -1;
    let dz = 0;

    if (pattern === 'tunnel') {
      /* Beams on a circle around the head axis; `fanDeg` is the cone
       * half-angle, and the circle rotates with the scanner phase. */
      const half = fanRad;
      const theta = (i / count) * Math.PI * 2 + phase;
      const sinHalf = Math.sin(half);
      dx = sinHalf * Math.cos(theta);
      dz = sinHalf * Math.sin(theta);
      dy = -Math.cos(half);
    } else if (pattern === 'lattice') {
      /* Two orthogonal fans (local X plane and local Z plane) rotating in
       * opposite directions. */
      const firstFan = Math.ceil(count / 2);
      const inX = i < firstFan;
      const j = inX ? i : i - firstFan;
      const n = inX ? firstFan : count - firstFan;
      const a = (n > 1 ? (j / (n - 1) - 0.5) * fanRad : 0) + phase * (inX ? 1 : -1);
      if (inX) {
        dx = Math.sin(a);
        dy = -Math.cos(a);
      } else {
        dz = Math.sin(a);
        dy = -Math.cos(a);
      }
    } else {
      /* fan / sweep / wave / dots(fallback): an even fan in the head's local
       * X plane. Sweep translates the fan centre with the phase; wave adds a
       * travelling per-beam offset. */
      const n = Math.max(1, count);
      let a = n > 1 ? (i / (n - 1) - 0.5) * fanRad : 0;
      if (pattern === 'sweep') a += Math.sin(phase) * fanRad * 0.5;
      if (pattern === 'wave') a += Math.sin(phase + (i / n) * Math.PI * 2) * fanRad * 0.12;
      dx = Math.sin(a);
      dy = -Math.cos(a);
    }

    out[i * 3] = dx;
    out[i * 3 + 1] = dy;
    out[i * 3 + 2] = dz;
  }
}

/**
 * Renderer for laser fixtures: several razor-thin beams from one aperture,
 * arranged by pattern, terminating in visible dots on venue surfaces.
 */
export class LaserRig {
  readonly root = new THREE.Group();

  /**
   * Live aim for this frame. Lasers do not drive the room-light pool
   * (`level` stays 0): they are purely additive renders.
   */
  readonly beamInfo = {
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(0, -1, 0),
    length: 1,
    spreadDeg: 1,
    level: 0,
    color: new THREE.Color(),
    hit: null as { point: THREE.Vector3; normal: THREE.Vector3 } | null,
  };

  /**
   * Beams and splats are built in world space (the shader writes world
   * positions into `positionLocal`, which three then multiplies by the model
   * matrix). They must therefore live under an untransformed group, not under
   * `root`, or the fixture's own transform would be applied twice.
   */
  private readonly effects = new THREE.Group();
  private readonly mount = new THREE.Group();
  private readonly yoke = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly maxBeams: number;
  private readonly beamGeometry: THREE.BufferGeometry;
  private readonly beamDir: Float32Array;
  private readonly beamLen: Float32Array;
  private readonly beamEnd: Float32Array;
  private readonly beamMaterial: ReturnType<typeof createLaserBeamMaterial>;
  private readonly dots: THREE.InstancedMesh;
  private readonly dotMaterial: ReturnType<typeof createDotMaterial>;
  private readonly directions: Float32Array;
  private readonly hits: (SurfaceHit | null)[] = [];
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly matrix = new THREE.Matrix4();
  private readonly dotPosition = new THREE.Vector3();
  private readonly dotQuaternion = new THREE.Quaternion();
  private readonly dotScale = new THREE.Vector3();
  private enabled = true;

  constructor(readonly placement: FixturePlacement) {
    const { profile } = placement;
    this.maxBeams = Math.max(1, profile.laser?.maxBeams ?? DEFAULT_LASER_SETUP.beams);

    this.root.position.set(placement.position.x, placement.position.y, placement.position.z);
    this.root.add(this.mount);
    this.mount.rotation.x = -(placement.pitchOffsetDeg ?? 0) * DEG;

    /* Compact scanner body: box base, yoke, head cylinder, small lens. */
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.36, 0.2, 0.3),
      new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.6, metalness: 0.65 }),
    );
    base.castShadow = true;
    this.root.add(base);

    this.yoke.position.y = -0.14;
    this.mount.add(this.yoke);
    const yokeMaterial = new THREE.MeshStandardMaterial({ color: 0x0e1014, roughness: 0.45, metalness: 0.8 });
    for (const x of [-0.22, 0.22]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.42, 0.18), yokeMaterial);
      arm.position.set(x, -0.21, 0);
      arm.castShadow = true;
      this.yoke.add(arm);
    }
    this.head.position.y = -0.44;
    this.yoke.add(this.head);
    const headMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.19, 0.22, 0.44, 12),
      new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.6, metalness: 0.65 }),
    );
    headMesh.castShadow = true;
    this.head.add(headMesh);
    const lens = new THREE.Mesh(
      new THREE.CircleGeometry(profile.beam.apertureDiameterM / 2, 12),
      new THREE.MeshBasicNodeMaterial({ color: 0x000000 }),
    );
    lens.position.y = -0.23;
    lens.rotation.x = Math.PI / 2;
    this.head.add(lens);

    /* One ribbon quad per beam. Direction, length, and end mode are per-beam
     * attributes rewritten each frame; the quad corners are static. */
    this.beamDir = new Float32Array(this.maxBeams * 4 * 3);
    this.beamLen = new Float32Array(this.maxBeams * 4);
    this.beamEnd = new Float32Array(this.maxBeams * 4);
    const aT = new Float32Array(this.maxBeams * 4);
    const aW = new Float32Array(this.maxBeams * 4);
    const indices = new Uint16Array(this.maxBeams * 6);
    for (let b = 0; b < this.maxBeams; b += 1) {
      const v = b * 4;
      aT[v] = 0; aW[v] = -1;
      aT[v + 1] = 0; aW[v + 1] = 1;
      aT[v + 2] = 1; aW[v + 2] = -1;
      aT[v + 3] = 1; aW[v + 3] = 1;
      indices.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], b * 6);
    }
    this.beamGeometry = new THREE.BufferGeometry();
    /* The vertex shader builds positions from `aDir`/`aT`; three still looks
     * for a `position` attribute, so keep a zeroed one to avoid a warning. */
    this.beamGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(this.maxBeams * 4 * 3), 3),
    );
    this.beamGeometry.setAttribute('aDir', new THREE.BufferAttribute(this.beamDir, 3));
    this.beamGeometry.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
    this.beamGeometry.setAttribute('aW', new THREE.BufferAttribute(aW, 1));
    this.beamGeometry.setAttribute('aLen', new THREE.BufferAttribute(this.beamLen, 1));
    this.beamGeometry.setAttribute('aEnd', new THREE.BufferAttribute(this.beamEnd, 1));
    this.beamGeometry.setIndex(new THREE.BufferAttribute(indices, 1));
    /* Full-throw beams can sit anywhere in the room; skip frustum tests. */
    this.beamGeometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.beamMaterial = createLaserBeamMaterial(profile.beam.apertureDiameterM / 2);
    const beam = new THREE.Mesh(this.beamGeometry, this.beamMaterial.material);
    beam.renderOrder = 2;
    beam.frustumCulled = false;
    this.effects.add(beam);

    this.directions = new Float32Array(this.maxBeams * 3);
    for (let i = 0; i < this.maxBeams; i += 1) this.hits.push(null);

    this.dotMaterial = createDotMaterial();
    this.dots = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), this.dotMaterial.material, this.maxBeams);
    this.dots.renderOrder = 3;
    this.dots.frustumCulled = false;
    this.dots.count = 0;
    this.effects.add(this.dots);
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.root, this.effects);
  }

  removeFrom(scene: THREE.Scene): void {
    scene.remove(this.root, this.effects);
  }

  setVisible(visible: boolean): void {
    this.enabled = visible;
    this.root.visible = visible;
    this.effects.visible = visible;
  }

  update(state: FixtureState, _timeSec: number, options: FixtureUpdateOptions): void {
    this.root.position.set(
      this.placement.position.x,
      this.placement.position.y,
      this.placement.position.z,
    );
    this.mount.rotation.x = -(this.placement.pitchOffsetDeg ?? 0) * DEG;
    const yaw = this.placement.yawDeg + state.panDeg;
    this.yoke.rotation.y = yaw * DEG;
    this.head.rotation.x = -state.tiltDeg * DEG;

    const laser: LaserState = state.laser ?? {
      ...DEFAULT_LASER_SETUP,
      phase: 0,
    };
    const beams = Math.min(this.maxBeams, Math.max(1, laser.beams));
    const level = Math.max(0, state.intensity);
    const color = this.color.setRGB(state.color.r, state.color.g, state.color.b, THREE.SRGBColorSpace);

    this.beamMaterial.uColor.value.copy(color);
    this.beamMaterial.uIntensity.value = level * 1.1;
    this.beamMaterial.uHaze.value = Math.max(0, options.haze);
    this.dotMaterial.uColor.value.copy(color);
    this.dotMaterial.uIntensity.value = level * 2.2;

    this.head.updateWorldMatrix(true, false);
    this.origin.set(0, -0.24, 0);
    this.head.localToWorld(this.origin);

    patternDirections(
      laser.pattern,
      beams,
      laser.fanDeg * DEG,
      laser.phase,
      this.directions,
    );

    /* Intersect every beam against the venue surfaces so ribbons terminate
     * exactly on geometry and each hit gets a dot (beams × surfaces, cheap). */
    const throwM = this.placement.profile.beam.throwM;
    let dotCount = 0;
    for (let i = 0; i < beams; i += 1) {
      this.direction.set(
        this.directions[i * 3]!,
        this.directions[i * 3 + 1]!,
        this.directions[i * 3 + 2]!,
      ).transformDirection(this.head.matrixWorld);
      const hit = intersectSurfaces(this.origin, this.direction, options.surfaces, throwM);
      this.hits[i] = hit;
      const length = hit !== null ? hit.distance : throwM;

      for (let v = 0; v < 4; v += 1) {
        const index = (i * 4 + v) * 3;
        this.beamDir[index] = this.direction.x;
        this.beamDir[index + 1] = this.direction.y;
        this.beamDir[index + 2] = this.direction.z;
        this.beamLen[i * 4 + v] = length;
        this.beamEnd[i * 4 + v] = hit !== null ? 1 : 0;
      }

      /* Dot splat: size from the beam's own divergence at that distance. */
      if (hit !== null && level > 0.004) {
        const divergence = Math.max(0.2, laser.divergenceDeg) * DEG;
        const size = THREE.MathUtils.clamp(hit.distance * divergence, 0.06, 0.5);
        this.dotPosition.set(
          hit.point.x + hit.normal.x * 0.01,
          hit.point.y + hit.normal.y * 0.01,
          hit.point.z + hit.normal.z * 0.01,
        );
        this.dotQuaternion.copy(options.camera.quaternion);
        this.dotScale.set(size, size, 1);
        this.matrix.compose(this.dotPosition, this.dotQuaternion, this.dotScale);
        this.dots.setMatrixAt(dotCount, this.matrix);
        dotCount += 1;
      }
    }

    this.beamMaterial.uOrigin.value.copy(this.origin);
    this.beamGeometry.attributes.aDir!.needsUpdate = true;
    this.beamGeometry.attributes.aLen!.needsUpdate = true;
    this.beamGeometry.attributes.aEnd!.needsUpdate = true;
    this.beamGeometry.setDrawRange(0, beams * 6);

    this.dots.count = dotCount;
    if (dotCount > 0) this.dots.instanceMatrix.needsUpdate = true;

    /* Publish the aim for the room-light pool: lasers stay at level 0. */
    const info = this.beamInfo;
    info.origin.copy(this.origin);
    info.direction.set(this.directions[1]!, 0, 0);
    info.direction.set(0, -1, 0).transformDirection(this.head.matrixWorld);
    info.length = throwM;
    info.spreadDeg = laser.fanDeg;
    info.level = 0;
    info.color.copy(color);
    info.hit = null;
  }
}

/**
 * Rig factory: lasers get the dedicated beam renderer (ADR-012), everything
 * else the cone-based moving-head path.
 */
export function createFixtureRig(placement: FixturePlacement): FixtureRig | LaserRig {
  return placement.profile.kind === 'laser' ? new LaserRig(placement) : new FixtureRig(placement);
}
