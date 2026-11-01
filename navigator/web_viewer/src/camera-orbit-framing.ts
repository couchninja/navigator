import * as THREE from "three";

import { orbitWorldPointsFromSnapshot, snapshotSimulationTimeMs, worldPointsFromScenePath } from "./orbit-path-samples";
import { pointingArrowForTarget } from "./pointing-arrow";
import { DEFAULT_CAMERA_DISTANCE_AU, EARTH_ORBIT_RADIUS_AU, EARTH_RADIUS_AU } from "./scene-viewer-constants";
import type { ScenePath, SceneSnapshot } from "./scene-types";

const ORBIT_PLANE_ELEVATION_RAD = THREE.MathUtils.degToRad(20);

/** Velocity / orbit-direction targets share framing with their body counterpart. */
const ORBITAL_DIRECTION_FRAMING: Partial<Record<string, string>> = {
  sun_orbit: "sun",
  milky_way_orbit: "milky_way_center",
  cmb_dipole: "milky_way_center",
};

function framingPointingTarget(pointingTarget: string): string {
  return ORBITAL_DIRECTION_FRAMING[pointingTarget] ?? pointingTarget;
}

/** Scene path used to infer the orbit plane for each pointing target. */
const POINTING_TARGET_ORBIT_PATH: Partial<Record<string, string>> = {
  sun: "earth_orbit",
  sun_orbit: "earth_orbit",
  moon: "moon_orbit",
  iss: "iss_orbit",
  milky_way_center: "galactic_orbit",
  milky_way_orbit: "galactic_orbit",
  cmb_dipole: "galactic_orbit",
  earth_rotation: "earth_axis",
};

const ORBIT_PATH_CENTER_BODY: Partial<Record<string, string>> = {
  earth_orbit: "sun",
  moon_orbit: "earth",
  iss_orbit: "earth",
  galactic_orbit: "galactic_center",
};

const HEAVENLY_BODY_ORBIT_PATH: Partial<Record<string, string>> = {
  sun: "earth_orbit",
  moon: "moon_orbit",
  iss: "iss_orbit",
  galactic_center: "galactic_orbit",
};

/** Orbits around Earth (LEO, lunar); reject heliocentric paths misread as geocentric. */
const MAX_GEOCENTRIC_ORBIT_RADIUS_AU = 0.01;

const _heavenlyOrbitCenter = new THREE.Vector3();
const _heavenlyOrbitBody = new THREE.Vector3();
const _heavenlyOrbitMatrix = new THREE.Matrix4();
const _sceneBoundsMin = new THREE.Vector3();
const _sceneBoundsMax = new THREE.Vector3();
const _sceneBoundsExtents = new THREE.Vector3();
const _orbitWorldPoints: THREE.Vector3[] = [];

const BODY_FOR_TARGET: Partial<Record<string, string>> = {
  sun: "sun",
  moon: "moon",
  iss: "iss",
  milky_way_center: "galactic_center",
};

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const EARTH_VIEWPORT_FILL = 0.9;
const ORBIT_VIEWPORT_FILL = 0.9;
/** Earth sphere radius as a fraction of full viewport height for direct body targets. */
const BODY_TARGET_EARTH_RADIUS_VIEWPORT_FRACTION = 0.2;
/** Target body center height from the top of the viewport (direct body targets). */
const BODY_TARGET_VIEWPORT_TOP_FRACTION = 0.2;

const _bodyFramingCameraScratch = new THREE.PerspectiveCamera();
const _bodyFramingProject = new THREE.Vector3();
const _bodyFramingOffset = new THREE.Vector3();
const _bodySightCross = new THREE.Vector3();

type BodyTargetSightFrame = {
  towardTarget: THREE.Vector3;
  downToEarth: THREE.Vector3;
  normal: THREE.Vector3;
};

export type OrbitCameraPose = {
  offset: THREE.Vector3;
  up: THREE.Vector3;
};

function pathPoints(path: ScenePath): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  worldPointsFromScenePath(path, points);
  return points;
}

function orbitPathPoints(snapshot: SceneSnapshot, pathName: string): THREE.Vector3[] {
  const timeMs = snapshotSimulationTimeMs(snapshot);
  if (!orbitWorldPointsFromSnapshot(snapshot, pathName, timeMs, _orbitWorldPoints)) {
    return [];
  }
  return _orbitWorldPoints;
}

