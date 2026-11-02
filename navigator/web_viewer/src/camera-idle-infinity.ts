import * as THREE from "three";

/** Full figure-eight cycle duration at 1× speed. */
export const IDLE_INFINITY_PERIOD_MS = 90_000;

/** Peak angular deviation from the rest pose (radians). */
export const IDLE_INFINITY_AMPLITUDE_RAD = 0.11;

/** Wall time to ease from rest to full wobble speed and amplitude. */
export const IDLE_INFINITY_RAMP_MS = 3_000;

export function idleInfinityRampFactor(elapsedMs: number): number {
  if (elapsedMs <= 0) {
    return 0;
  }
  if (elapsedMs >= IDLE_INFINITY_RAMP_MS) {
    return 1;
  }
  const t = elapsedMs / IDLE_INFINITY_RAMP_MS;
  return t * t * (3 - 2 * t);
}

const _right = new THREE.Vector3();
const _tangentUp = new THREE.Vector3();
const _wobble = new THREE.Vector3();

/**
 * Offset from pivot for a fixed camera distance, wobbling on a tangent-plane figure eight.
 * Zoom (distance) is unchanged; only view direction moves.
 */
export function infinityIdleCameraOffset(
  baseDirection: THREE.Vector3,
  baseUp: THREE.Vector3,
  distance: number,
  phaseRad: number,
  amplitudeRad: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  _right.crossVectors(baseUp, baseDirection);
  if (_right.lengthSq() < 1e-20) {
    _right.set(1, 0, 0);
  }
  _right.normalize();
  _tangentUp.crossVectors(baseDirection, _right).normalize();
  _wobble
    .copy(_right)
    .multiplyScalar(Math.sin(phaseRad) * amplitudeRad)
    .addScaledVector(_tangentUp, Math.sin(2 * phaseRad) * amplitudeRad * 0.55);
  return target.copy(baseDirection).add(_wobble).normalize().multiplyScalar(distance);
}

export function infinityIdleCameraUp(
  baseDirection: THREE.Vector3,
  baseUp: THREE.Vector3,
  phaseRad: number,
  amplitudeRad: number,
  target: THREE.Vector3,
): THREE.Vector3 {
  _right.crossVectors(baseUp, baseDirection);
  if (_right.lengthSq() < 1e-20) {
    _right.set(1, 0, 0);
  }
  _right.normalize();
  _tangentUp.crossVectors(baseDirection, _right).normalize();
  _wobble
    .copy(_right)
    .multiplyScalar(Math.sin(phaseRad) * amplitudeRad * 0.35)
    .addScaledVector(_tangentUp, Math.sin(2 * phaseRad) * amplitudeRad * 0.2);
  return target.copy(baseUp).add(_wobble).normalize();
}
