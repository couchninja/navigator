import * as THREE from "three";
import { WebGPURenderer } from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

import { createViewerOutlinePipeline, type ViewerOutlinePipeline } from "./viewer-outline-pipeline";

import {
  cameraPoseFromState,
  desiredOrbitTargetCameraPose,
  heavenlyBodyOrbitRadiusAu,
  milkyWayDiameterAuFromSnapshot,
  sceneScaleAuFromSnapshot,
} from "./camera-orbit-framing";
import {
  ARROW_LENGTH_CAMERA_DISTANCE_FRACTION,
  ARROW_MESH_LENGTH_AU,
  DEFAULT_CAMERA_DISTANCE_AU,
  EARTH_ORBIT_RADIUS_AU,
  EARTH_RADIUS_AU,
  SKYBOX_FADE_CAMERA_DISTANCE_ORBIT_MULTIPLE,
  SKYBOX_FADE_SPAN_ORBIT_RADIUS_MULTIPLE,
} from "./scene-viewer-constants";
import {
  cameraOrbitTweenActive,
  tweenCameraToOrbitPose,
  updateCameraTargetTweens,
  type CameraOrbitTweenHandle,
} from "./camera-target-orbit";
import { createConstellationSky, skyOpacityForCameraDistance } from "./constellation-sky";
import { createFlatArrowGroup, disposeFlatArrowGroup, orientFlatArrow } from "./billboard-arrow";
import { isPointingArrowName, pointingArrowName } from "./pointing-arrow";
import { createEarthMesh } from "./earth-mesh";
import { sampleKeplerianOrbitPoints, type KeplerianOrbitParams } from "./keplerian-orbit";
import { heliocentricOriginForParametricOrbit, parametricOrbitSampleCount } from "./orbit-path-samples";
import { simulationTimeMsFromIso } from "./simulation-time";
import { sampleTleOrbitPoints, type TleOrbitParams } from "./tle-orbit";
import type {
  ArrowDistanceAnchor,
  ParametricOrbit,
  Rgb,
  SceneArrow,
  SceneBody,
  ScenePath,
  SceneSnapshot,
} from "./scene-types";

const VIEWER_TARGET_FPS = 60;
const VIEWER_FRAME_MS = 1000 / VIEWER_TARGET_FPS;
const LABEL_OFFSET_BODY_RADII = 2.5;
const _labelWorldCenter = new THREE.Vector3();
const _labelWorldAnchor = new THREE.Vector3();
const _cameraScreenDown = new THREE.Vector3();
const _galacticCenterWorld = new THREE.Vector3();
const _orbitPivot = new THREE.Vector3();
const SELF_LIT_BODY_EMISSIVE_INTENSITY: Partial<Record<string, number>> = {
  sun: 0.65,
  observer: 0.45,
  iss: 0.45,
};
const BODY_LABEL_COLORS: Record<string, string> = {
  sun: "rgb(255, 210, 60)",
  earth: "rgb(255, 255, 255)",
  moon: "rgb(210, 210, 205)",
  iss: "rgb(70, 130, 255)",
  observer: "rgb(255, 80, 40)",
  galactic_center: "rgb(240, 200, 255)",
};
const BODY_LABELS: Record<string, string> = {
  sun: "Sun",
  earth: "Earth",
  moon: "Moon",
  iss: "ISS",
  galactic_center: "Milky Way center",
};