function newellPlaneNormal(points: THREE.Vector3[]): THREE.Vector3 | null {
  if (points.length < 3) {
    return null;
  }
  const normal = new THREE.Vector3();
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  if (normal.lengthSq() < 1e-20) {
    return null;
  }
  return normal.normalize();
}

function lineDirection(points: THREE.Vector3[]): THREE.Vector3 | null {
  if (points.length < 2) {
    return null;
  }
  const direction = points[points.length - 1].clone().sub(points[0]);
  if (direction.lengthSq() < 1e-20) {
    return null;
  }
  return direction.normalize();
}

function meanRadiusFromPoints(points: THREE.Vector3[], center: THREE.Vector3): number | null {
  if (points.length === 0) {
    return null;
  }
  let sum = 0;
  for (const point of points) {
    sum += point.distanceTo(center);
  }
  return sum / points.length;
}

function orbitPlaneNormal(
  snapshot: SceneSnapshot,
  pointingTarget: string,
  currentOffsetDirection: THREE.Vector3,
): THREE.Vector3 {
  const pathName = POINTING_TARGET_ORBIT_PATH[framingPointingTarget(pointingTarget)];
  if (pathName) {
    const points = orbitPathPoints(snapshot, pathName);
    if (points.length > 0) {
      const axis = pathName === "earth_axis" ? lineDirection(points) : newellPlaneNormal(points);
      if (axis) {
        return axis.dot(currentOffsetDirection) >= 0 ? axis.clone() : axis.clone().negate();
      }
    }
  }

  const velocityArrow = pointingArrowForTarget(snapshot, pointingTarget);
  if (velocityArrow) {
    const direction = new THREE.Vector3(...velocityArrow.direction).normalize();
    return direction.dot(currentOffsetDirection) >= 0 ? direction.clone() : direction.clone().negate();
  }

  return currentOffsetDirection.lengthSq() > 1e-20
    ? currentOffsetDirection.clone().normalize()
    : new THREE.Vector3(0, 0, 1);
}

function inPlaneHorizontal(normal: THREE.Vector3, observer: THREE.Vector3, toward: THREE.Vector3): THREE.Vector3 {
  const inPlane = toward.clone().sub(observer);
  inPlane.sub(normal.clone().multiplyScalar(inPlane.dot(normal)));
  if (inPlane.lengthSq() > 1e-16) {
    return inPlane.normalize();
  }

  const fallback = new THREE.Vector3().crossVectors(normal, WORLD_UP);
  if (fallback.lengthSq() > 1e-16) {
    return fallback.normalize();
  }
  return new THREE.Vector3().crossVectors(normal, new THREE.Vector3(1, 0, 0)).normalize();
}

function targetWorldPosition(
  snapshot: SceneSnapshot,
  pointingTarget: string,
  observer: THREE.Vector3,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
): THREE.Vector3 {
  const bodyName = BODY_FOR_TARGET[framingPointingTarget(pointingTarget)];
  if (bodyName) {
    const bodyPosition = bodyWorldPosition(bodyName);
    if (bodyPosition) {
      return bodyPosition;
    }
  }
  if (pointingTarget === "cmb_dipole") {
    const cmb = snapshot.arrows.find((entry) => entry.name === "cmb_dipole_arrow");
    if (cmb) {
      const extent = Math.max(DEFAULT_CAMERA_DISTANCE_AU, sceneScaleAuFromSnapshot(snapshot));
      return new THREE.Vector3(...cmb.base).add(new THREE.Vector3(...cmb.direction).multiplyScalar(extent));
    }
  }
  const velocityArrow = pointingArrowForTarget(snapshot, pointingTarget);
  if (velocityArrow) {
    const extent = Math.max(DEFAULT_CAMERA_DISTANCE_AU, sceneScaleAuFromSnapshot(snapshot));
    return observer.clone().add(new THREE.Vector3(...velocityArrow.direction).multiplyScalar(extent));
  }
  return observer.clone().add(new THREE.Vector3(0, 0, DEFAULT_CAMERA_DISTANCE_AU));
}

