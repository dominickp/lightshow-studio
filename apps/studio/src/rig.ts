import * as THREE from 'three/webgpu';
import {
  float,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import type { FixturePlacement, FixtureState, VenueSurface } from '@dmxsim/show-model';

const DEG = Math.PI / 180;

/** Per-frame inputs a fixture rig needs beyond its own state. */
export interface FixtureUpdateOptions {
  volumetrics: boolean;
  /** True while the transport is playing; cue effects freeze when paused. */
  playing?: boolean;
  /** Scene haze, 0..1. Beams are only visible when light scatters off it. */
  haze: number;
  camera: THREE.Camera;
  /** Planes a beam can terminate on (venue data, ADR-011). */
  surfaces: readonly VenueSurface[];
}

export interface SurfaceHit {
  distance: number;
  point: THREE.Vector3;
  /** Points back toward the beam so decals sit on the lit side. */
  normal: THREE.Vector3;
  surface: VenueSurface;
}

const BOUNDS_EPSILON = 1e-3;

/**
 * Surface decals a single fixture can own at once.
 *
 * A cone is not limited to one surface: a wide wash over the stage lip covers
 * the dance floor in front *and* the stage top, and light grazing a wall also
 * lands on the riser. One decal per surface, nearest first, is what makes a
 * beam read as landing on two objects instead of only the one its centre axis
 * happens to hit.
 */
const POOL_DECALS = 3;
/** Steepest slope stretch a grazing footprint is allowed (matches the old decal). */
const MAX_STRETCH = 4;
/** "No limit" for the clip box axis a decal lies on. */
const CLIP_OPEN = 1e6;
/** Feather on the bounds cut, metres. */
const POOL_EDGE_FEATHER = 0.035;
/** Shared unit disc every surface decal is scaled from. */
const POOL_GEOMETRY = new THREE.CircleGeometry(1, 48);
/** Name on every decal mesh, so the scene can be inspected (and tested). */
export const POOL_MESH_NAME = 'beam-pool';

function surfaceNormal(surface: VenueSurface, direction: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
  if (surface.axis === 'x') target.set(1, 0, 0);
  else if (surface.axis === 'z') target.set(0, 0, 1);
  else target.set(0, 1, 0);
  if (target.dot(direction) > 0) target.negate();
  return target;
}

/**
 * Ray/plane hit on one venue surface, or `null` when the ray misses.
 */
function intersectSurface(
  surface: VenueSurface,
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  limit: number,
): SurfaceHit | null {
  const component = direction[surface.axis];
  if (Math.abs(component) < 1e-4) return null;

  const distance = (surface.value - origin[surface.axis]) / component;
  if (distance <= 0.05 || distance > limit) return null;

  const x = origin.x + direction.x * distance;
  const y = origin.y + direction.y * distance;
  const z = origin.z + direction.z * distance;
  const bounds = surface.bounds;
  const slack = BOUNDS_EPSILON;
  if (bounds !== null) {
    if (x < bounds.x[0] - slack || x > bounds.x[1] + slack) return null;
    if (y < bounds.y[0] - slack || y > bounds.y[1] + slack) return null;
    if (z < bounds.z[0] - slack || z > bounds.z[1] + slack) return null;
  }

  return {
    distance,
    point: new THREE.Vector3(x, y, z),
    normal: surfaceNormal(surface, direction, new THREE.Vector3()),
    surface,
  };
}

/** Nearest venue surface along a ray, or `null` when the ray escapes. */
export function intersectSurfaces(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  surfaces: readonly VenueSurface[],
  limit: number,
): SurfaceHit | null {
  let best: SurfaceHit | null = null;

  for (const surface of surfaces) {
    const hit = intersectSurface(surface, origin, direction, limit);
    if (hit === null) continue;
    if (best !== null && hit.distance >= best.distance) continue;
    best = hit;
  }

  return best;
}

/**
 * One decal slot: a surface a fixture's cone covers, with the basis of the
 * ellipse the cone projects onto it.
 *
 * Preallocated per rig and rewritten each frame (only the nearest
 * `POOL_DECALS` candidates survive), so a beam crossing two surfaces does not
 * churn garbage in the frame loop.
 */
interface PoolSlot {
  surface: VenueSurface | null;
  distance: number;
  /** Cone radius at the hit, metres. */
  radius: number;
  /** Slope stretch along the beam's shadow direction. */
  stretch: number;
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly tangent: THREE.Vector3;
  readonly bitangent: THREE.Vector3;
  /** World-space box the decal is cut to (surface bounds, open on its axis). */
  readonly clipMin: THREE.Vector3;
  readonly clipMax: THREE.Vector3;
}

const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x15171d, roughness: 0.6, metalness: 0.65 });
const yokeMaterial = new THREE.MeshStandardMaterial({ color: 0x0e1014, roughness: 0.45, metalness: 0.8 });

