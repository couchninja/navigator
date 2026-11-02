import * as THREE from "three";
import { CSS2DObject } from "three/examples/jsm/renderers/CSS2DRenderer.js";

import { BRIGHT_STARS, CONSTELLATION_LINE_SEGMENTS } from "./constellation-data";

const J2000_OBLIQUITY_RAD = (23.4392911 * Math.PI) / 180;
const SKY_FAR_FRACTION = 0.92;

/** J2000 equatorial centroids for named constellations (degrees). */
const NAMED_CONSTELLATION_LABELS: readonly {
  name: string;
  raDeg: number;
  decDeg: number;
}[] = [
  { name: "Sagittarius", raDeg: 266.416, decDeg: -29.0078 },
  { name: "Cygnus", raDeg: 307, decDeg: 42 },
  { name: "Leo", raDeg: 165, decDeg: 15 },
];

function equatorialUnitVector(raDeg: number, decDeg: number): THREE.Vector3 {
  const ra = (raDeg * Math.PI) / 180;
  const dec = (decDeg * Math.PI) / 180;
  const cosDec = Math.cos(dec);
  return new THREE.Vector3(cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec));
}

function equatorialToEcliptic(vector: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(J2000_OBLIQUITY_RAD);
  const s = Math.sin(J2000_OBLIQUITY_RAD);
  return new THREE.Vector3(vector.x, c * vector.y + s * vector.z, -s * vector.y + c * vector.z);
}

function skyDirection(raDeg: number, decDeg: number): THREE.Vector3 {
  return equatorialToEcliptic(equatorialUnitVector(raDeg, decDeg));
}

function starPointSize(magnitude: number): number {
  return Math.max(1.4, 6.5 - magnitude * 1.05);
}