function bodyPositionFromSnapshot(snapshot: SceneSnapshot, name: string, target: THREE.Vector3): boolean {
  const entry = snapshot.bodies.find((body) => body.name === name);
  if (!entry) {
    return false;
  }
  _heavenlyOrbitMatrix.fromArray(entry.matrix);
  target.setFromMatrixPosition(_heavenlyOrbitMatrix);
  return true;
}

function geocentricOrbitRadiusFromSnapshot(bodyName: string, snapshot: SceneSnapshot): number | null {
  if (!bodyPositionFromSnapshot(snapshot, "earth", _heavenlyOrbitCenter)) {
    return null;
  }
  if (!bodyPositionFromSnapshot(snapshot, bodyName, _heavenlyOrbitBody)) {
    return null;
  }
  return _heavenlyOrbitBody.distanceTo(_heavenlyOrbitCenter);
}

function geocentricBodyOrbitRadiusAu(
  bodyName: string,
  snapshot: SceneSnapshot,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
): number | null {
  const earth = bodyWorldPosition("earth");
  const body = bodyWorldPosition(bodyName);
  if (earth && body) {
    _heavenlyOrbitCenter.copy(earth);
    _heavenlyOrbitBody.copy(body);
    const liveRadius = _heavenlyOrbitBody.distanceTo(_heavenlyOrbitCenter);
    if (liveRadius > 1e-10) {
      return liveRadius;
    }
  }
  return geocentricOrbitRadiusFromSnapshot(bodyName, snapshot);
}

function geocentricPathOrbitRadiusAu(
  pathName: string,
  snapshot: SceneSnapshot,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
): number | null {
  const centerBody = ORBIT_PATH_CENTER_BODY[pathName];
  const center = centerBody ? bodyWorldPosition(centerBody) : null;
  const points = orbitPathPoints(snapshot, pathName);
  if (points.length === 0 || !center) {
    return null;
  }
  _heavenlyOrbitCenter.copy(center);
  const radius = meanRadiusFromPoints(points, _heavenlyOrbitCenter);
  if (radius === null || radius <= 0) {
    return null;
  }
  if (centerBody === "earth" && radius > MAX_GEOCENTRIC_ORBIT_RADIUS_AU) {
    return null;
  }
  return radius;
}

export function heavenlyBodyOrbitRadiusAu(
  bodyName: string,
  snapshot: SceneSnapshot,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
): number | null {
  if (bodyName === "earth" || bodyName === "observer") {
    return null;
  }
  const pathName = HEAVENLY_BODY_ORBIT_PATH[bodyName];
  if (pathName) {
    const pathRadius = geocentricPathOrbitRadiusAu(pathName, snapshot, bodyWorldPosition);
    if (pathRadius !== null) {
      return pathRadius;
    }
  }
  if (bodyName === "moon" || bodyName === "iss") {
    return geocentricBodyOrbitRadiusAu(bodyName, snapshot, bodyWorldPosition);
  }
  return EARTH_ORBIT_RADIUS_AU;
}

function halfViewportFovRad(camera: THREE.PerspectiveCamera, fill: number): number {
  const halfFovY = THREE.MathUtils.degToRad(camera.fov / 2) * fill;
  const halfFovX = Math.atan(Math.tan(halfFovY) * camera.aspect) * fill;
  return Math.min(halfFovX, halfFovY);
}

function isDirectBodyPointingTarget(pointingTarget: string): boolean {
  return pointingTarget in BODY_FOR_TARGET && pointingTarget !== "iss";
}

function bodyTargetNdcYFromTop(): number {
  return 1 - 2 * BODY_TARGET_VIEWPORT_TOP_FRACTION;
}

function applyOrbitCameraPose(
  camera: THREE.PerspectiveCamera,
  pivot: THREE.Vector3,
  offset: THREE.Vector3,
  up: THREE.Vector3,
): void {
  camera.position.copy(pivot).add(offset);
  camera.up.copy(up).normalize();
  camera.lookAt(pivot);
  camera.updateMatrixWorld(true);
}