function rgbToThree([r, g, b]: Rgb): THREE.Color {
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function matrixFromSnapshot(values: number[]): THREE.Matrix4 {
  const matrix = new THREE.Matrix4();
  matrix.fromArray(values);
  return matrix;
}

function createSphereMesh(radius: number, color: Rgb, emissiveIntensity = 0): THREE.Mesh {
  const geometry = new THREE.IcosahedronGeometry(radius, 3);
  const threeColor = rgbToThree(color);
  const material = new THREE.MeshStandardMaterial({
    color: threeColor,
    roughness: 0.75,
    ...(emissiveIntensity > 0 ? { emissive: threeColor.clone(), emissiveIntensity } : {}),
  });
  return new THREE.Mesh(geometry, material);
}

const ARROW_HEAD_LENGTH_FRACTION = 0.1;
const ARROW_HEAD_WIDTH_EARTH_RADII = 0.3;
const ARROW_SHAFT_WIDTH_EARTH_RADII = 0.14;
const ARROW_OCCLUDED_OPACITY = 0.45;
/** Temporary: set true to draw the faded behind-geometry arrow pass. */
const ARROW_OCCLUDED_PASS_ENABLED = true;
const ARROW_OCCLUDED_RENDER_ORDER = 1;
const ARROW_VISIBLE_RENDER_ORDER = 2;
/** Separate duplicate arrow passes in depth to avoid WebGPU z-fighting at large clip distances. */
const ARROW_VISIBLE_POLYGON_OFFSET = { factor: -2, units: -2 };
const ARROW_OCCLUDED_POLYGON_OFFSET = { factor: 2, units: 2 };
/** Web view: longer than desktop so the arrow stays readable when zoomed out. */
const ARROW_LENGTH_BOOST = 2.5;
/** Matches `OBSERVER_VELOCITY_ARROW_SHAFT_START_OBSERVER_RADIUS_MULTIPLE` in simulate/astronomy/constants.py */
const ARROW_SHAFT_START_OBSERVER_RADIUS_MULTIPLE = 50;
type ArrowFrame = {
  base: THREE.Vector3;
  direction: THREE.Vector3;
  color: Rgb;
  distanceAnchor: ArrowDistanceAnchor;
  displayLengthAu: number;
  displayGapAu: number;
};

function observerArrowShaftStartAu(
  observerRadiusAu: number,
  cameraDistanceAu: number,
  defaultCameraDistanceAu: number,
): number {
  if (defaultCameraDistanceAu <= 0) {
    return 0;
  }
  const defaultGapAu = ARROW_SHAFT_START_OBSERVER_RADIUS_MULTIPLE * observerRadiusAu;
  return defaultGapAu * (cameraDistanceAu / defaultCameraDistanceAu);
}

const FLAT_ARROW_MATERIAL_OPTIONS = {
  occludedOpacity: ARROW_OCCLUDED_OPACITY,
  drawOccludedPass: ARROW_OCCLUDED_PASS_ENABLED,
  visibleRenderOrder: ARROW_VISIBLE_RENDER_ORDER,
  occludedRenderOrder: ARROW_OCCLUDED_RENDER_ORDER,
  visiblePolygonOffset: ARROW_VISIBLE_POLYGON_OFFSET,
  occludedPolygonOffset: ARROW_OCCLUDED_POLYGON_OFFSET,
} as const;

function cameraDistanceForArrow(
  camera: THREE.PerspectiveCamera,
  target: THREE.Vector3,
  anchor: ArrowDistanceAnchor,
  galacticCenterRoot: THREE.Object3D | null,
): number {
  if (anchor === "galactic_center") {
    if (!galacticCenterRoot) {
      return camera.position.distanceTo(target);
    }
    galacticCenterRoot.getWorldPosition(_galacticCenterWorld);
    return camera.position.distanceTo(_galacticCenterWorld);
  }
  return camera.position.distanceTo(target);
}

function createLabel(text: string, color: string): CSS2DObject {
  const element = document.createElement("div");
  element.textContent = text;
  element.style.color = color;
  element.style.font = "600 14px system-ui, sans-serif";
  element.style.textShadow = "0 1px 3px rgba(0,0,0,0.85)";
  element.style.pointerEvents = "none";
  element.style.whiteSpace = "nowrap";
  return new CSS2DObject(element);
}

type BodyEntry = {
  root: THREE.Object3D;
  label: CSS2DObject | null;
  radius: number;
};

type PathEntry = {
  root: THREE.Object3D;
  segmentSignature: string;
};

export class EarthSunViewer {
  readonly root: HTMLElement;

  private renderer!: WebGPURenderer;
  private outlinePipeline: ViewerOutlinePipeline | null = null;
  private renderReady = false;
  private readonly labelRenderer: CSS2DRenderer;
  private readonly scene: THREE.Scene;
  /** Scene graph rebased each frame so the observer sits at the origin (GPU float32 precision). */
  private readonly contentRoot: THREE.Group;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly bodies = new Map<string, BodyEntry>();
  private readonly legacySegmentPathsRoot: THREE.Group;
  private readonly legacyOrbitsRoot: THREE.Group;
  private readonly parametricPathsRoot: THREE.Group;
  private readonly paths = new Map<string, PathEntry>();
  private readonly parametricPaths = new Map<string, PathEntry>();
  private parametricOrbits: ParametricOrbit[] = [];
  private simTimeAnchorMs = 0;
  private wallAnchorMs = 0;
  private timeScaling = 1;
  private readonly parametricOrbitScratch: THREE.Vector3[] = [];
  private readonly arrows = new Map<string, THREE.Group>();
  private readonly arrowFrames = new Map<string, ArrowFrame>();
  private readonly sunPointLight: THREE.PointLight;
  private readonly observerPosition = new THREE.Vector3();
  private readonly defaultCameraOffset = new THREE.Vector3(0, 0, 1);
  private readonly constellationSky = createConstellationSky(1);
  private arrowMeshLengthAu = 0;
  private arrowEarthRadiusAu = 0;
  private arrowLengthCameraFraction = 0.05;
  private readonly canvasHost: HTMLDivElement;
  private readonly captionEl: HTMLDivElement;
  private readonly fpsEl: HTMLDivElement;
  private resizeObserver: ResizeObserver | null = null;
  private defaultCameraDistance = 1;
  private earthRadiusAu = 1;
  private earthOrbitRadiusAu = 1;
  private skyboxFadeOrbitMultiple = 10;
  private skyboxFadeSpanOrbitMultiple = 10;
  private skyOpacity = 1;
  private sceneScale = 1;
  private animationId = 0;
  private lastRenderTime = 0;
  private geometryPollIntervalMs = VIEWER_FRAME_MS;
  private cameraMotionUntil = 0;
  private fpsFrames = 0;
  private fpsIntervalStart = performance.now();
  private fpsDisplay = 0;
  private hasInitialCamera = false;
  private lastPointingTarget: string | null = null;
  private pointingTarget = "";
  /** Target changed before the next scene snapshot (e.g. ISS TLE) was loaded. */
  private pendingPointingTargetCamera = false;
  private cameraOrbitTween: CameraOrbitTweenHandle | null = null;
  private cameraOrbitTweenUntil = 0;
  private sceneSnapshot: SceneSnapshot | null = null;

  constructor(mount: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "earth-sun-viewer";
    mount.appendChild(this.root);

    this.canvasHost = document.createElement("div");
    this.canvasHost.className = "earth-sun-viewer-canvas";
    this.root.appendChild(this.canvasHost);

    this.captionEl = document.createElement("div");
    this.captionEl.className = "earth-sun-viewer-caption";
    this.canvasHost.appendChild(this.captionEl);

    this.fpsEl = document.createElement("div");
    this.fpsEl.className = "earth-sun-viewer-fps";
    this.canvasHost.appendChild(this.fpsEl);

    this.scene = new THREE.Scene();
    this.contentRoot = new THREE.Group();
    this.contentRoot.name = "content_root";
    this.legacySegmentPathsRoot = new THREE.Group();
    this.legacySegmentPathsRoot.name = "legacy_segment_paths";
    this.legacyOrbitsRoot = new THREE.Group();
    this.legacyOrbitsRoot.name = "legacy_ephemeris_orbits";
    this.parametricPathsRoot = new THREE.Group();
    this.parametricPathsRoot.name = "parametric_paths";
    this.contentRoot.add(this.legacySegmentPathsRoot, this.legacyOrbitsRoot, this.parametricPathsRoot);
    this.scene.add(this.constellationSky.root, this.contentRoot);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 1000);
    this.camera.position.set(0, 0, 1);

    this.canvasHost.getBoundingClientRect();

    this.renderer = new WebGPURenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.canvasHost.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.style.position = "absolute";
    this.labelRenderer.domElement.style.inset = "0";
    this.labelRenderer.domElement.style.pointerEvents = "none";
    this.canvasHost.appendChild(this.labelRenderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener("change", () => {
      this.cameraMotionUntil = performance.now() + 250;
      this.clampCameraDistance();
      this.syncClipPlanes();
      this.layoutArrows();
      this.updateLabels();
      this.labelRenderer.render(this.scene, this.camera);
    });

    const ambient = new THREE.AmbientLight(0xffffff, 0.12);
    this.sunPointLight = new THREE.PointLight(0xfff2cc, 2.5, 0, 2);
    this.contentRoot.add(ambient, this.sunPointLight);

    this.resizeObserver = new ResizeObserver(() => {
      this.onResize();
    });
    this.resizeObserver.observe(this.canvasHost);
    void this.bootstrapRenderer();
  }

  private async bootstrapRenderer(): Promise<void> {
    await this.renderer.init();
    this.outlinePipeline = createViewerOutlinePipeline(this.renderer, this.scene, this.camera);
    this.syncOutlineSelection();
    this.renderReady = true;
    this.onResize();
    this.animate();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.refreshCanvasCompositor();
      });
    });
  }

  private refreshCanvasCompositor(): void {
    const canvas = this.renderer.domElement;
    const parent = canvas.parentElement;
    if (!parent) {
      this.onResize();
      return;
    }
    parent.removeChild(canvas);
    parent.insertBefore(canvas, this.labelRenderer.domElement);
    this.onResize();
  }

  setGeometryPollIntervalMs(intervalMs: number): void {
    this.geometryPollIntervalMs = intervalMs;
  }

  dispose(): void {
    cancelAnimationFrame(this.animationId);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.outlinePipeline?.dispose();
    this.outlinePipeline = null;
    this.renderer.dispose();
    this.root.remove();
  }

  applyNavigatorStatus(status: { target: string; timeIso: string | null; timeScaling: number }): void {
    if (status.timeIso) {
      this.captionEl.textContent = `Earth-sun (${status.timeIso})`;
      this.setSimulationClock(status.timeIso, status.timeScaling);
    }
    const targetChanged =
      this.hasInitialCamera &&
      this.lastPointingTarget !== null &&
      status.target !== "" &&
      status.target !== this.lastPointingTarget;
    this.pointingTarget = status.target;
    this.lastPointingTarget = status.target;
    this.syncArrowVisibility();
    if (targetChanged) {
      this.pendingPointingTargetCamera = true;
    }
  }

  setLegacySegmentOrbitsVisible(visible: boolean): void {
    this.legacyOrbitsRoot.visible = visible;
    const sidebarInput = document.getElementById("legacy-orbit-lines-control");
    if (sidebarInput instanceof HTMLInputElement && sidebarInput.checked !== visible) {
      sidebarInput.checked = visible;
    }
  }

  setParametricOrbitsVisible(visible: boolean): void {
    this.parametricPathsRoot.visible = visible;
    const sidebarInput = document.getElementById("parametric-orbit-lines-control");
    if (sidebarInput instanceof HTMLInputElement && sidebarInput.checked !== visible) {
      sidebarInput.checked = visible;
    }
  }

  applySnapshot(snapshot: SceneSnapshot): void {
    this.sceneSnapshot = snapshot;
    this.setSimulationClock(snapshot.simulation_time_iso, this.timeScaling);
    this.parametricOrbits = snapshot.parametric_orbits ?? [];
    this.defaultCameraDistance = DEFAULT_CAMERA_DISTANCE_AU;
    this.earthRadiusAu = EARTH_RADIUS_AU;
    this.earthOrbitRadiusAu = EARTH_ORBIT_RADIUS_AU;
    this.skyboxFadeOrbitMultiple = SKYBOX_FADE_CAMERA_DISTANCE_ORBIT_MULTIPLE;
    this.skyboxFadeSpanOrbitMultiple = SKYBOX_FADE_SPAN_ORBIT_RADIUS_MULTIPLE;
    this.arrowMeshLengthAu = ARROW_MESH_LENGTH_AU;
    this.arrowEarthRadiusAu = EARTH_RADIUS_AU;
    this.arrowLengthCameraFraction = ARROW_LENGTH_CAMERA_DISTANCE_FRACTION;
    this.sceneScale = sceneScaleAuFromSnapshot(snapshot);
    this.constellationSky.setInertialToRootRotation(snapshot.inertial_to_root_rotation);
    const milkyWayDiameterAu = milkyWayDiameterAuFromSnapshot(snapshot);
    if (milkyWayDiameterAu > 0) {
      this.controls.maxDistance = milkyWayDiameterAu;
    }
    this.clampCameraDistance();

    for (const body of snapshot.bodies) {
      this.updateBody(body);
    }
    for (const path of snapshot.paths) {
      this.updatePath(path);
    }
    this.removePathsExcept(snapshot.paths.map((path) => path.name));
    this.syncParametricOrbitDefinitions();
    this.updateParametricOrbitGeometry(this.currentSimulationTimeMs());
    for (const arrow of snapshot.arrows) {
      this.updateArrow(arrow);
    }
    this.removeArrowsExcept(snapshot.arrows.map((arrow) => arrow.name));
    this.layoutArrows();
    this.syncClipPlanes();
    this.updateLabels();
    this.syncOrbitPivot();
    if (!this.hasInitialCamera) {
      this.resetCamera();
      this.hasInitialCamera = true;
    }
    if (this.pendingPointingTargetCamera && this.pointingTarget !== "") {
      this.pendingPointingTargetCamera = false;
      this.animateCameraForPointingTarget(snapshot);
    }
    this.lastRenderTime = 0;
  }

  private updateBody(body: SceneBody): void {
    let entry = this.bodies.get(body.name);
    if (!entry) {
      const root = new THREE.Object3D();
      root.name = body.name;
      const labelText = BODY_LABELS[body.name];
      const label =
        body.name === "observer" || !labelText ? null : createLabel(labelText, BODY_LABEL_COLORS[body.name] ?? "white");
      if (label) {
        root.add(label);
      }
      this.contentRoot.add(root);
      entry = { root, label, radius: 0 };
      this.bodies.set(body.name, entry);
    }

    if (Math.abs(entry.radius - body.radius) > entry.radius * 1e-6) {
      entry.root.children
        .filter((child) => child instanceof THREE.Mesh)
        .forEach((mesh) => {
          entry.root.remove(mesh);
          (mesh as THREE.Mesh).geometry.dispose();
        });
      const mesh =
        body.name === "earth"
          ? createEarthMesh(body.radius)
          : createSphereMesh(body.radius, body.color, SELF_LIT_BODY_EMISSIVE_INTENSITY[body.name] ?? 0);
      entry.root.add(mesh);
      entry.radius = body.radius;
    }

    entry.root.matrixAutoUpdate = false;
    entry.root.matrix.copy(matrixFromSnapshot(body.matrix));
    entry.root.matrixWorldNeedsUpdate = true;
    if (entry.label) {
      entry.label.position.set(0, 0, body.radius * LABEL_OFFSET_BODY_RADII);
    }
    if (body.name === "sun") {
      this.sunPointLight.position.setFromMatrixPosition(entry.root.matrix);
    }
  }

  private updatePath(path: ScenePath): void {
    const segmentSignature = JSON.stringify(path.segments);
    const existing = this.paths.get(path.name);
    if (existing?.segmentSignature === segmentSignature) {
      existing.root.matrixAutoUpdate = false;
      existing.root.matrix.copy(matrixFromSnapshot(path.matrix));
      existing.root.matrixWorldNeedsUpdate = true;
      return;
    }

    if (existing) {
      existing.root.parent?.remove(existing.root);
      existing.root.traverse((object) => {
        if (object instanceof THREE.Line) {
          object.geometry.dispose();
          (object.material as THREE.Material).dispose();
        }
      });
    }

    const root = new THREE.Object3D();
    root.name = path.name;
    root.matrixAutoUpdate = false;
    root.matrix.copy(matrixFromSnapshot(path.matrix));
    const pathParent = path.name.endsWith("_orbit") ? this.legacyOrbitsRoot : this.legacySegmentPathsRoot;
    for (const segment of path.segments) {
      if (segment.length < 2) {
        continue;
      }
      const points = segment.map(([x, y, z]) => new THREE.Vector3(x, y, z));
      if (path.name.endsWith("_orbit") && points.length >= 3) {
        points.push(points[0].clone());
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: rgbToThree(path.color),
        transparent: true,
        opacity: 0.95,
      });
      root.add(new THREE.Line(geometry, material));
    }
    pathParent.add(root);
    this.paths.set(path.name, { root, segmentSignature });
  }

  private setSimulationClock(iso: string, timeScaling: number): void {
    this.timeScaling = timeScaling > 0 ? timeScaling : 1;
    this.simTimeAnchorMs = simulationTimeMsFromIso(iso);
    this.wallAnchorMs = performance.now();
  }

  private currentSimulationTimeMs(): number {
    return this.simTimeAnchorMs + (performance.now() - this.wallAnchorMs) * this.timeScaling;
  }

  private syncParametricOrbitDefinitions(): void {
    const keep = new Set(this.parametricOrbits.map((orbit) => orbit.name));
    for (const name of this.parametricPaths.keys()) {
      if (keep.has(name)) {
        continue;
      }
      const existing = this.parametricPaths.get(name);
      if (existing) {
        this.parametricPathsRoot.remove(existing.root);
        existing.root.traverse((object) => {
          if (object instanceof THREE.Line) {
            object.geometry.dispose();
            (object.material as THREE.Material).dispose();
          }
        });
      }
      this.parametricPaths.delete(name);
    }
    for (const orbit of this.parametricOrbits) {
      let entry = this.parametricPaths.get(orbit.name);
      if (!entry) {
        const root = new THREE.Object3D();
        root.name = `${orbit.name}_parametric`;
        root.matrixAutoUpdate = false;
        this.parametricPathsRoot.add(root);
        entry = { root, segmentSignature: "" };
        this.parametricPaths.set(orbit.name, entry);
      }
      entry.root.matrixAutoUpdate = false;
      entry.root.matrix.copy(matrixFromSnapshot(orbit.matrix));
      entry.root.matrixWorldNeedsUpdate = true;
    }
  }

  private updateParametricOrbitGeometry(timeMs: number): void {
    const originHeliocentric = new THREE.Vector3();
    for (const orbit of this.parametricOrbits) {
      const entry = this.parametricPaths.get(orbit.name);
      if (!entry) {
        continue;
      }
      const origin = heliocentricOriginForParametricOrbit(orbit, originHeliocentric);
      if (origin === undefined) {
        continue;
      }
      const samples = parametricOrbitSampleCount(orbit.name);
      if (orbit.kind === "keplerian") {
        sampleKeplerianOrbitPoints(orbit as KeplerianOrbitParams, timeMs, samples, origin, this.parametricOrbitScratch);
      } else {
        sampleTleOrbitPoints(orbit as TleOrbitParams, timeMs, samples, origin, this.parametricOrbitScratch);
      }
      const signature = this.parametricOrbitScratch
        .map((point) => point.toArray())
        .flat()
        .join(",");
      if (entry.segmentSignature === signature) {
        continue;
      }
      entry.root.children
        .filter((child) => child instanceof THREE.Line)
        .forEach((line) => {
          entry.root.remove(line);
          line.geometry.dispose();
          (line.material as THREE.Material).dispose();
        });
      const points = [...this.parametricOrbitScratch, this.parametricOrbitScratch[0]?.clone()].filter(
        (point): point is THREE.Vector3 => point !== undefined,
      );
      if (points.length < 2) {
        continue;
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const material = new THREE.LineBasicMaterial({
        color: rgbToThree(orbit.color),
        transparent: true,
        opacity: 1,
      });
      entry.root.add(new THREE.Line(geometry, material));
      entry.segmentSignature = signature;
    }
  }

  private updateArrow(arrow: SceneArrow): void {
    this.arrowFrames.set(arrow.name, {
      base: new THREE.Vector3(...arrow.base),
      direction: new THREE.Vector3(...arrow.direction).normalize(),
      color: arrow.color,
      distanceAnchor: arrow.distance_anchor,
      displayLengthAu: -1,
      displayGapAu: -1,
    });
  }

  private removePathsExcept(names: string[]): void {
    const keep = new Set(names);
    for (const name of this.paths.keys()) {
      if (keep.has(name)) {
        continue;
      }
      const existing = this.paths.get(name);
      if (existing) {
        existing.root.parent?.remove(existing.root);
        existing.root.traverse((object) => {
          if (object instanceof THREE.Line) {
            object.geometry.dispose();
            (object.material as THREE.Material).dispose();
          }
        });
      }
      this.paths.delete(name);
    }
  }

  private removeArrowsExcept(names: string[]): void {
    const keep = new Set(names);
    for (const name of this.arrowFrames.keys()) {
      if (keep.has(name)) {
        continue;
      }
      this.arrowFrames.delete(name);
      const existing = this.arrows.get(name);
      if (!existing) {
        continue;
      }
      this.contentRoot.remove(existing);
      disposeFlatArrowGroup(existing);
      this.arrows.delete(name);
    }
  }

  private arrowDisplayLengthAu(cameraDistanceAu: number): number {
    return cameraDistanceAu * this.arrowLengthCameraFraction * ARROW_LENGTH_BOOST;
  }

  private arrowShaftStartAu(frame: ArrowFrame, cameraDistanceAu: number): number {
    if (frame.distanceAnchor !== "observer") {
      return 0;
    }
    const observer = this.bodies.get("observer");
    if (!observer || observer.radius <= 0) {
      return 0;
    }
    return observerArrowShaftStartAu(observer.radius, cameraDistanceAu, this.defaultCameraDistance);
  }

  private arrowWorldOrigin(frame: ArrowFrame, shaftStartAu: number): THREE.Vector3 {
    if (frame.distanceAnchor === "observer") {
      return this.observerPosition.clone().addScaledVector(frame.direction, shaftStartAu);
    }
    return frame.base.clone();
  }

  private layoutArrows(): void {
    if (this.arrowMeshLengthAu <= 0) {
      return;
    }
    for (const [name, frame] of this.arrowFrames) {
      const cameraDistance = cameraDistanceForArrow(
        this.camera,
        this.controls.target,
        frame.distanceAnchor,
        this.bodies.get("galactic_center")?.root ?? null,
      );
      const shaftStartAu = this.arrowShaftStartAu(frame, cameraDistance);
      const origin = this.arrowWorldOrigin(frame, shaftStartAu);
      const displayLength = this.arrowDisplayLengthAu(cameraDistance);
      const lengthDelta = Math.abs(displayLength - frame.displayLengthAu);
      const gapDelta = Math.abs(shaftStartAu - frame.displayGapAu);
      const rebuildLength = lengthDelta > frame.displayLengthAu * 0.02 || lengthDelta > this.arrowMeshLengthAu * 0.02;
      const repositionGap = gapDelta > Math.max(frame.displayGapAu * 0.02, this.arrowEarthRadiusAu * 1e-4);
      let arrow = this.arrows.get(name);
      if (!rebuildLength && !repositionGap && arrow) {
        orientFlatArrow(arrow, origin, frame.direction, this.camera);
        continue;
      }
      frame.displayLengthAu = displayLength;
      frame.displayGapAu = shaftStartAu;

      if (rebuildLength || !arrow) {
        if (arrow) {
          this.contentRoot.remove(arrow);
          disposeFlatArrowGroup(arrow);
        }

        const sizeScale = displayLength / this.arrowMeshLengthAu;
        const headLength = displayLength * ARROW_HEAD_LENGTH_FRACTION;
        const headWidth = ARROW_HEAD_WIDTH_EARTH_RADII * this.arrowEarthRadiusAu * sizeScale;
        const shaftWidth = ARROW_SHAFT_WIDTH_EARTH_RADII * this.arrowEarthRadiusAu * sizeScale;
        arrow = createFlatArrowGroup(
          displayLength,
          rgbToThree(frame.color),
          headLength,
          headWidth,
          shaftWidth,
          FLAT_ARROW_MATERIAL_OPTIONS,
        );
        this.contentRoot.add(arrow);
        this.arrows.set(name, arrow);
      }
      orientFlatArrow(arrow, origin, frame.direction, this.camera);
    }
    this.syncArrowVisibility();
    this.syncOutlineSelection();
  }

  private syncArrowVisibility(): void {
    const activePointing = this.pointingTarget ? pointingArrowName(this.pointingTarget) : "";
    for (const [name, group] of this.arrows) {
      if (name === "cmb_dipole_arrow") {
        group.visible = this.pointingTarget === "cmb_dipole";
      } else if (isPointingArrowName(name)) {
        group.visible = name === activePointing;
      } else {
        group.visible = true;
      }
    }
  }

  private syncOutlineSelection(): void {
    this.outlinePipeline?.syncArrowOutline(this.arrows.values(), this.bodies);
    this.outlinePipeline?.syncBodyOutline(this.bodies);
  }

  private syncOrbitPivot(): void {
    const entry = this.bodies.get("observer");
    if (!entry) {
      return;
    }
    this.observerPosition.setFromMatrixPosition(entry.root.matrix);
    this.syncFloatingOrigin();
  }

  private syncFloatingOrigin(): void {
    this.contentRoot.position.copy(this.observerPosition).negate();
    this.contentRoot.updateMatrixWorld(true);
  }

  private clampCameraDistance(): void {
    const maxDistance = this.controls.maxDistance;
    if (!Number.isFinite(maxDistance) || maxDistance <= 0) {
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = offset.length();
    if (distance <= maxDistance) {
      return;
    }
    offset.multiplyScalar(maxDistance / distance);
    this.camera.position.copy(this.controls.target).add(offset);
  }

  private syncClipPlanes(): void {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const far = distance + this.sceneScale * 2;
    const near = Math.max(this.earthRadiusAu * 0.01, far / 5e7, 1e-5);
    this.camera.near = near;
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    this.constellationSky.setRadius(this.constellationSky.radiusForCameraFar(far));
    this.updateSkyOpacity();
  }

  private updateSkyOpacity(): void {
    const cameraDistance = this.camera.position.distanceTo(this.controls.target);
    const opacity = skyOpacityForCameraDistance(
      cameraDistance,
      this.earthOrbitRadiusAu,
      this.skyboxFadeOrbitMultiple,
      this.skyboxFadeSpanOrbitMultiple,
    );
    this.skyOpacity = opacity;
    this.constellationSky.setOpacity(opacity);
  }

  private updateLabels(): void {
    this.scene.updateMatrixWorld(true);
    _cameraScreenDown.set(0, -1, 0).applyQuaternion(this.camera.quaternion);
    const hideWhenBehind = (label: CSS2DObject, visibleOpacity = 1): void => {
      const world = new THREE.Vector3();
      label.getWorldPosition(world);
      const projected = world.clone().project(this.camera);
      const behind = projected.z < -1 || projected.z > 1;
      label.element.style.opacity = behind ? "0" : String(visibleOpacity);
    };
    const bodyWorldPosition = (name: string): THREE.Vector3 | null => {
      const bodyEntry = this.bodies.get(name);
      if (!bodyEntry) {
        return null;
      }
      bodyEntry.root.getWorldPosition(_labelWorldAnchor);
      return _labelWorldAnchor;
    };
    for (const entry of this.bodies.values()) {
      const label = entry.label;
      if (!label) {
        continue;
      }
      entry.root.getWorldPosition(_labelWorldCenter);
      let labelOpacity = 1;
      const bodyName = entry.root.name;
      if (bodyName !== "earth" && this.sceneSnapshot) {
        const orbitRadius = heavenlyBodyOrbitRadiusAu(bodyName, this.sceneSnapshot, bodyWorldPosition);
        if (orbitRadius !== null && orbitRadius > 0) {
          const cameraDistance = this.camera.position.distanceTo(_labelWorldCenter);
          labelOpacity = skyOpacityForCameraDistance(
            cameraDistance,
            orbitRadius,
            this.skyboxFadeOrbitMultiple,
            this.skyboxFadeSpanOrbitMultiple,
          );
        }
      }
      _labelWorldAnchor
        .copy(_labelWorldCenter)
        .addScaledVector(_cameraScreenDown, entry.radius * LABEL_OFFSET_BODY_RADII);
      entry.root.worldToLocal(_labelWorldAnchor);
      label.position.copy(_labelWorldAnchor);
      hideWhenBehind(label, labelOpacity);
    }
    for (const label of this.constellationSky.labels) {
      hideWhenBehind(label, this.skyOpacity);
    }
  }

  private onResize = (): void => {
    const width = this.canvasHost.clientWidth;
    const height = this.canvasHost.clientHeight;
    if (width <= 0 || height <= 0) {
      return;
    }
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.outlinePipeline?.setSize(
      Math.max(1, Math.floor(width * this.renderer.getPixelRatio())),
      Math.max(1, Math.floor(height * this.renderer.getPixelRatio())),
    );
    this.labelRenderer.setSize(width, height);

    if (this.camera.position.lengthSq() < 1e-12) {
      this.camera.position.set(0, 0, this.defaultCameraDistance || 1);
      this.controls.update();
    }
  };

  private renderIntervalMs(now: number): number {
    if (now < this.cameraMotionUntil || now < this.cameraOrbitTweenUntil) {
      return VIEWER_FRAME_MS;
    }
    return this.geometryPollIntervalMs;
  }

  private animate = (): void => {
    this.animationId = requestAnimationFrame(this.animate);
    updateCameraTargetTweens(performance.now());
    if (!cameraOrbitTweenActive()) {
      this.controls.update();
    }
    this.updateLabels();
    this.labelRenderer.render(this.scene, this.camera);
    const now = performance.now();
    if (now - this.lastRenderTime < this.renderIntervalMs(now)) {
      return;
    }
    this.lastRenderTime = now;
    if (!this.renderReady || this.outlinePipeline === null) {
      return;
    }
    this.syncFloatingOrigin();
    this.updateParametricOrbitGeometry(this.currentSimulationTimeMs());
    this.layoutArrows();
    this.syncClipPlanes();
    this.outlinePipeline.prepareFrame();
    this.outlinePipeline.renderPipeline.render();
    this.updateFps();
  };

  private updateFps(): void {
    this.fpsFrames += 1;
    const elapsed = performance.now() - this.fpsIntervalStart;
    if (elapsed < 1000) {
      return;
    }
    this.fpsDisplay = (this.fpsFrames * 1000) / elapsed;
    this.fpsFrames = 0;
    this.fpsIntervalStart = performance.now();
    this.fpsEl.textContent = `${this.fpsDisplay.toFixed(0)} FPS`;
  }

  resetCamera(): void {
    const distance = this.defaultCameraDistance || 1;
    this.defaultCameraOffset.set(0, 0, distance);
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(this.defaultCameraOffset);
    this.controls.update();
  }

  private bodyWorldPosition(name: string): THREE.Vector3 | null {
    const entry = this.bodies.get(name);
    if (!entry) {
      return null;
    }
    return new THREE.Vector3().setFromMatrixPosition(entry.root.matrix);
  }

  private animateCameraForPointingTarget(snapshot: SceneSnapshot): void {
    this.cameraOrbitTween?.stop();
    this.cameraOrbitTween = null;

    const currentOffset = this.camera.position.clone();
    const currentOffsetDirection =
      currentOffset.lengthSq() > 1e-20
        ? currentOffset.clone().normalize()
        : this.defaultCameraOffset.clone().normalize();
    const startPose = cameraPoseFromState(this.camera, _orbitPivot);
    const endPose = desiredOrbitTargetCameraPose(
      this.camera,
      snapshot,
      this.pointingTarget,
      this.observerPosition,
      (name) => this.bodyWorldPosition(name),
      currentOffsetDirection,
      this.controls.maxDistance,
    );
    this.cameraOrbitTweenUntil = performance.now() + 1200;
    this.cameraOrbitTween = tweenCameraToOrbitPose(this.camera, this.controls, _orbitPivot, startPose, endPose, () => {
      this.cameraMotionUntil = performance.now() + 250;
      this.clampCameraDistance();
      this.syncClipPlanes();
      this.layoutArrows();
    });
  }
}
