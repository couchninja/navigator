import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { desiredOrbitTargetCameraPose } from "./camera-orbit-framing";
import { EARTH_ORBIT_RADIUS_AU } from "./scene-viewer-constants";
import type { SceneSnapshot } from "./scene-types";

function translationMatrix(position: THREE.Vector3): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, position.x, position.y, position.z, 1];
}

function baseSnapshot(overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return {
    simulation_time_iso: "2020-01-01T00:00:00.000",
    inertial_to_root_rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    bodies: [],
    paths: [],
    parametric_orbits: [],
    arrows: [],
    ...overrides,
  };
}

function applyPose(
  camera: THREE.PerspectiveCamera,
  observer: THREE.Vector3,
  pose: { offset: THREE.Vector3; up: THREE.Vector3 },
): void {
  camera.position.copy(observer).add(pose.offset);
  camera.up.copy(pose.up).normalize();
  camera.lookAt(observer);
  camera.updateMatrixWorld(true);
}

function projectedEarthNdcRadius(
  camera: THREE.PerspectiveCamera,
  earthCenter: THREE.Vector3,
  earthRadius: number,
): number {
  const centerDistance = camera.position.distanceTo(earthCenter);
  const angularRadius = Math.asin(Math.min(1, earthRadius / centerDistance));
  const halfFovY = THREE.MathUtils.degToRad(camera.fov / 2);
  return angularRadius / halfFovY;
}

describe("desiredOrbitTargetCameraPose for direct body targets", () => {
  it("frames Earth at 20% viewport height and the Sun 20% from the top", () => {
    const earthRadius = 0.001;
    const earthCenter = new THREE.Vector3(0, 0, 0);
    const observer = new THREE.Vector3(0, 0, earthRadius);
    const sunPosition = new THREE.Vector3(1, 0, earthRadius);

    const snapshot = baseSnapshot({
      bodies: [
        {
          name: "earth",
          radius: earthRadius,
          color: [0, 0, 1],
          matrix: translationMatrix(earthCenter),
        },
        {
          name: "sun",
          radius: 0.01,
          color: [1, 1, 0],
          matrix: translationMatrix(sunPosition),
        },
      ],
      paths: [
        {
          name: "earth_orbit",
          color: [1, 1, 1],
          matrix: translationMatrix(new THREE.Vector3()),
          segments: [
            [
              [0, 0, 0],
              [1, 0, 0],
              [0, 0, 0],
            ],
          ],
        },
      ],
    });

    const camera = new THREE.PerspectiveCamera(45, 1, 0.0001, 100);
    const pose = desiredOrbitTargetCameraPose(
      camera,
      snapshot,
      "sun",
      observer,
      (name) => {
        if (name === "earth") {
          return earthCenter.clone();
        }
        if (name === "sun") {
          return sunPosition.clone();
        }
        return null;
      },
      new THREE.Vector3(0, 0, 1),
      100,
    );

    applyPose(camera, observer, pose);
    expect(projectedEarthNdcRadius(camera, earthCenter, earthRadius)).toBeCloseTo(0.2, 2);
    const observerNdc = observer.clone().project(camera);
    const earthNdc = earthCenter.clone().project(camera);
    const sunNdc = sunPosition.clone().project(camera);
    expect(observerNdc.x).toBeCloseTo(0, 4);
    expect(observerNdc.y).toBeCloseTo(0, 4);
    expect(earthNdc.x).toBeCloseTo(0, 2);
    expect(sunNdc.x).toBeCloseTo(0, 2);
    expect(earthNdc.y).toBeLessThan(0);
    expect(sunNdc.y).toBeGreaterThan(0);
    expect(sunNdc.y).toBeCloseTo(0.6, 2);
  });
});