function buildStarPoints(radius: number): THREE.Points {
  const positions = new Float32Array(BRIGHT_STARS.length * 3);
  for (let index = 0; index < BRIGHT_STARS.length; index += 1) {
    const [raDeg, decDeg] = BRIGHT_STARS[index];
    const direction = skyDirection(raDeg, decDeg).multiplyScalar(radius);
    positions[index * 3] = direction.x;
    positions[index * 3 + 1] = direction.y;
    positions[index * 3 + 2] = direction.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xe8eef8,
    size: starPointSize(2.5),
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -2;
  return points;
}

function buildConstellationLines(radius: number): THREE.LineSegments {
  const positions = new Float32Array(CONSTELLATION_LINE_SEGMENTS.length * 6);
  for (let index = 0; index < CONSTELLATION_LINE_SEGMENTS.length; index += 1) {
    const [ra0, dec0, ra1, dec1] = CONSTELLATION_LINE_SEGMENTS[index];
    const start = skyDirection(ra0, dec0).multiplyScalar(radius);
    const end = skyDirection(ra1, dec1).multiplyScalar(radius);
    const offset = index * 6;
    positions[offset] = start.x;
    positions[offset + 1] = start.y;
    positions[offset + 2] = start.z;
    positions[offset + 3] = end.x;
    positions[offset + 4] = end.y;
    positions[offset + 5] = end.z;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0x1e2838,
    transparent: true,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = -1;
  return lines;
}

function createConstellationLabel(text: string): CSS2DObject {
  const element = document.createElement("div");
  element.textContent = text;
  element.style.color = "rgb(150, 180, 220)";
  element.style.font = "600 13px system-ui, sans-serif";
  element.style.textShadow = "0 1px 4px rgba(0,0,0,0.9)";
  element.style.pointerEvents = "none";
  element.style.whiteSpace = "nowrap";
  element.style.letterSpacing = "0.02em";
  return new CSS2DObject(element);
}

function buildConstellationLabels(radius: number): { group: THREE.Group; labels: CSS2DObject[] } {
  const group = new THREE.Group();
  group.name = "constellation_labels";
  const labels: CSS2DObject[] = [];
  for (const entry of NAMED_CONSTELLATION_LABELS) {
    const label = createConstellationLabel(entry.name);
    const direction = skyDirection(entry.raDeg, entry.decDeg).multiplyScalar(radius);
    label.position.copy(direction);
    group.add(label);
    labels.push(label);
  }
  return { group, labels };
}

function buildBackdrop(radius: number): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(radius, 64, 48);
  const material = new THREE.MeshBasicMaterial({
    color: 0x03060c,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -3;
  return mesh;
}

export type ConstellationSky = {
  root: THREE.Group;
  labels: readonly CSS2DObject[];
  setInertialToRootRotation: (values: number[] | undefined) => void;
  setRadius: (radius: number) => void;
  setOpacity: (opacity: number) => void;
  radiusForCameraFar: (far: number) => number;
};

function smoothstep01(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/** Opacity 1 at or below `fadeStart`, 0 at or above `fadeStart + fadeSpan`, smoothstep between. */
export function opacityFadeOutAboveThreshold(value: number, fadeStart: number, fadeSpan: number): number {
  if (value <= fadeStart) {
    return 1;
  }
  const fadeEnd = fadeStart + fadeSpan;
  if (value >= fadeEnd || fadeSpan <= 0) {
    return 0;
  }
  const linear = (value - fadeStart) / fadeSpan;
  return 1 - smoothstep01(linear);
}

export function skyOpacityForCameraDistance(
  cameraDistanceAu: number,
  earthOrbitRadiusAu: number,
  fadeStartOrbitMultiple: number,
  fadeSpanOrbitMultiple: number,
): number {
  return opacityFadeOutAboveThreshold(
    cameraDistanceAu,
    fadeStartOrbitMultiple * earthOrbitRadiusAu,
    fadeSpanOrbitMultiple * earthOrbitRadiusAu,
  );
}

const ORIENTATION_MATRIX = new THREE.Matrix4();

function applyOrientation(group: THREE.Group, rotation: THREE.Matrix3): void {
  ORIENTATION_MATRIX.setFromMatrix3(rotation);
  group.matrix.copy(ORIENTATION_MATRIX);
  group.matrixAutoUpdate = false;
  group.matrixWorldNeedsUpdate = true;
}

/** Geometry is built on a unit sphere; ``shell`` scale tracks camera far plane. */
const UNIT_SKY_RADIUS = 1;

export function createConstellationSky(initialRadius: number): ConstellationSky {
  const root = new THREE.Group();
  root.name = "constellation_sky";
  root.frustumCulled = false;

  const oriented = new THREE.Group();
  oriented.name = "constellation_sky_oriented";
  const shell = new THREE.Group();
  shell.name = "constellation_sky_shell";
  root.add(oriented);
  oriented.add(shell);

  let inertialToRoot = new THREE.Matrix3().identity();
  applyOrientation(oriented, inertialToRoot);

  let radius = initialRadius;
  const backdrop = buildBackdrop(UNIT_SKY_RADIUS);
  const stars = buildStarPoints(UNIT_SKY_RADIUS);
  const lines = buildConstellationLines(UNIT_SKY_RADIUS);
  const labelBundle = buildConstellationLabels(UNIT_SKY_RADIUS);
  shell.add(backdrop, stars, lines, labelBundle.group);
  shell.scale.setScalar(radius);

  const setRadius = (nextRadius: number): void => {
    if (Math.abs(nextRadius - radius) < radius * 0.02) {
      return;
    }
    radius = nextRadius;
    shell.scale.setScalar(radius);
  };

  const backdropMaterial = backdrop.material as THREE.MeshBasicMaterial;
  const starsMaterial = stars.material as THREE.PointsMaterial;
  const linesMaterial = lines.material as THREE.LineBasicMaterial;

  const setOpacity = (opacity: number): void => {
    const clamped = Math.max(0, Math.min(1, opacity));
    backdropMaterial.transparent = clamped < 1;
    backdropMaterial.opacity = clamped;
    starsMaterial.opacity = clamped;
    linesMaterial.opacity = clamped;
  };

  const setInertialToRootRotation = (values: number[] | undefined): void => {
    if (values === undefined || values.length !== 9) {
      inertialToRoot.identity();
    } else {
      inertialToRoot.fromArray(values);
    }
    applyOrientation(oriented, inertialToRoot);
  };

  return {
    root,
    get labels() {
      return labelBundle.labels;
    },
    setInertialToRootRotation,
    setRadius,
    setOpacity,
    radiusForCameraFar: (far: number) => far * SKY_FAR_FRACTION,
  };
}