function createBeamMaterial() {
  const uColor = uniform(new THREE.Color(1, 1, 1));
  const uIntensity = uniform(0);
  const uTime = uniform(0);
  const uSeed = uniform(Math.random() * 64);
  /** Beam length in metres, only to convert the fade length into unit space. */
  const uLength = uniform(1);
  /**
   * Fade length at the far end, metres. A beam that escapes into the room
   * dissolves over ~0.9 m instead of ending in a flat rim; a beam that lands
   * on a surface keeps the original hard end, because the floor pool carries
   * the landing and a dark band there read worse than the rim.
   */
  const uEndFade = uniform(0);
  /** Scene haze, 0..1. Beams are only visible where light scatters off it. */
  const uHaze = uniform(1);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  /* Local-space formulation, kept from the original renderer: the shading is
   * driven by where the fragment sits along the beam and by the surface
   * normal, not by a per-fragment ray/cone integral. A world-space integral
   * was tried here (it solved the view ray against the cone quadratic) and
   * reverted: it had no normal term, so it shaded the cone like a slab, and
   * its chord collapses to zero at the end plane, which painted a dark ring
   * around every beam base. */
  const axial = positionLocal.y.negate();
  const axialFade = smoothstep(0, 0.04, axial).mul(float(1).sub(axial.mul(0.85)));
  const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
  const soft = smoothstep(0, 0.9, facing);
  const noise = mx_noise_float(
    vec3(
      positionLocal.x.mul(3.2).add(uSeed),
      positionLocal.y.mul(1.6).sub(uTime.mul(0.55)),
      positionLocal.z.mul(3.2),
    ),
  );
  const haze = noise.mul(0.32).add(0.82);
  /* Fade the tail of beams with nowhere to land. Unit axial runs 0..1 over the
   * whole mesh, so the metre fade length converts through the beam length. */
  const endFade = float(1).sub(smoothstep(
    float(1).sub(uEndFade.div(uLength.max(0.001))).max(0),
    1,
    axial,
  ));
  const brightness = axialFade
    .mul(endFade)
    .mul(soft)
    .mul(haze)
    /* Quadratic in haze: air scatter is the *only* reason a beam is visible, so
     * thinning the haze should empty the volume quickly while the light on the
     * floor stays put. At haze 0 the beam is gone and the pool is unchanged;
     * at haze 1 it is fully volumetric. */
    .mul(uHaze.mul(uHaze))
    .mul(uIntensity);

  material.colorNode = uColor.mul(brightness);
  material.fog = true;

  return { material, uColor, uIntensity, uTime, uLength, uEndFade, uHaze };
}

