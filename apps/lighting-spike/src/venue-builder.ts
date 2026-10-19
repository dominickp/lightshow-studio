import * as THREE from 'three/webgpu';
import type { VenuePrimitive, VenueRole, VenueTemplate } from '@dmxsim/show-model';

/**
 * Builds venue geometry from a template (ADR-011).
 *
 * `show-model` owns the data; this module owns three.js. Keeping the mapping
 * here means a new venue is a data change, not a renderer fork.
 */

const DEG = Math.PI / 180;

interface RoleStyle {
  color: number;
  roughness: number;
  metalness: number;
  castShadow: boolean;
  receiveShadow: boolean;
}

/**
 * Material and shadow behaviour per role. These are the values the original
 * hand-built room used, so a data-driven rebuild stays visually identical.
 *
 * Floor/stage stay slightly glossy but not glossy enough to mirror a light.
 * At `roughness: 0.38` a single pooled `SpotLight` produced one hard specular
 * blob on the dance floor and none anywhere else, because only one of the few
 * real lights happened to fall in the camera's specular direction. The floor's
 * brightness now comes from the additive beam pools (one per lit fixture),
 * which are consistent by construction.
 */
const ROLE_STYLES: Record<VenueRole, RoleStyle> = {
  wall: { color: 0x0b0d13, roughness: 0.85, metalness: 0.05, castShadow: false, receiveShadow: true },
  floor: { color: 0x0c0e14, roughness: 0.78, metalness: 0.05, castShadow: false, receiveShadow: true },
  stage: { color: 0x101319, roughness: 0.68, metalness: 0.08, castShadow: true, receiveShadow: true },
  metal: { color: 0x2a2d34, roughness: 0.4, metalness: 0.9, castShadow: false, receiveShadow: false },
  dark: { color: 0x05060a, roughness: 0.3, metalness: 0.6, castShadow: false, receiveShadow: false },
};

function createMaterials(): Record<VenueRole, THREE.MeshStandardMaterial> {
  const materials = {} as Record<VenueRole, THREE.MeshStandardMaterial>;
  for (const [role, style] of Object.entries(ROLE_STYLES) as [VenueRole, RoleStyle][]) {
    materials[role] = new THREE.MeshStandardMaterial({
      color: style.color,
      roughness: style.roughness,
      metalness: style.metalness,
    });
  }
  return materials;
}

function geometryFor(primitive: VenuePrimitive): THREE.BufferGeometry {
  const { shape, size } = primitive;
  if (shape === 'plane') return new THREE.PlaneGeometry(size.x, size.y);
  return new THREE.BoxGeometry(size.x, size.y, size.z);
}

/** Build the static structure of a venue as one disposabe group. */
export function buildVenue(template: VenueTemplate): THREE.Group {
  const group = new THREE.Group();
  group.name = `venue:${template.id}`;
  const materials = createMaterials();

  for (const primitive of template.structure) {
    const style = ROLE_STYLES[primitive.role];
    const mesh = new THREE.Mesh(geometryFor(primitive), materials[primitive.role]);
    mesh.position.set(primitive.position.x, primitive.position.y, primitive.position.z);
    const rotation = primitive.rotationDeg;
    if (rotation !== undefined) {
      mesh.rotation.set(rotation.x * DEG, rotation.y * DEG, rotation.z * DEG);
    }
    mesh.castShadow = style.castShadow;
    mesh.receiveShadow = style.receiveShadow;
    group.add(mesh);
  }

  return group;
}

/** Deterministic crowd silhouette, so reloads look the same. */
export function buildCrowd(feature: NonNullable<VenueTemplate['features']['crowd']>): THREE.InstancedMesh {
  const crowd = new THREE.InstancedMesh(
    new THREE.CapsuleGeometry(0.22, 0.92, 3, 6),
    new THREE.MeshStandardMaterial({ color: 0x08090d, roughness: 0.9, metalness: 0 }),
    feature.count,
  );
  crowd.castShadow = true;
  crowd.receiveShadow = true;

  let seed = 1337;
  const random = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();

  for (let i = 0; i < crowd.count; i += 1) {
    const x = (random() - 0.5) * feature.spreadX;
    const z = feature.nearZ + random() * feature.spreadZ;
    const height = 0.85 + random() * 0.35;
    position.set(x, 0.95 * height, z);
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2);
    scale.set(1, height, 1);
    matrix.compose(position, quaternion, scale);
    crowd.setMatrixAt(i, matrix);
  }
  crowd.instanceMatrix.needsUpdate = true;
  return crowd;
}

/** Release GPU resources owned by a group built here. */
export function disposeGroup(group: THREE.Object3D): void {
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const material = object.material;
    if (Array.isArray(material)) {
      for (const item of material) item.dispose();
    } else {
      material.dispose();
    }
  });
}
