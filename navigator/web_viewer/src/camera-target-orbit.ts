import { Easing, Group, Tween } from "@tweenjs/tween.js";
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { OrbitCameraPose } from "./camera-orbit-framing";

const CAMERA_TARGET_ORBIT_MS = 3000;
const MIN_OFFSET_DISTANCE_AU = 1e-14;

const cameraTweenGroup = new Group();
const slerpDirectionScratch = new THREE.Vector3();
const orbitControlsWorldUp = new THREE.Vector3(0, 1, 0);

type OrbitControlsWithUpBasis = OrbitControls & {
  _quat: THREE.Quaternion;
  _quatInverse: THREE.Quaternion;
};

export type CameraOrbitTweenHandle = {
  stop: () => void;
};

export function cameraOrbitTweenActive(): boolean {
  return cameraTweenGroup.getAll().some((entry) => entry.isPlaying());
}

function offsetDirection(offset: THREE.Vector3, fallback: THREE.Vector3): THREE.Vector3 {
  if (offset.lengthSq() > 1e-24) {
    return offset.clone().normalize();
  }
  return fallback.clone().normalize();
}

function slerpUnitDirection(from: THREE.Vector3, to: THREE.Vector3, t: number, target: THREE.Vector3): THREE.Vector3 {
  const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);
  const omega = Math.acos(dot);
  if (omega < 1e-8) {
    return target.copy(from).lerp(to, t).normalize();
  }
  const sinOmega = Math.sin(omega);
  const weightFrom = Math.sin((1 - t) * omega) / sinOmega;
  const weightTo = Math.sin(t * omega) / sinOmega;
  return target.copy(from).multiplyScalar(weightFrom).add(to.clone().multiplyScalar(weightTo));
}

function logLerpDistance(startDistance: number, endDistance: number, t: number): number {
  const start = Math.max(startDistance, MIN_OFFSET_DISTANCE_AU);
  const end = Math.max(endDistance, MIN_OFFSET_DISTANCE_AU);
  return Math.exp(THREE.MathUtils.lerp(Math.log(start), Math.log(end), t));
}

export function tweenCameraToOrbitPose(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  pivot: THREE.Vector3,
  start: OrbitCameraPose,
  end: OrbitCameraPose,
  onUpdate: () => void,
  durationMs = CAMERA_TARGET_ORBIT_MS,
  onComplete: (() => void) | null = null,
): CameraOrbitTweenHandle {
  const startDistance = start.offset.length();
  const endDistance = end.offset.length();
  const startDir = offsetDirection(start.offset, start.up);
  const endDir = offsetDirection(end.offset, end.up);
  const startUp = start.up.clone().normalize();
  const endUp = end.up.clone().normalize();

  const tweenState = { t: 0 };
  controls.enabled = false;

  const tween = new Tween(tweenState, cameraTweenGroup)
    .to({ t: 1 }, durationMs)
    .easing(Easing.Quadratic.InOut)
    .onUpdate(() => {
      const t = tweenState.t;
      const direction = slerpUnitDirection(startDir, endDir, t, slerpDirectionScratch);
      const distance = logLerpDistance(startDistance, endDistance, t);
      controls.target.copy(pivot);
      camera.position.copy(pivot).add(direction.multiplyScalar(distance));
      camera.up.lerpVectors(startUp, endUp, t).normalize();
      syncOrbitControlsUpBasis(controls);
      controls.update();
      onUpdate();
    })
    .onComplete(() => {
      controls.target.copy(pivot);
      camera.position.copy(pivot).add(end.offset);
      camera.up.copy(endUp);
      syncOrbitControlsUpBasis(controls);
      controls.update();
      controls.enabled = true;
      onComplete?.();
    })
    .onStop(() => {
      syncOrbitControlsUpBasis(controls);
      controls.update();
      controls.enabled = true;
    })
    .start();

  return {
    stop: () => {
      tween.stop();
    },
  };
}

export function updateCameraTargetTweens(timeMs: number): void {
  cameraTweenGroup.update(timeMs);
}

export function syncOrbitControlsUpBasis(controls: OrbitControls): void {
  const internals = controls as OrbitControlsWithUpBasis;
  internals._quat.setFromUnitVectors(controls.object.up, orbitControlsWorldUp);
  internals._quatInverse.copy(internals._quat).invert();
}
