import * as THREE from 'three/webgpu';
import {
  abs,
  clamp,
  cos,
  float,
  fract,
  greaterThan,
  length,
  mix,
  mx_noise_float,
  pow,
  select,
  sin,
  smoothstep,
  step,
  texture as textureNode,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import type {
  LedLookKind,
  LedLookState,
  LedMediaFit,
  LedSurface,
  LedSync,
} from '@dmxsim/show-model';

const TAU = Math.PI * 2;

// TSL node generics are unreadable here, so these stay loose on purpose.
type Node = any;
type Uniform = any;

export interface LookUniforms {
  time: Uniform;
  color0: Uniform;
  color1: Uniform;
  color2: Uniform;
  color3: Uniform;
  colorCount: Uniform;
  speed: Uniform;
  scale: Uniform;
  angle: Uniform;
  softness: Uniform;
  intensity: Uniform;
  seed: Uniform;
  cellsX: Uniform;
  cellsY: Uniform;
  gap: Uniform;
  black: Uniform;
  brightness: Uniform;
  gamma: Uniform;
  aspect: Uniform;
  /** Pixel aspect of the current media texture; 16:9 until metadata lands. */
  mediaAspect: Uniform;
  maskStrength: Uniform;
  opacity: Uniform;
}

export function createLookUniforms(surface: LedSurface): LookUniforms {
  const grid = ledGrid(surface);
  return {
    time: uniform(0),
    color0: uniform(new THREE.Color('#000000')),
    color1: uniform(new THREE.Color('#000000')),
    color2: uniform(new THREE.Color('#000000')),
    color3: uniform(new THREE.Color('#000000')),
    colorCount: uniform(1),
    speed: uniform(0),
    scale: uniform(1),
    angle: uniform(0),
    softness: uniform(0),
    intensity: uniform(1),
    seed: uniform(0),
    cellsX: uniform(grid.x),
    cellsY: uniform(grid.y),
    gap: uniform(surface.gap),
    black: uniform(surface.blackLevel),
    brightness: uniform(surface.brightness),
    gamma: uniform(surface.gamma),
    aspect: uniform(surface.widthM / Math.max(0.001, surface.heightM)),
    mediaAspect: uniform(DEFAULT_MEDIA_ASPECT),
    maskStrength: uniform(0),
    opacity: uniform(1),
  };
}

/**
 * Visible LED matrix for a wall.
 *
 * A real P3.9 wall is ~3500 LEDs wide, far finer than a screen pixel at any
 * normal camera distance. Drawing that literally is invisible at best and
 * moiré at worst, so the matrix is scaled down *uniformly* to a legible cap
 * (as a sign visualiser does): pitch controls the simulated LED count while
 * the separate gap setting controls diode-to-substrate ratio.
 */
export function ledGrid(surface: Pick<LedSurface, 'widthM' | 'heightM' | 'pitchMm'>): {
  x: number;
  y: number;
} {
  const pitch = Math.max(0.1, surface.pitchMm);
  // Calibrate P3.9 to a 128-cell long axis. Smaller pitch means a denser
  // matrix, larger pitch means visibly fewer LEDs; cap only the densest case.
  const pitchScale = 3.9 / pitch;
  const longAxis = LED_GRID_BASE * pitchScale;
  const scale = Math.min(1, LED_GRID_MAX / longAxis);
  const aspect = surface.widthM / Math.max(0.001, surface.heightM);
  const x = longAxis * scale;
  const y = x / aspect;
  return { x: Math.max(4, Math.round(x)), y: Math.max(4, Math.round(y)) };
}

/**
 * Cap on the longest axis of the simulated matrix. The wall is only a few
 * hundred pixels tall in the viewport, so 128 keeps diodes at 2-4 px and
 * legible; a physically exact 3500 would be subpixel mush.
 */
const LED_GRID_BASE = 128;
const LED_GRID_MAX = 256;

/**
 * Pattern coordinates snapped to the LED matrix.
 *
 * Sampling the look per diode (rather than per screen pixel) is what makes
 * the wall read as LEDs: each cell gets one flat colour, exactly like a video
 * mapped onto a low-resolution panel. Rotating after quantising would slice
 * the cells diagonally, so rotate first, then snap.
 */
function rotatedUv(u: LookUniforms): Node {
  const centered = uv().sub(0.5);
  const angle = u.angle.mul(Math.PI / 180);
  const c = cos(angle);
  const s = sin(angle);
  const rotated = vec2(
    centered.x.mul(c).sub(centered.y.mul(s)),
    centered.x.mul(s).add(centered.y.mul(c)),
  );
  const cells = vec2(u.cellsX, u.cellsY);
  const snapped = rotated.add(0.5).mul(cells).floor().add(0.5).div(cells);
  return snapped.sub(0.5);
}

/**
 * Multi-stop sample. Two stops are a plain gradient; extra stops fade in near
 * the top of the ramp, which is enough to read as a palette without dynamic
 * per-segment indexing (which TSL cannot do cheaply).
 */
function sampleColor(u: LookUniforms, t: Node): Node {
  const two = mix(u.color0, u.color1, clamp(t, 0, 1));
  const three = mix(two, u.color2, smoothstep(0.55, 1.0, t));
  const four = mix(three, u.color3, smoothstep(0.8, 1.0, t));
  return mix(
    mix(two, three, step(2.5, u.colorCount)),
    four,
    step(3.5, u.colorCount),
  );
}

/**
 * Rectangular diode mask plus gap glow.
 *
 * `gap` is the dark share of a cell, so the diode's half-size is
 * `0.5 * (1 - gap)`. Bright diodes bleed into the substrate around them; the
 * glow is strongest at the diode edge and falls off into the gap, which is
 * what makes a wall look bright without washing out the grid.
 */
function ledMask(u: LookUniforms, color: Node): Node {
  const cell = uv().mul(vec2(u.cellsX, u.cellsY));
  const offset = abs(fract(cell).sub(0.5));
  const edge = float(0.5).mul(float(1).sub(u.gap));
  const soft = float(0.035);
  const diodeX = float(1).sub(smoothstep(edge.sub(soft), edge.add(soft), offset.x));
  const diodeY = float(1).sub(smoothstep(edge.sub(soft), edge.add(soft), offset.y));
  const diode = diodeX.mul(diodeY);

  const brightness = color.r.add(color.g).add(color.b).div(3);
  const distance = offset.x.max(offset.y);
  const range = float(0.5).sub(edge).mul(u.softness).mul(1.5);
  const glow = float(1)
    .sub(smoothstep(edge, edge.add(range).add(0.001), distance))
    .mul(brightness)
    .mul(u.softness);
  const lit = diode.max(glow.mul(float(1).sub(diode)));
  return mix(diode, lit, u.maskStrength);
}

/** Shared output stage: look colour -> LED mask -> brightness/gamma. */
function finalize(u: LookUniforms, color: Node): Node {
  const lit = color
    .mul(ledMask(u, color))
    .mul(u.brightness)
    .mul(u.intensity)
    .mul(u.opacity)
    .add(vec3(u.black.mul(u.brightness).mul(u.opacity)));
  // At the default display gamma (2.2), pass linear light through unchanged;
  // let Three.js perform output colour conversion instead of brightening the
  // wall twice. The control remains a contrast/gamma adjustment around that.
  return pow(lit, vec3(u.gamma.div(2.2)));
}

function buildSolid(u: LookUniforms): Node {
  return u.color0;
}

function buildGradient(u: LookUniforms): Node {
  const p = rotatedUv(u);
  const drift = sin(u.time.mul(u.speed).mul(TAU)).mul(0.25);
  return sampleColor(u, p.x.mul(u.scale).add(0.5).add(drift));
}

function buildWave(u: LookUniforms): Node {
  const p = rotatedUv(u);
  const phase = p.x.mul(u.scale).add(u.time.mul(u.speed)).mul(TAU);
  const wave = sin(phase).mul(0.5).add(0.5);
  const softened = smoothstep(float(0.5).sub(u.softness.mul(0.5)), float(1), wave);
  return sampleColor(u, softened);
}

function buildRadial(u: LookUniforms): Node {
  const p = rotatedUv(u);
  const radius = length(p.mul(vec2(u.aspect, 1))).div(u.aspect);
  const phase = radius.mul(u.scale).sub(u.time.mul(u.speed)).mul(TAU);
  const wave = sin(phase).mul(0.5).add(0.5);
  const vignette = float(1).sub(smoothstep(0.2, 0.9, radius));
  return sampleColor(u, wave.mul(vignette));
}

function buildNoise(u: LookUniforms): Node {
  const p = rotatedUv(u);
  const coordinate = vec3(
    p.mul(u.scale).mul(3),
    u.time.mul(u.speed).add(u.seed.mul(0.137)),
  );
  const noise = mx_noise_float(coordinate).mul(0.5).add(0.5);
  const shaped = smoothstep(0.25, 0.85, noise);
  return sampleColor(u, shaped);
}

function buildGrid(u: LookUniforms): Node {
  const p = rotatedUv(u);
  // Orthogonal cells create a bright tunnel/grid with an unambiguous dark
  // background. The animated translation makes the grid approach the viewer.
  const cell: Node = fract(p.mul(u.scale).mul(3).add(u.time.mul(u.speed)));
  const dx = float(0.5).sub(abs(cell.x.sub(0.5)));
  const dy = float(0.5).sub(abs(cell.y.sub(0.5)));
  const lineX = float(1).sub(smoothstep(0.025, 0.11, dx));
  const lineY = float(1).sub(smoothstep(0.025, 0.11, dy));
  const line = lineX.max(lineY);
  const center = sampleColor(u, float(0));
  const highlight = sampleColor(u, float(1));
  return mix(center, highlight, line);
}

function buildScan(u: LookUniforms): Node {
  const p = rotatedUv(u);
  const phase = p.y.mul(u.scale).mul(3).sub(u.time.mul(u.speed)).mul(TAU);
  const band = sin(phase).mul(0.5).add(0.5);
  const sharp = smoothstep(float(0.55).sub(u.softness.mul(0.5)), float(0.9), band);
  return sampleColor(u, sharp);
}

function buildBlackout(u: LookUniforms): Node {
  return vec3(0, 0, 0).mul(u.intensity);
}

/** Assumed source aspect before a video or image has decoded its dimensions. */
const DEFAULT_MEDIA_ASPECT = 16 / 9;

/**
 * Pixel aspect of a loaded video or image; 16:9 until metadata arrives.
 *
 * A `VideoTexture` exists as soon as the clip is cued, but its `<video>`
 * reports `videoWidth === 0` until metadata loads, so the fallback matters:
 * a zero aspect collapses the sampling in Y and stretches one column across
 * the whole wall. The value is pushed into a uniform every frame, because the
 * material may be built long before the clip has usable dimensions.
 */
export function mediaAspect(texture: THREE.Texture | null): number {
  const image = texture?.image as
    | { videoWidth?: number; videoHeight?: number; width?: number; height?: number }
    | null
    | undefined;
  const width = image?.videoWidth ?? image?.width ?? 0;
  const height = image?.videoHeight ?? image?.height ?? 0;
  if (width <= 0 || height <= 0) return DEFAULT_MEDIA_ASPECT;
  return width / height;
}

/**
 * Map a source onto the panel without distorting it.
 *
 * `cover` fills the wall and crops the overflow; `contain` shows the whole
 * frame and leaves the unused panel area dark, like letterboxing.
 */
function mediaUv(u: LookUniforms, fit: LedMediaFit): Node {
  const source = u.mediaAspect;
  const wall = u.aspect;
  const sourceWider = greaterThan(source, wall);
  const ratio = source.div(wall);
  const inverse = float(1).div(ratio);
  // `cover` crops the overflowing axis; `contain` shrinks the source instead.
  const scaleX = fit === 'cover'
    ? select(sourceWider, inverse, float(1))
    : select(sourceWider, float(1), ratio);
  const scaleY = fit === 'cover'
    ? select(sourceWider, float(1), ratio)
    : select(sourceWider, inverse, float(1));
  return vec2(scaleX, scaleY);
}

/**
 * Full-frame media sampled per screen pixel. The LED mask in `finalize` still
 * quantises the result to the diode matrix, so footage reads as a real wall.
 */
function buildMedia(
  u: LookUniforms,
  mediaTexture: THREE.Texture | null,
  fit: LedMediaFit,
): Node {
  if (mediaTexture === null) return vec3(0, 0, 0);
  const scales = mediaUv(u, fit);
  const centered = uv().sub(0.5);
  const sampled = textureNode(mediaTexture, centered.mul(scales).add(0.5));
  // `contain` maps outside the source; clamp-to-edge would smear those pixels
  // across the padding bars, so mask them to black (the wall's off level).
  const outside = step(0.5, abs(centered.x).mul(scales.x))
    .max(step(0.5, abs(centered.y).mul(scales.y)));
  return sampled.rgb.mul(float(1).sub(outside));
}

const BUILDERS: Record<Exclude<LedLookKind, 'media'>, (u: LookUniforms) => Node> = {
  solid: buildSolid,
  gradient: buildGradient,
  wave: buildWave,
  radial: buildRadial,
  noise: buildNoise,
  grid: buildGrid,
  scan: buildScan,
  // Kept as a compatibility alias for older v3 projects; the editor no
  // longer offers the unreliable point-field generator.
  dots: buildScan,
  blackout: buildBlackout,
};

export interface MediaNodeOptions {
  texture: THREE.Texture | null;
  fit: LedMediaFit;
}

export function buildLookNode(
  kind: LedLookKind,
  u: LookUniforms,
  media?: MediaNodeOptions,
): Node {
  const color = kind === 'media'
    ? buildMedia(u, media?.texture ?? null, media?.fit ?? 'cover')
    : (BUILDERS[kind] ?? buildGradient)(u);
  return finalize(u, color);
}

/** Write a look's values into a uniform set. Mutates `u` in place. */
export function applyLook(u: LookUniforms, look: LedLookState): void {
  const colors = look.colors.length > 0 ? look.colors : ['#000000'];
  const palette = [
    new THREE.Color(colors[0]!),
    new THREE.Color(colors[1 % colors.length]!),
    new THREE.Color(colors[2 % colors.length]!),
    new THREE.Color(colors[3 % colors.length]!),
  ];
  u.color0.value.copy(palette[0]);
  u.color1.value.copy(palette[1]);
  u.color2.value.copy(palette[2]);
  u.color3.value.copy(palette[3]);
  u.colorCount.value = colors.length;
  u.speed.value = look.speed;
  u.scale.value = look.scale;
  u.angle.value = look.angleDeg;
  u.softness.value = look.softness;
  u.intensity.value = look.intensity;
  u.seed.value = look.seed;
}

/** Apply wall calibration uniforms (pitch, gap, brightness, gamma). */
export function applySurface(u: LookUniforms, surface: LedSurface): void {
  const grid = ledGrid(surface);
  u.cellsX.value = grid.x;
  u.cellsY.value = grid.y;
  u.gap.value = surface.gap;
  u.black.value = surface.blackLevel;
  u.brightness.value = surface.brightness;
  u.gamma.value = surface.gamma;
  u.aspect.value = surface.widthM / Math.max(0.001, surface.heightM);
}

/**
 * Clock a look follows. Beat-locked looks advance in beats so a speed of 0.5
 * means half a cycle per beat regardless of tempo; bars do the same per bar.
 */
export function lookTime(
  look: LedLookState,
  timeSec: number,
  grid: { bpm: number | null; beatsPerBar: number } | null,
): number {
  const sync: LedSync = look.sync;
  if (grid === null || grid.bpm === null || sync === 'none') return timeSec;
  const beats = (timeSec * grid.bpm) / 60;
  return sync === 'beat' ? beats : beats / Math.max(1, grid.beatsPerBar);
}

/** Rough average colour, used to tint the room light the wall throws. */
export function averageLookColor(look: LedLookState): THREE.Color {
  // Media is not sampled on the CPU; a neutral spill avoids a wrong hue and
  // keeps the room fill moving with the wall's intensity.
  if (look.kind === 'media') {
    return new THREE.Color(0.5, 0.5, 0.5).multiplyScalar(look.intensity);
  }
  const color = new THREE.Color(0, 0, 0);
  if (look.colors.length === 0) return color;
  for (const css of look.colors) {
    color.add(new THREE.Color(css));
  }
  color.multiplyScalar(look.intensity / look.colors.length);
  return color;
}

/** Screen-space legibility of the LED grid, 0..1. */
export function ledMaskStrength(
  surface: LedSurface,
  camera: THREE.PerspectiveCamera,
  viewportHeightPx: number,
): number {
  const distance = Math.max(
    1,
    camera.position.distanceTo(new THREE.Vector3(0, surface.y, surface.z)),
  );
  const fovRad = (camera.fov * Math.PI) / 180;
  const projectedHeight =
    (surface.heightM / distance) * (viewportHeightPx / (2 * Math.tan(fovRad / 2)));
  const ledsDown = ledGrid(surface).y;
  const pxPerLed = projectedHeight / ledsDown;
  // Below ~0.75 px per diode the grid is finer than the screen: reduce the
  // mask rather than moire. By ~2 px the dots are unambiguous.
  return Math.min(1, Math.max(0, (pxPerLed - 0.75) / 1.25));
}