function createPoolMaterial() {
  const uColor = uniform(new THREE.Color(1, 1, 1));
  const uIntensity = uniform(0);
  const uTime = uniform(0);
  /** Scene haze, 0..1. Widens the penumbra and the spill. */
  const uHaze = uniform(0.65);

  /* World-space box this decal is cut to, taken from the venue surface's own
   * bounds. A beam that crosses two objects (floor in front of the stage, plus
   * the stage top) gets one decal per surface, and each has to stop at the
   * edge of the surface it lies on. Without the cut the floor decal runs on
   * under the stage and the stage top never gets one at all — the beam looks
   * like it lights the ground and skips the stage. The axis the surface lies
   * on is left wide open, because the decal sits in that plane. */
  const uClipMinX = uniform(-CLIP_OPEN);
  const uClipMinY = uniform(-CLIP_OPEN);
  const uClipMinZ = uniform(-CLIP_OPEN);
  const uClipMaxX = uniform(CLIP_OPEN);
  const uClipMaxY = uniform(CLIP_OPEN);
  const uClipMaxZ = uniform(CLIP_OPEN);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const radius = uv().sub(0.5).length().mul(2);
  /*
   * Haze controls how soft the footprint is, which is the whole difference
   * between a hazy club floor and a clear room:
   *
   * - clear air scatters nothing sideways, so the pool is the geometric cone
   *   and its edge is tight (the source is a small aperture, so the penumbra is
   *   narrow);
   * - haze scatters light past the cone edge, widening the penumbra and adding
   *   a broad spill tail.
   *
   * The edge positions are interpolated rather than fixed, so both ends are
   * authored: crisp at haze 0, soft and wide at haze 1. The texture is scaled
   * 1.35x the geometric cone, so "the cone edge" sits around radius 0.72.
   */
  const haze = uHaze.clamp(0, 1);
  /* Clear: abrupt core-to-penumbra step. Hazy: gradual. */
  const coreStart = mix(0.62, 0.22, haze);
  const coreEnd = mix(0.84, 0.72, haze);
  /* Clear: penumbra dies just outside the cone. Hazy: trails to the texture edge. */
  const penumbraEnd = mix(0.9, 1.0, haze);
  const penumbraGain = mix(0.24, 0.34, haze);

  const core = float(1).sub(smoothstep(coreStart, coreEnd, radius));
  const penumbra = float(1).sub(smoothstep(coreEnd, penumbraEnd, radius)).mul(penumbraGain);
  const hot = float(1).sub(smoothstep(0.0, mix(0.5, 0.6, haze), radius));
  const noise = mx_noise_float(vec3(uv().mul(7), uTime.mul(0.25))).mul(0.18).add(0.9);

  /* Bounds cut, feathered so a grazing edge does not alias into a staircase.
   * Multiply by 0 rather than discard: the pool is additive, so a masked
   * fragment contributes nothing and the edge stays smooth. */
  const world = positionWorld;
  const feather = float(POOL_EDGE_FEATHER);
  const clipX = smoothstep(uClipMinX.sub(feather), uClipMinX.add(feather), world.x)
    .mul(float(1).sub(smoothstep(uClipMaxX.sub(feather), uClipMaxX.add(feather), world.x)));
  const clipY = smoothstep(uClipMinY.sub(feather), uClipMinY.add(feather), world.y)
    .mul(float(1).sub(smoothstep(uClipMaxY.sub(feather), uClipMaxY.add(feather), world.y)));
  const clipZ = smoothstep(uClipMinZ.sub(feather), uClipMinZ.add(feather), world.z)
    .mul(float(1).sub(smoothstep(uClipMaxZ.sub(feather), uClipMaxZ.add(feather), world.z)));

  material.colorNode = uColor
    .mul(core.mul(0.92).add(penumbra).add(hot.mul(0.07)))
    .mul(noise)
    .mul(clipX.mul(clipY).mul(clipZ))
    .mul(uIntensity);
  material.fog = true;

  return {
    material,
    uColor,
    uIntensity,
    uTime,
    uHaze,
    clipMin: [uClipMinX, uClipMinY, uClipMinZ] as const,
    clipMax: [uClipMaxX, uClipMaxY, uClipMaxZ] as const,
  };
}

/**
 * How much brighter the surface pool is for a given haze level.
 *
 * A fixture emits a fixed amount of light. In haze some of it is scattered in
 * the air (that is the beam) and never lands on the floor; with clear air all
 * of it does. Hiding the volume without returning that energy makes a hazy
 * room look brighter than a clear one, which is backwards: with no haze the
 * floor is exactly where all the light goes.
 *
 * The curve is normalised so the 0.65 haze tuning reference is unchanged: a
 * clear room is ~3x brighter on the floor and a fully hazy one ~0.5x, which is
 * the same total energy redistributed between air and surface.
 */
