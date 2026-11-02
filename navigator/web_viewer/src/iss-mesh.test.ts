import * as THREE from "three";
import { describe, expect, it } from "vitest";

import { createIssMesh, ISS_MESH_SIZE_MULTIPLE } from "./iss-mesh";

describe("createIssMesh", () => {
  it("builds a labeled group with multiple mesh parts", () => {
    const group = createIssMesh(0.001, [70, 130, 255], 0.45);
    expect(group.userData.issStation).toBe(true);
    const meshes = group.children.filter((child) => child.type === "Mesh");
    expect(meshes.length).toBe(4);
  });

  it("scales geometry with marker radius", () => {
    const small = createIssMesh(1e-6, [70, 130, 255], 0.45);
    const large = createIssMesh(2e-6, [70, 130, 255], 0.45);
    const box = new THREE.Box3().setFromObject(small);
    const smallSpan = box.getSize(new THREE.Vector3()).length();
    box.setFromObject(large);
    const largeSpan = box.getSize(new THREE.Vector3()).length();
    expect(largeSpan / smallSpan).toBeCloseTo(2, 5);
    expect(largeSpan / (2e-6 * ISS_MESH_SIZE_MULTIPLE)).toBeGreaterThan(1.5);
  });
});