function projectedSphereNdcRadius(camera: THREE.PerspectiveCamera, center: THREE.Vector3, radius: number): number {
  const centerDistance = camera.position.distanceTo(center);
  if (centerDistance <= radius) {
    return 1;
  }
  const angularRadius = Math.asin(Math.min(1, radius / centerDistance));
  const halfFovY = THREE.MathUtils.degToRad(camera.fov / 2);
  return angularRadius / halfFovY;
}

function earthProjectedRadiusAtDistance(
  camera: THREE.PerspectiveCamera,
  observer: THREE.Vector3,
  offsetDirection: THREE.Vector3,
  up: THREE.Vector3,
  earthCenter: THREE.Vector3,
  earthRadius: number,
  distance: number,
): number {
  _bodyFramingOffset.copy(offsetDirection).multiplyScalar(distance);
  applyOrbitCameraPose(camera, observer, _bodyFramingOffset, up);
  return projectedSphereNdcRadius(camera, earthCenter, earthRadius);
}

/** Plane through earth center, observer, and target; camera stays in-plane so all three share one vertical screen line. */
function bodyTargetSightFrame(
  observer: THREE.Vector3,
  earthCenter: THREE.Vector3,
  targetPosition: THREE.Vector3,
  fallbackNormal: THREE.Vector3,
): BodyTargetSightFrame | null {
  _bodyFramingProject.copy(targetPosition).sub(observer);
  if (_bodyFramingProject.lengthSq() < 1e-20) {
    return null;
  }
  const towardTarget = _bodyFramingProject.clone().normalize();

  _bodyFramingOffset.copy(earthCenter).sub(observer);
  if (_bodyFramingOffset.lengthSq() < 1e-20) {
    return null;
  }
  const downToEarth = _bodyFramingOffset.clone().normalize();

  _bodySightCross.crossVectors(towardTarget, downToEarth);
  let normal: THREE.Vector3;
  if (_bodySightCross.lengthSq() < 1e-16) {
    normal = fallbackNormal.clone().normalize();
  } else {
    normal = _bodySightCross.normalize();
    if (normal.dot(WORLD_UP) < 0) {
      normal.negate();
    }
  }

  return { towardTarget, downToEarth, normal };
}

function offsetDirectionInSightPlane(
  towardTarget: THREE.Vector3,
  downToEarth: THREE.Vector3,
  elevation: number,
  target: THREE.Vector3,
): void {
  target
    .copy(towardTarget)
    .multiplyScalar(-Math.cos(elevation))
    .addScaledVector(downToEarth, Math.sin(elevation))
    .normalize();
}