function poolHazeGain(haze: number): number {
  const h = Math.min(1, Math.max(0, haze));
  return 1 / (0.3333 + 1.5784 * h * h);
}

/** Additive emitter glare: what a fixture aimed at the audience looks like. */
function createGlareMaterial() {
  const uColor = uniform(new THREE.Color(1, 1, 1));
  const uIntensity = uniform(0);

  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });

  const d = uv().sub(0.5).length().mul(2);
  const core = float(1).sub(smoothstep(0.0, 0.22, d));
  const halo = float(1).sub(smoothstep(0.12, 1.0, d));
  const white = mix(uColor, vec3(1), core.mul(0.55));

  material.colorNode = white.mul(core.mul(core).mul(1.7).add(halo.mul(halo).mul(0.55))).mul(uIntensity);
  material.fog = false;

  return { material, uColor, uIntensity };
}

/** Everything the stage needs to light the room from one fixture. */
interface BeamInfo {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  /** Metres to the surface hit, or the profile throw when nothing is hit. */
  length: number;
  /** Full cone angle in degrees. */
  spreadDeg: number;
  /** Beam brightness after dimmer and strobe, 0..1. */
  level: number;
  color: THREE.Color;
  /** Surface the beam stops on, if any. */
  hit: { point: THREE.Vector3; normal: THREE.Vector3 } | null;
}

export class FixtureRig {
  readonly root = new THREE.Group();

  /**
   * Live aim for this frame. The stage reads it to drive a small pool of real
   * lights, so the room is illuminated by the fixtures that are actually on
   * instead of by hardcoded lights at arbitrary positions.
   */
  readonly beamInfo: BeamInfo = {
    origin: new THREE.Vector3(),
    direction: new THREE.Vector3(0, -1, 0),
    length: 1,
    spreadDeg: 20,
    level: 0,
    color: new THREE.Color(),
    hit: null,
  };

  /**
   * Mechanical mounting angle (ADR-010). It sits between the world position
   * and the pan axis, so pan always spins around the fixture's own clamp
   * instead of being skewed by an angled mount, and the profile's tilt range
   * stays whole.
   */
  private readonly mount = new THREE.Group();
  private readonly yoke = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly beam: THREE.Mesh;
  private readonly beamGeometry: THREE.CylinderGeometry;
  private readonly beamPositions: Float32Array;
  private readonly beamUnitPositions: Float32Array;
  private readonly apertureRadius: number;
  private readonly beamMaterial: ReturnType<typeof createBeamMaterial>;
  private readonly poolDecals: { mesh: THREE.Mesh; material: ReturnType<typeof createPoolMaterial> }[] = [];
  private readonly poolSlots: PoolSlot[] = [];
  private readonly glare: THREE.Mesh;
  private readonly glareMaterial: ReturnType<typeof createGlareMaterial>;
  private readonly poolBasis = new THREE.Matrix4();
  /** Scratch for the candidate surface a pool slot is being built for. */
  private readonly poolPoint = new THREE.Vector3();
  private readonly poolNormal = new THREE.Vector3();
  private readonly lensMaterial: THREE.MeshBasicNodeMaterial;
  private readonly lensColor = uniform(new THREE.Color(0x000000));
  private readonly lensGlow = uniform(0);
  private readonly beamLength: number;
  private lastFarRadius = Number.NaN;
  private readonly color = new THREE.Color();
  private readonly beamOrigin = new THREE.Vector3();
  private readonly beamDirection = new THREE.Vector3();
  private enabled = true;

