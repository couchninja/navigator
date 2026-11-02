import * as THREE from "three";
import { describe, expect, it } from "vitest";

import {
  idleInfinityRampFactor,
  IDLE_INFINITY_RAMP_MS,
  infinityIdleCameraOffset,
  infinityIdleCameraUp,
} from "./camera-idle-infinity";

describe("infinityIdleCameraOffset", () => {
  it("keeps distance from the rest direction", () => {
    const baseDir = new THREE.Vector3(0, 0.2, 1).normalize();
    const baseUp = new THREE.Vector3(0, 1, 0);
    const distance = 4.2;
    const out = new THREE.Vector3();
    for (const phase of [0, 0.7, 2.1, 5.0]) {
      infinityIdleCameraOffset(baseDir, baseUp, distance, phase, 0.15, out);
      expect(out.length()).toBeCloseTo(distance, 5);
    }
  });

  it("returns the base direction at phase zero", () => {
    const baseDir = new THREE.Vector3(1, 0, 0);
    const baseUp = new THREE.Vector3(0, 1, 0);
    const out = new THREE.Vector3();
    infinityIdleCameraOffset(baseDir, baseUp, 2, 0, 0.2, out);
    expect(out.x).toBeCloseTo(2, 5);
    expect(out.y).toBeCloseTo(0, 5);
    expect(out.z).toBeCloseTo(0, 5);
  });

  it("varies direction over a cycle", () => {
    const baseDir = new THREE.Vector3(0, 0, 1);
    const baseUp = new THREE.Vector3(0, 1, 0);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    infinityIdleCameraOffset(baseDir, baseUp, 1, 0, 0.2, a);
    infinityIdleCameraOffset(baseDir, baseUp, 1, Math.PI / 3, 0.2, b);
    expect(a.dot(b)).toBeLessThan(0.999);
  });
});

describe("idleInfinityRampFactor", () => {
  it("starts at zero and reaches one at the ramp duration", () => {
    expect(idleInfinityRampFactor(0)).toBe(0);
    expect(idleInfinityRampFactor(-10)).toBe(0);
    expect(idleInfinityRampFactor(IDLE_INFINITY_RAMP_MS)).toBe(1);
    expect(idleInfinityRampFactor(IDLE_INFINITY_RAMP_MS + 1000)).toBe(1);
  });

  it("increases monotonically in between", () => {
    const mid = idleInfinityRampFactor(IDLE_INFINITY_RAMP_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("infinityIdleCameraUp", () => {
  it("stays unit length", () => {
    const baseDir = new THREE.Vector3(0, 0, 1);
    const baseUp = new THREE.Vector3(0, 1, 0);
    const out = new THREE.Vector3();
    infinityIdleCameraUp(baseDir, baseUp, 1.2, 0.15, out);
    expect(out.length()).toBeCloseTo(1, 5);
  });
});
