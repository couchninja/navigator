import * as THREE from "three";

import type { Rgb } from "./scene-types";

/** Draw size vs scene marker radius (camera/labels still use marker radius). */
export const ISS_MESH_SIZE_MULTIPLE = 2;

function rgbToThree([r, g, b]: Rgb): THREE.Color {
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function addBox(
  group: THREE.Group,
  material: THREE.MeshStandardMaterial,
  scale: number,
  width: number,
  height: number,
  depth: number,
  x: number,
  y: number,
  z: number,
): void {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width * scale, height * scale, depth * scale), material);
  mesh.position.set(x * scale, y * scale, z * scale);
  group.add(mesh);
}

/** Four-box ISS read: hub, thin truss, oversized end solar panels. */
export function createIssMesh(radius: number, color: Rgb, emissiveIntensity: number): THREE.Group {
  const group = new THREE.Group();
  group.userData.issStation = true;
  const threeColor = rgbToThree(color);
  const material = new THREE.MeshStandardMaterial({
    color: threeColor,
    roughness: 0.55,
    metalness: 0.35,
    ...(emissiveIntensity > 0 ? { emissive: threeColor.clone(), emissiveIntensity } : {}),
  });
  const s = radius * ISS_MESH_SIZE_MULTIPLE;

  addBox(group, material, s, 0.2, 0.2, 0.32, 0, 0, 0);
  addBox(group, material, s, 2.35, 0.05, 0.05, 0, 0, 0);
  addBox(group, material, s, 0.035, 1.05, 0.48, 1.08, 0, 0);
  addBox(group, material, s, 0.035, 1.05, 0.48, -1.08, 0, 0);

  return group;
}

export function disposeIssMesh(group: THREE.Group): void {
  group.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  });
}