  constructor(readonly placement: FixturePlacement) {
    const { profile } = placement;
    const kind = profile.kind;
    this.root.position.set(placement.position.x, placement.position.y, placement.position.z);
    this.root.add(this.mount);
    this.applyMountAngle();

    const isMovingFixture = kind === 'moving-head' || kind === 'wash' || kind === 'laser';
    if (isMovingFixture) {
      const baseGeometry = kind === 'laser'
        ? new THREE.BoxGeometry(0.36, 0.2, 0.3)
        : new THREE.CylinderGeometry(0.24, 0.3, 0.16, 10);
      const base = new THREE.Mesh(baseGeometry, bodyMaterial);
      base.castShadow = true;
      this.root.add(base);

      this.yoke.position.y = -0.14;
      this.mount.add(this.yoke);

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
    } else {
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
      // Fixed fixtures have no yoke: the housing itself is the mount, so it
      // must tilt with the clamp or a floor uplight would point its can down.
      this.mount.add(housing);
      this.head.position.y = kind === 'par' ? 0 : -0.05;
      this.mount.add(this.head);
    }

    if (kind === 'strobe' || kind === 'blinder') {
      const face = new THREE.Mesh(
        new THREE.BoxGeometry(kind === 'strobe' ? 0.58 : 0.72, 0.04, 0.2),
        yokeMaterial,
      );
      face.position.y = -0.17;
      this.head.add(face);
    } else if (kind === 'led-strip') {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.04, 0.04), yokeMaterial);
      strip.position.y = -0.1;
      this.head.add(strip);
    }

    const headMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.22, 0.44, 12), bodyMaterial);
    headMesh.castShadow = true;
    if (isMovingFixture) this.head.add(headMesh);

    this.lensMaterial = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
    /* The lens is only bright when you can actually see into it. A constant
     * emissive disc reads as a floating "spot reflection" on fixtures that
     * are angled away from the camera. */
    const lensFacing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
    this.lensMaterial.colorNode = this.lensColor
      .mul(this.lensGlow)
      .mul(smoothstep(0.05, 0.55, lensFacing));
    this.apertureRadius = profile.beam.apertureDiameterM / 2;
    const lens = new THREE.Mesh(new THREE.CircleGeometry(this.apertureRadius, 20), this.lensMaterial);
    lens.position.y = -0.23;
    lens.rotation.x = Math.PI / 2;
    this.head.add(lens);

    /* The original renderer was open-ended; keep that. Its shading already
     * goes dark at the base (the axial falloff), so no end cap is needed. */
    this.beamGeometry = new THREE.CylinderGeometry(1, 1, 1, 30, 1, true);
    this.beamGeometry.translate(0, -0.5, 0);
    this.beamPositions = this.beamGeometry.attributes.position!.array as Float32Array;
    this.beamUnitPositions = this.beamPositions.slice();
    this.beamMaterial = createBeamMaterial();
    this.beam = new THREE.Mesh(this.beamGeometry, this.beamMaterial.material);
    this.beam.position.y = -0.24;
    this.beam.renderOrder = 2;
    this.beam.visible = false;
    this.head.add(this.beam);
    this.beamLength = profile.beam.throwM;

    /* Decal geometry is shared: one unit disc, scaled per surface in the pool
     * material. Each slot needs its own material because the clip box and the
     * intensity are per-surface uniforms. */
    for (let index = 0; index < POOL_DECALS; index += 1) {
      const material = createPoolMaterial();
      const mesh = new THREE.Mesh(POOL_GEOMETRY, material.material);
      mesh.name = POOL_MESH_NAME;
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.poolDecals.push({ mesh, material });
      this.poolSlots.push({
        surface: null,
        distance: 0,
        radius: 0,
        stretch: 1,
        point: new THREE.Vector3(),
        normal: new THREE.Vector3(),
        tangent: new THREE.Vector3(),
        bitangent: new THREE.Vector3(),
        clipMin: new THREE.Vector3(-CLIP_OPEN, -CLIP_OPEN, -CLIP_OPEN),
        clipMax: new THREE.Vector3(CLIP_OPEN, CLIP_OPEN, CLIP_OPEN),
      });
    }

    this.glareMaterial = createGlareMaterial();
    this.glare = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.glareMaterial.material);
    this.glare.renderOrder = 3;
    this.glare.visible = false;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.root, this.glare, ...this.poolDecals.map((decal) => decal.mesh));
  }
  removeFrom(scene: THREE.Scene): void {
    scene.remove(this.root, this.glare, ...this.poolDecals.map((decal) => decal.mesh));
  }

  setVisible(visible: boolean): void {
    this.enabled = visible;
    this.root.visible = visible;
    if (!visible) {
      for (const decal of this.poolDecals) decal.mesh.visible = false;
      this.glare.visible = false;
    }
  }

  /**
   * Mechanical pitch, read from the placement each update so fixture-panel
   * edits and project loads take effect without rebuilding the rig.
   */
  private applyMountAngle(): void {
    this.mount.rotation.x = -(this.placement.pitchOffsetDeg ?? 0) * DEG;
  }

  update(state: FixtureState, timeSec: number, options: FixtureUpdateOptions): void {
    // Placement is editable in the fixture panel, so read it every frame
    // instead of baking it into the constructor.
    this.root.position.set(
      this.placement.position.x,
      this.placement.position.y,
      this.placement.position.z,
    );
    this.applyMountAngle();
    const yaw = this.placement.yawDeg + state.panDeg;
    this.yoke.rotation.y = yaw * DEG;
    this.head.rotation.x = -state.tiltDeg * DEG;

    /* The evaluator owns the pulse rate and shape, so scrubbing, playback and
     * offline export all land on the same frame of the strobe. */
    const level = state.intensity * state.strobeLevel;

    const color = this.color.setRGB(state.color.r, state.color.g, state.color.b, THREE.SRGBColorSpace);
    const spread = Math.max(0.2, state.spreadDeg);
    const isLaser = this.placement.profile.kind === 'laser';
    const gain = isLaser ? 4 : 1;
    /* The same output concentrated into a narrower cone is brighter per pixel. */
    const spreadGain = THREE.MathUtils.clamp(Math.sqrt(6 / spread), 0.35, 2.4);

    this.beamMaterial.uColor.value.copy(color);
    this.beamMaterial.uTime.value = timeSec;
    this.beamMaterial.uIntensity.value = level * spreadGain * gain;
    this.beamMaterial.uHaze.value = Math.max(0, options.haze);
    this.lensColor.value.copy(color);
    this.lensGlow.value = level > 0.004 ? 0.12 + level * 5 : 0;

    this.head.updateWorldMatrix(true, false);
    const origin = this.head.localToWorld(this.beamOrigin.set(0, -0.24, 0));
    const direction = this.beamDirection.set(0, -1, 0).transformDirection(this.head.matrixWorld);

    /* Stop on the nearest venue surface. Without a hit the beam keeps its
     * profile throw and fades out, instead of ending in a flat cap. */
    const hit = intersectSurfaces(origin, direction, options.surfaces, this.beamLength);
    const length = Math.max(0.35, hit?.distance ?? this.beamLength);
    const farRadius = Math.max(this.apertureRadius, Math.tan((spread * DEG) / 2) * length);
    if (!Number.isFinite(this.lastFarRadius) || Math.abs(farRadius - this.lastFarRadius) > 0.01) {
      for (let index = 0; index < this.beamPositions.length; index += 3) {
        const y = this.beamUnitPositions[index + 1]!;
        const distance = -y;
        const radius = this.apertureRadius + (farRadius - this.apertureRadius) * distance;
        this.beamPositions[index] = this.beamUnitPositions[index]! * radius;
        this.beamPositions[index + 2] = this.beamUnitPositions[index + 2]! * radius;
      }
      this.beamGeometry.attributes.position!.needsUpdate = true;
      this.beamGeometry.computeBoundingSphere();
      this.lastFarRadius = farRadius;
    }
    this.beam.scale.set(1, length, 1);
    this.beam.visible = this.enabled && options.volumetrics && level > 0.004;

    /* The shader is local-space: only length and the end-fade mode vary here. */
    this.beamMaterial.uLength.value = length;
    this.beamMaterial.uEndFade.value = hit === null ? 0.9 : 0;

    /* Emitter glare. A real fixture aimed at the audience is the brightest
     * thing in frame; the cone surface alone went dark because its normals
     * are perpendicular to the view ray. Strongly directional so a fixture
     * aimed away does not show a floating blob at its lens. */
    const cameraX = options.camera.position.x - origin.x;
    const cameraY = options.camera.position.y - origin.y;
    const cameraZ = options.camera.position.z - origin.z;
    const cameraDistance = Math.sqrt(cameraX * cameraX + cameraY * cameraY + cameraZ * cameraZ);
    const toward = cameraDistance > 1e-4
      ? Math.max(0, (direction.x * cameraX + direction.y * cameraY + direction.z * cameraZ) / cameraDistance)
      : 0;
    const towardCubed = toward * toward * toward;
    this.glareMaterial.uColor.value.copy(color);
    this.glareMaterial.uIntensity.value =
      level * spreadGain * (isLaser ? 1.6 : 1.1) * (0.03 + 0.85 * towardCubed);
    /* Sized from the real aperture, not from distance. A distance-proportional
     * sprite grew to over a metre at venue range and read as a point source
     * floating off the fixture; the emitter should look as wide as its lens. */
    const glareSize = Math.max(0.22, this.apertureRadius * 4);
    this.glare.position.copy(origin);
    this.glare.quaternion.copy(options.camera.quaternion);
    this.glare.scale.set(glareSize, glareSize, 1);
    this.glare.visible = this.enabled && level > 0.004;

    /* Publish the aim for the light pool. A laser is not a room light: it is
     * rendered additively and should not illuminate surfaces. */
    const info = this.beamInfo;
    info.origin.copy(origin);
    info.direction.copy(direction);
    info.length = length;
    info.spreadDeg = spread;
    info.level = this.enabled && !isLaser ? level : 0;
    info.color.copy(color);
    info.hit = hit === null ? null : { point: hit.point, normal: hit.normal };

    if (this.enabled && level > 0.004 && !isLaser) {
      const count = this.collectSurfacePools(origin, direction, spread, length, options.surfaces);
      /* The spill footprint also tracks haze: a clear room has no sideways
       * scattering, so the pool sits on the cone; haze adds a wider tail. */
      const footprint = 1.18 + options.haze * 0.17;
      const haze = Math.max(0, Math.min(1, options.haze));
      /* At low haze the volume is gone, so the pool carries the fixture: it
       * brightens as the air clears (see `poolHazeGain`). The decal is the
       * primary surface light for every fixture, so the look is identical for
       * identical fixtures regardless of the real-light budget. */
      const gain = (level * spreadGain * 0.55 * poolHazeGain(haze));

      this.poolDecals.forEach((decal, index) => {
        const slot = index < count ? this.poolSlots[index] : undefined;
        if (slot === undefined || slot.surface === null) {
          decal.mesh.visible = false;
          return;
        }

        this.poolBasis.makeBasis(slot.tangent, slot.bitangent, slot.normal);
        decal.mesh.quaternion.setFromRotationMatrix(this.poolBasis);
        decal.mesh.position.copy(slot.point).addScaledVector(slot.normal, slot.surface.decalOffset);
        decal.mesh.scale.set(slot.radius * slot.stretch * footprint, slot.radius * footprint, 1);

        decal.material.uColor.value.copy(color);
        decal.material.uTime.value = timeSec;
        decal.material.uHaze.value = haze;
        decal.material.uIntensity.value = gain / ((1 + slot.distance * 0.1) * slot.stretch);
        for (let axis = 0; axis < 3; axis += 1) {
          decal.material.clipMin[axis]!.value = slot.clipMin.getComponent(axis);
          decal.material.clipMax[axis]!.value = slot.clipMax.getComponent(axis);
        }
        decal.mesh.visible = true;
      });
    } else {
      for (const decal of this.poolDecals) decal.mesh.visible = false;
    }
  }

  /**
   * Fill the pool slots with the venue surfaces this cone actually lands on,
   * nearest first. Returns how many slots are filled.
   *
   * The old renderer painted one decal where the beam's *centre axis* hit and
   * nothing else. That is why a beam looked like it lit the ground and not the
   * stage: a wide wash whose axis hit the floor in front of the riser painted
   * one flat disc in the floor plane, the part of it that overlapped the stage
   * was buried in the stage box (and depth-culled), and the stage top never got
   * a decal at all. It also meant a fixture whose axis missed every surface
   * inside its throw lit nothing, even though its cone was clearly on the
   * floor.
   *
   * A cone has volume, so every surface whose bounds the footprint overlaps
   * gets a decal, and the material cuts each one to those bounds — which is
   * what makes light stop exactly at the riser lip instead of spilling across
   * it.
   */
  private collectSurfacePools(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    spreadDeg: number,
    limit: number,
    surfaces: readonly VenueSurface[],
  ): number {
    const tanHalf = Math.tan((Math.max(0.2, spreadDeg) * DEG) / 2);
    let count = 0;

    for (const surface of surfaces) {
      const component = direction[surface.axis];
      if (Math.abs(component) < 1e-4) continue;
      const distance = (surface.value - origin[surface.axis]) / component;
      if (distance <= 0.05 || distance > limit) continue;

      const point = this.poolPoint.set(
        origin.x + direction.x * distance,
        origin.y + direction.y * distance,
        origin.z + direction.z * distance,
      );
      const radius = Math.max(0.2, tanHalf * distance);

      /* Cone/plane intersection is an ellipse: stretch along the slope and
       * keep the same penumbra the beam has. Needed before the bounds test,
       * because the stretch is how far the footprint can reach past the axis. */
      const normal = surfaceNormal(surface, direction, this.poolNormal);
      const incidence = Math.min(1, Math.abs(direction.dot(normal)));
      const stretch = Math.min(MAX_STRETCH, 1 / Math.max(incidence, 0.25));

      /* The axis can miss a plane's bounds while the footprint covers them, so
       * widen the test by the ellipse's own reach. Keeping this tight matters:
       * there are only `POOL_DECALS` slots, and a surface the footprint does not
       * actually touch would take one from a surface it does. */
      const bounds = surface.bounds;
      if (bounds !== null) {
        const pad = radius * stretch + BOUNDS_EPSILON;
        if (point.x < bounds.x[0] - pad || point.x > bounds.x[1] + pad) continue;
        if (point.y < bounds.y[0] - pad || point.y > bounds.y[1] + pad) continue;
        if (point.z < bounds.z[0] - pad || point.z > bounds.z[1] + pad) continue;
      }

      let slot: PoolSlot;
      if (count < POOL_DECALS) {
        slot = this.poolSlots[count]!;
        count += 1;
      } else {
        /* Keep the three nearest: the ones outside that are behind whatever the
         * beam already lit, which the pool cannot model anyway. */
        let worst = 0;
        for (let i = 1; i < count; i += 1) {
          if (this.poolSlots[i]!.distance > this.poolSlots[worst]!.distance) worst = i;
        }
        if (distance >= this.poolSlots[worst]!.distance) continue;
        slot = this.poolSlots[worst]!;
      }

      slot.surface = surface;
      slot.distance = distance;
      slot.radius = radius;
      slot.stretch = stretch;
      slot.normal.copy(normal);
      slot.point.copy(point);
      slot.tangent.copy(direction).addScaledVector(normal, -direction.dot(normal));
      if (slot.tangent.lengthSq() < 1e-6) {
        if (Math.abs(normal.x) > 0.9) slot.tangent.set(0, 1, 0);
        else slot.tangent.set(1, 0, 0);
      } else {
        slot.tangent.normalize();
      }
      slot.bitangent.crossVectors(normal, slot.tangent).normalize();

      slot.clipMin.set(-CLIP_OPEN, -CLIP_OPEN, -CLIP_OPEN);
      slot.clipMax.set(CLIP_OPEN, CLIP_OPEN, CLIP_OPEN);
      if (bounds !== null) {
        for (const axis of ['x', 'y', 'z'] as const) {
          /* The decal lies in the surface's own plane, so that axis stays open. */
          if (axis === surface.axis) continue;
          slot.clipMin[axis] = bounds[axis][0];
          slot.clipMax[axis] = bounds[axis][1];
        }
      }
    }

    /* Nearest first, so slot 0 is the surface the beam visibly lands on. */
    for (let i = 1; i < count; i += 1) {
      const slot = this.poolSlots[i]!;
      let j = i - 1;
      while (j >= 0 && this.poolSlots[j]!.distance > slot.distance) {
        this.poolSlots[j + 1] = this.poolSlots[j]!;
        j -= 1;
      }
      this.poolSlots[j + 1] = slot;
    }

    return count;
  }
}