describe("desiredOrbitTargetCameraPose for ISS", () => {
  it("places the camera on the observer side, perpendicular to the orbit plane", () => {
    const orbitRadius = 0.01;
    const earthCenter = new THREE.Vector3(0.02, 0, 0);
    const observer = new THREE.Vector3(0.02, 0, 0.005);
    const issPosition = new THREE.Vector3(0.02 + orbitRadius, 0, 0);

    const snapshot = baseSnapshot({
      bodies: [
        {
          name: "earth",
          radius: 0.001,
          color: [0, 0, 1],
          matrix: translationMatrix(earthCenter),
        },
        {
          name: "iss",
          radius: 0.0001,
          color: [0, 0, 1],
          matrix: translationMatrix(issPosition),
        },
      ],
      paths: [
        {
          name: "iss_orbit",
          color: [1, 1, 1],
          matrix: translationMatrix(new THREE.Vector3()),
          segments: [
            [
              [earthCenter.x + orbitRadius, 0, 0],
              [earthCenter.x, orbitRadius, 0],
              [earthCenter.x - orbitRadius, 0, 0],
              [earthCenter.x, -orbitRadius, 0],
            ],
          ],
        },
      ],
    });

    const camera = new THREE.PerspectiveCamera(45, 1, 0.0001, 100);
    const pose = desiredOrbitTargetCameraPose(
      camera,
      snapshot,
      "iss",
      observer,
      (name) => {
        if (name === "earth") {
          return earthCenter.clone();
        }
        if (name === "iss") {
          return issPosition.clone();
        }
        return null;
      },
      new THREE.Vector3(0, 0, 1),
      100,
    );

    const offsetDirection = pose.offset.clone().normalize();
    expect(Math.abs(offsetDirection.z)).toBeGreaterThan(0.99);
    expect(offsetDirection.z).toBeGreaterThan(0);

    applyPose(camera, observer, pose);
    const cameraPosition = observer.clone().add(pose.offset);
    const toPivot = observer.clone().sub(cameraPosition).normalize();
    for (const [x, y, z] of snapshot.paths[0].segments[0]) {
      const point = new THREE.Vector3(x, y, z);
      const toPoint = point.clone().sub(cameraPosition).normalize();
      const halfFov = THREE.MathUtils.degToRad(camera.fov / 2) * 0.9;
      expect(toPoint.angleTo(toPivot)).toBeLessThanOrEqual(halfFov + 1e-6);
    }
  });

  it("uses parametric iss_orbit when ephemeris path segments are omitted", () => {
    const orbitRadius = 0.01;
    const earthCenter = new THREE.Vector3(0.02, 0, 0);
    const observer = new THREE.Vector3(0.02, 0, 0.005);

    const snapshot = baseSnapshot({
      bodies: [
        {
          name: "earth",
          radius: 0.001,
          color: [0, 0, 1],
          matrix: translationMatrix(earthCenter),
        },
      ],
      parametric_orbits: [
        {
          kind: "keplerian",
          name: "iss_orbit",
          color: [1, 1, 1],
          matrix: translationMatrix(new THREE.Vector3()),
          epoch_iso: "2020-01-01T00:00:00.000",
          period_days: 0.06,
          a_au: orbitRadius,
          e: 0,
          i_rad: 0,
          raan_rad: 0,
          argp_rad: 0,
          M0_rad: 0,
          mu_au3_per_day2: 1e-8,
          origin_body: "earth",
          origin_heliocentric_au: [earthCenter.x, earthCenter.y, earthCenter.z],
        },
      ],
    });

    const camera = new THREE.PerspectiveCamera(45, 1, 0.0001, 100);
    const pose = desiredOrbitTargetCameraPose(
      camera,
      snapshot,
      "iss",
      observer,
      (name) => (name === "earth" ? earthCenter.clone() : null),
      new THREE.Vector3(0, 0, 1),
      100,
    );

    const offsetDirection = pose.offset.clone().normalize();
    expect(Math.abs(offsetDirection.z)).toBeGreaterThan(0.99);
  });

  it("falls back to heliocentric orbit scale when iss_orbit geometry is missing", () => {
    const earthCenter = new THREE.Vector3(0, 0, 0);
    const observer = new THREE.Vector3(0, 0, 4e-5);
    const snapshot = baseSnapshot({
      bodies: [
        {
          name: "earth",
          radius: 0.001,
          color: [0, 0, 1],
          matrix: translationMatrix(earthCenter),
        },
      ],
    });
    const camera = new THREE.PerspectiveCamera(45, 1, 0.0001, 100);
    const pose = desiredOrbitTargetCameraPose(
      camera,
      snapshot,
      "iss",
      observer,
      (name) => (name === "earth" ? earthCenter.clone() : null),
      new THREE.Vector3(0, 0, 1),
      100,
    );
    expect(pose.offset.length()).toBeGreaterThan(EARTH_ORBIT_RADIUS_AU * 0.5);
  });
});