function distanceForEarthViewportRadius(
  camera: THREE.PerspectiveCamera,
  observer: THREE.Vector3,
  offsetDirection: THREE.Vector3,
  up: THREE.Vector3,
  earthCenter: THREE.Vector3,
  earthRadius: number,
  minDistance: number,
  maxDistance: number,
): number {
  const targetRadius = BODY_TARGET_EARTH_RADIUS_VIEWPORT_FRACTION;
  const radiusAt = (distance: number): number =>
    earthProjectedRadiusAtDistance(camera, observer, offsetDirection, up, earthCenter, earthRadius, distance);

  if (radiusAt(minDistance) <= targetRadius) {
    return minDistance;
  }
  if (radiusAt(maxDistance) >= targetRadius) {
    return maxDistance;
  }

  let lo = minDistance;
  let hi = maxDistance;
  for (let step = 0; step < 48; step += 1) {
    const mid = (lo + hi) / 2;
    if (radiusAt(mid) > targetRadius) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

function desiredBodyTargetCameraPose(
  camera: THREE.PerspectiveCamera,
  snapshot: SceneSnapshot,
  pointingTarget: string,
  observer: THREE.Vector3,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
  currentOffsetDirection: THREE.Vector3,
  maxDistance: number,
): OrbitCameraPose | null {
  const bodyName = BODY_FOR_TARGET[pointingTarget];
  if (!bodyName) {
    return null;
  }
  const targetPosition = bodyWorldPosition(bodyName);
  const earthCenter = bodyWorldPosition("earth");
  if (!targetPosition || !earthCenter) {
    return null;
  }
  const earthBody = snapshot.bodies.find((body) => body.name === "earth");
  const earthRadius = earthBody?.radius ?? EARTH_RADIUS_AU;

  const orbitNormal = orbitPlaneNormal(snapshot, pointingTarget, currentOffsetDirection);
  const sightFrame = bodyTargetSightFrame(observer, earthCenter, targetPosition, orbitNormal);
  if (!sightFrame) {
    return null;
  }
  const { towardTarget, downToEarth, normal: sightNormal } = sightFrame;
  const cameraUp = _bodySightCross.copy(downToEarth).negate();

  const minDistance = Math.max(DEFAULT_CAMERA_DISTANCE_AU * 0.01, earthRadius * 2, 1e-14);
  const upperDistance =
    Number.isFinite(maxDistance) && maxDistance > 0
      ? maxDistance
      : Math.max(minDistance * 64, DEFAULT_CAMERA_DISTANCE_AU);

  const scratchCamera = _bodyFramingCameraScratch;
  scratchCamera.fov = camera.fov;
  scratchCamera.aspect = camera.aspect;
  scratchCamera.near = camera.near;
  scratchCamera.far = camera.far;
  scratchCamera.updateProjectionMatrix();

  const elevationLimit = Math.PI / 2 - 0.02;
  const targetNdcY = bodyTargetNdcYFromTop();

  const poseAtElevation = (
    elevation: number,
  ): {
    offsetDirection: THREE.Vector3;
    distance: number;
    targetNdcY: number;
    earthNdcY: number;
    targetNdcX: number;
    earthNdcX: number;
  } => {
    const offsetDirection = new THREE.Vector3();
    offsetDirectionInSightPlane(towardTarget, sightNormal, elevation, offsetDirection);
    const distance = distanceForEarthViewportRadius(
      scratchCamera,
      observer,
      offsetDirection,
      cameraUp,
      earthCenter,
      earthRadius,
      minDistance,
      upperDistance,
    );
    _bodyFramingOffset.copy(offsetDirection).multiplyScalar(distance);
    applyOrbitCameraPose(scratchCamera, observer, _bodyFramingOffset, cameraUp);
    const targetNdc = targetPosition.clone().project(scratchCamera);
    const earthNdc = earthCenter.clone().project(scratchCamera);
    return {
      offsetDirection,
      distance,
      targetNdcY: targetNdc.y,
      earthNdcY: earthNdc.y,
      targetNdcX: targetNdc.x,
      earthNdcX: earthNdc.x,
    };
  };

  const framingError = (pose: {
    targetNdcY: number;
    earthNdcY: number;
    targetNdcX: number;
    earthNdcX: number;
  }): number => {
    const targetYError = pose.targetNdcY - targetNdcY;
    let error = targetYError * targetYError + pose.targetNdcX * pose.targetNdcX + pose.earthNdcX * pose.earthNdcX;
    if (pose.earthNdcY >= 0) {
      error += (pose.earthNdcY + 0.05) * (pose.earthNdcY + 0.05);
    }
    if (pose.targetNdcY <= 0) {
      error += (0.05 - pose.targetNdcY) * (0.05 - pose.targetNdcY);
    }
    return error;
  };

  let bestElevation = ORBIT_PLANE_ELEVATION_RAD;
  let bestDistance = minDistance;
  let bestError = Number.POSITIVE_INFINITY;

  for (let sample = 0; sample <= 256; sample += 1) {
    const elevation = (sample / 256) * elevationLimit;
    const pose = poseAtElevation(elevation);
    const error = framingError(pose);
    if (error < bestError) {
      bestError = error;
      bestElevation = elevation;
      bestDistance = pose.distance;
    }
  }

  let refineLo = Math.max(0, bestElevation - elevationLimit / 256);
  let refineHi = Math.min(elevationLimit, bestElevation + elevationLimit / 256);
  for (let step = 0; step < 32; step += 1) {
    const third = (refineHi - refineLo) / 3;
    const leftElevation = refineLo + third;
    const rightElevation = refineHi - third;
    const left = poseAtElevation(leftElevation);
    const right = poseAtElevation(rightElevation);
    if (framingError(left) <= framingError(right)) {
      refineHi = rightElevation;
      if (framingError(left) < bestError) {
        bestError = framingError(left);
        bestElevation = leftElevation;
        bestDistance = left.distance;
      }
    } else {
      refineLo = leftElevation;
      if (framingError(right) < bestError) {
        bestError = framingError(right);
        bestElevation = rightElevation;
        bestDistance = right.distance;
      }
    }
  }

  const offsetDirection = new THREE.Vector3();
  offsetDirectionInSightPlane(towardTarget, sightNormal, bestElevation, offsetDirection);

  return {
    offset: offsetDirection.multiplyScalar(bestDistance),
    up: cameraUp.clone(),
  };
}

function issOrbitPlaneNormalTowardObserver(
  snapshot: SceneSnapshot,
  earthCenter: THREE.Vector3,
  observer: THREE.Vector3,
  currentOffsetDirection: THREE.Vector3,
): THREE.Vector3 | null {
  const points = orbitPathPoints(snapshot, "iss_orbit");
  if (points.length === 0) {
    return null;
  }
  const normal = newellPlaneNormal(points);
  if (!normal) {
    return null;
  }
  const observerSide = observer.clone().sub(earthCenter).dot(normal);
  if (observerSide < -1e-20) {
    normal.negate();
  } else if (Math.abs(observerSide) <= 1e-20 && currentOffsetDirection.dot(normal) < 0) {
    normal.negate();
  }
  return normal;
}

function minDistanceToFramePointsInView(
  camera: THREE.PerspectiveCamera,
  observer: THREE.Vector3,
  offsetDirection: THREE.Vector3,
  points: THREE.Vector3[],
  minDistance: number,
  maxDistance: number,
): number {
  if (points.length === 0) {
    return minDistance;
  }
  const halfFov = halfViewportFovRad(camera, ORBIT_VIEWPORT_FILL);
  const fits = (distance: number): boolean => {
    const cameraPosition = observer.clone().addScaledVector(offsetDirection, distance);
    const toPivot = observer.clone().sub(cameraPosition).normalize();
    for (const point of points) {
      const toPoint = point.clone().sub(cameraPosition);
      if (toPoint.lengthSq() < 1e-24) {
        continue;
      }
      if (toPoint.normalize().angleTo(toPivot) > halfFov) {
        return false;
      }
    }
    return true;
  };

  const upper = Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : minDistance;
  if (!fits(upper)) {
    return upper;
  }
  if (fits(minDistance)) {
    return minDistance;
  }

  let lo = minDistance;
  let hi = upper;
  for (let step = 0; step < 48; step += 1) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return hi;
}

function desiredIssOrbitCameraPose(
  camera: THREE.PerspectiveCamera,
  snapshot: SceneSnapshot,
  pointingTarget: string,
  observer: THREE.Vector3,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
  currentOffsetDirection: THREE.Vector3,
  maxDistance: number,
): OrbitCameraPose | null {
  const earthCenter = bodyWorldPosition("earth");
  if (!earthCenter) {
    return null;
  }
  const normal = issOrbitPlaneNormalTowardObserver(snapshot, earthCenter, observer, currentOffsetDirection);
  if (!normal) {
    return null;
  }

  const orbitPoints = orbitPathPoints(snapshot, "iss_orbit");
  if (orbitPoints.length === 0) {
    return null;
  }
  const toward = targetWorldPosition(snapshot, pointingTarget, observer, bodyWorldPosition);
  const up = inPlaneHorizontal(normal, observer, toward);

  const minDistance = Math.max(DEFAULT_CAMERA_DISTANCE_AU * 0.01, 1e-14);
  let distance = minDistanceToFramePointsInView(camera, observer, normal, orbitPoints, minDistance, maxDistance);
  if (Number.isFinite(maxDistance) && maxDistance > 0) {
    distance = Math.min(distance, maxDistance);
  }
  distance = Math.max(distance, minDistance);

  return {
    offset: normal.clone().multiplyScalar(distance),
    up,
  };
}

function orbitRadiusAu(
  snapshot: SceneSnapshot,
  pointingTarget: string,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
): number {
  const target = framingPointingTarget(pointingTarget);

  if (target === "moon" || target === "iss") {
    const bodyName = BODY_FOR_TARGET[target];
    if (bodyName) {
      const radius = geocentricBodyOrbitRadiusAu(bodyName, snapshot, bodyWorldPosition);
      if (radius !== null && radius > 0) {
        return radius;
      }
    }
  }

  const pathName = POINTING_TARGET_ORBIT_PATH[target];
  if (pathName && pathName !== "earth_axis") {
    const centerBody = ORBIT_PATH_CENTER_BODY[pathName];
    const center = centerBody ? bodyWorldPosition(centerBody) : null;
    const points = orbitPathPoints(snapshot, pathName);
    if (center && points.length > 0) {
      const radius = meanRadiusFromPoints(points, center);
      if (radius !== null && radius > 0) {
        return radius;
      }
    }
  }

  return EARTH_ORBIT_RADIUS_AU;
}

function desiredEarthRotationCameraPose(
  camera: THREE.PerspectiveCamera,
  snapshot: SceneSnapshot,
  pointingTarget: string,
  observer: THREE.Vector3,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
  currentOffsetDirection: THREE.Vector3,
): OrbitCameraPose | null {
  const earthCenter = bodyWorldPosition("earth");
  if (!earthCenter) {
    return null;
  }

  const earthRadius = EARTH_RADIUS_AU;
  const fromCenter = observer.clone().sub(earthCenter);
  let outward = fromCenter.clone();
  if (outward.lengthSq() < 1e-20) {
    outward = currentOffsetDirection.clone().normalize();
  } else {
    outward.normalize();
  }

  let up = orbitPlaneNormal(snapshot, pointingTarget, currentOffsetDirection);
  if (up.dot(WORLD_UP) < 0) {
    up = up.negate();
  }
  if (Math.abs(up.dot(outward)) > 0.95) {
    const tangent = new THREE.Vector3().crossVectors(up, WORLD_UP);
    up =
      tangent.lengthSq() > 1e-16
        ? tangent.normalize()
        : new THREE.Vector3().crossVectors(up, new THREE.Vector3(1, 0, 0)).normalize();
  }

  const halfFov = halfViewportFovRad(camera, EARTH_VIEWPORT_FILL);

  const distance = Math.max(earthRadius / Math.tan(halfFov) - earthRadius, earthRadius * 0.25);

  return {
    offset: outward.multiplyScalar(distance),
    up,
  };
}

export function desiredOrbitTargetCameraPose(
  camera: THREE.PerspectiveCamera,
  snapshot: SceneSnapshot,
  pointingTarget: string,
  observer: THREE.Vector3,
  bodyWorldPosition: (name: string) => THREE.Vector3 | null,
  currentOffsetDirection: THREE.Vector3,
  maxDistance: number,
): OrbitCameraPose {
  if (isDirectBodyPointingTarget(pointingTarget)) {
    const bodyPose = desiredBodyTargetCameraPose(
      camera,
      snapshot,
      pointingTarget,
      observer,
      bodyWorldPosition,
      currentOffsetDirection,
      maxDistance,
    );
    if (bodyPose) {
      return bodyPose;
    }
  }

  if (framingPointingTarget(pointingTarget) === "iss") {
    const issPose = desiredIssOrbitCameraPose(
      camera,
      snapshot,
      pointingTarget,
      observer,
      bodyWorldPosition,
      currentOffsetDirection,
      maxDistance,
    );
    if (issPose) {
      return issPose;
    }
  }

  if (pointingTarget === "earth_rotation") {
    const earthPose = desiredEarthRotationCameraPose(
      camera,
      snapshot,
      pointingTarget,
      observer,
      bodyWorldPosition,
      currentOffsetDirection,
    );
    if (earthPose) {
      return earthPose;
    }
  }

  let normal = orbitPlaneNormal(snapshot, pointingTarget, currentOffsetDirection);
  if (normal.dot(WORLD_UP) < 0) {
    normal = normal.negate();
  }

  const toward = targetWorldPosition(snapshot, pointingTarget, observer, bodyWorldPosition);
  const horizontal = inPlaneHorizontal(normal, observer, toward);

  const elevation = ORBIT_PLANE_ELEVATION_RAD;
  const offsetDirection = horizontal
    .clone()
    .multiplyScalar(-Math.cos(elevation))
    .add(normal.clone().multiplyScalar(Math.sin(elevation)))
    .normalize();

  let distance = orbitRadiusAu(snapshot, pointingTarget, bodyWorldPosition);
  if (Number.isFinite(maxDistance) && maxDistance > 0) {
    distance = Math.min(distance, maxDistance);
  }
  distance = Math.max(distance, DEFAULT_CAMERA_DISTANCE_AU * 0.01);

  return {
    offset: offsetDirection.multiplyScalar(distance),
    up: normal,
  };
}

export function cameraPoseFromState(camera: THREE.PerspectiveCamera, pivot: THREE.Vector3): OrbitCameraPose {
  return {
    offset: camera.position.clone().sub(pivot),
    up: camera.up.clone().normalize(),
  };
}

/** Matches Trimesh `Scene.scale` (L2 norm of the world-axis-aligned bounds). */
export function sceneScaleAuFromSnapshot(snapshot: SceneSnapshot): number {
  _sceneBoundsMin.set(Infinity, Infinity, Infinity);
  _sceneBoundsMax.set(-Infinity, -Infinity, -Infinity);
  let hasGeometry = false;

  const includePoint = (x: number, y: number, z: number): void => {
    hasGeometry = true;
    if (x < _sceneBoundsMin.x) {
      _sceneBoundsMin.x = x;
    }
    if (y < _sceneBoundsMin.y) {
      _sceneBoundsMin.y = y;
    }
    if (z < _sceneBoundsMin.z) {
      _sceneBoundsMin.z = z;
    }
    if (x > _sceneBoundsMax.x) {
      _sceneBoundsMax.x = x;
    }
    if (y > _sceneBoundsMax.y) {
      _sceneBoundsMax.y = y;
    }
    if (z > _sceneBoundsMax.z) {
      _sceneBoundsMax.z = z;
    }
  };

  for (const body of snapshot.bodies) {
    _heavenlyOrbitMatrix.fromArray(body.matrix);
    _heavenlyOrbitCenter.setFromMatrixPosition(_heavenlyOrbitMatrix);
    includePoint(
      _heavenlyOrbitCenter.x - body.radius,
      _heavenlyOrbitCenter.y - body.radius,
      _heavenlyOrbitCenter.z - body.radius,
    );
    includePoint(
      _heavenlyOrbitCenter.x + body.radius,
      _heavenlyOrbitCenter.y + body.radius,
      _heavenlyOrbitCenter.z + body.radius,
    );
  }
  for (const path of snapshot.paths) {
    for (const point of pathPoints(path)) {
      includePoint(point.x, point.y, point.z);
    }
  }
  const timeMs = snapshotSimulationTimeMs(snapshot);
  for (const orbit of snapshot.parametric_orbits) {
    if (snapshot.paths.some((path) => path.name === orbit.name)) {
      continue;
    }
    if (!orbitWorldPointsFromSnapshot(snapshot, orbit.name, timeMs, _orbitWorldPoints)) {
      continue;
    }
    for (const point of _orbitWorldPoints) {
      includePoint(point.x, point.y, point.z);
    }
  }
  for (const arrow of snapshot.arrows) {
    includePoint(arrow.base[0], arrow.base[1], arrow.base[2]);
  }

  if (!hasGeometry) {
    return 1;
  }
  _sceneBoundsExtents.subVectors(_sceneBoundsMax, _sceneBoundsMin);
  return _sceneBoundsExtents.length();
}

/** Galactic orbit diameter; upper bound for camera distance from the orbit pivot. */
export function milkyWayDiameterAuFromSnapshot(snapshot: SceneSnapshot): number {
  const galacticCenter = snapshot.bodies.find((body) => body.name === "galactic_center");
  if (!galacticCenter) {
    return 0;
  }
  const orbitPoints = orbitPathPoints(snapshot, "galactic_orbit");
  if (orbitPoints.length === 0) {
    return 0;
  }
  _heavenlyOrbitMatrix.fromArray(galacticCenter.matrix);
  _heavenlyOrbitCenter.setFromMatrixPosition(_heavenlyOrbitMatrix);
  let maxRadius = 0;
  for (const point of orbitPoints) {
    maxRadius = Math.max(maxRadius, point.distanceTo(_heavenlyOrbitCenter));
  }
  return 2 * maxRadius;
}
