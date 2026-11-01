/**
 * WebGPU beauty pass + body/arrow outlines (three.js OutlineNode).
 *
 * Composite: scene + bodyOutline × (1 − arrowCoverage) + arrowOutline
 *
 * Arrow vs body outlines
 * ----------------------
 * Bodies and arrows use separate OutlineNode instances. OutlineNode depth-tests
 * selected meshes only against *non-selected* scene geometry, not against each
 * other. Earth’s blurred silhouette can still land on pixels where the arrow sits
 * in front, so adding both outline colors stacks Earth halo on the arrow.
 *
 * Fix: before each frame, {@link ./arrow-coverage-mask.ts} renders the arrow
 * outline meshes (see `userData.arrowOutline` on arrows and `ARROW_OUTLINE_BODY_NAMES`) into a mask
 * with depth test off—full arrow silhouette, matching the visible + occluded
 * arrow draw strategy. That mask zeroes body outline contribution on those
 * pixels. Call `prepareFrame()` immediately before `renderPipeline.render()`.
 */
import { Color, Mesh, Object3D, type Camera, type Group, type Scene } from "three";
import type OutlineNode from "three/addons/tsl/display/OutlineNode.js";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { float, pass, uniform } from "three/tsl";
import { outline } from "three/addons/tsl/display/OutlineNode.js";
import { createArrowCoverageMask } from "./arrow-coverage-mask";

const ARROW_OUTLINE_EDGE_STRENGTH = 1;
const ARROW_OUTLINE_EDGE_THICKNESS = 0.4;

const BODY_OUTLINE_EDGE_STRENGTH = 1;
const BODY_OUTLINE_EDGE_THICKNESS = 0.4;

export const BODY_OUTLINE_NAMES = ["earth", "moon", "sun", "galactic_center"] as const;

/** Bodies outlined with arrows (same OutlineNode + coverage mask as flat arrows). */
export const ARROW_OUTLINE_BODY_NAMES = ["iss", "observer"] as const;

export type ViewerOutlinePipeline = {
  renderPipeline: RenderPipeline;
  prepareFrame: () => void;
  syncArrowOutline: (arrowGroups: Iterable<Group>, bodies: ReadonlyMap<string, { root: Object3D }>) => void;
  syncBodyOutline: (bodies: ReadonlyMap<string, { root: Object3D }>) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
};

function collectMeshesForBodyNames(bodies: ReadonlyMap<string, { root: Object3D }>, names: readonly string[]): Mesh[] {
  const next: Mesh[] = [];
  for (const name of names) {
    const entry = bodies.get(name);
    if (!entry) {
      continue;
    }
    entry.root.traverse((child) => {
      if (child instanceof Mesh) {
        next.push(child);
      }
    });
  }
  return next;
}

function collectArrowOutlineMeshes(
  arrowGroups: Iterable<Group>,
  bodies: ReadonlyMap<string, { root: Object3D }>,
): Mesh[] {
  const next: Mesh[] = [];
  for (const group of arrowGroups) {
    for (const child of group.children) {
      if (child instanceof Mesh && child.userData.arrowOutline === true) {
        next.push(child);
      }
    }
  }
  next.push(...collectMeshesForBodyNames(bodies, ARROW_OUTLINE_BODY_NAMES));
  return next;
}

function createOutlinePass(scene: Scene, camera: Camera, edgeThickness: number): OutlineNode {
  return outline(scene, camera, {
    selectedObjects: [],
    edgeThickness: float(edgeThickness),
    edgeGlow: float(0),
    downSampleRatio: 1,
  });
}

function outlineMaskForPass(outlinePass: OutlineNode) {
  return outlinePass.visibleEdge.add(outlinePass.hiddenEdge);
}

function outlineColorForPass(outlinePass: OutlineNode, edgeStrength: number) {
  const visibleEdgeColor = uniform(new Color(0xffffff));
  const strength = uniform(edgeStrength);
  return outlineMaskForPass(outlinePass).mul(visibleEdgeColor).mul(strength);
}

export function createViewerOutlinePipeline(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
): ViewerOutlinePipeline {
  const arrowOutlinePass = createOutlinePass(scene, camera, ARROW_OUTLINE_EDGE_THICKNESS);
  const bodyOutlinePass = createOutlinePass(scene, camera, BODY_OUTLINE_EDGE_THICKNESS);
  const arrowCoverageMask = createArrowCoverageMask();
  let arrowOutlineMeshes: Mesh[] = [];

  const scenePass = pass(scene, camera);
  const arrowOutline = outlineColorForPass(arrowOutlinePass, ARROW_OUTLINE_EDGE_STRENGTH);
  const bodyOutline = outlineColorForPass(bodyOutlinePass, BODY_OUTLINE_EDGE_STRENGTH);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node typing
  const arrowCoverage = arrowCoverageMask.coverageNode as any;
  const renderPipeline = new RenderPipeline(renderer);
  renderPipeline.outputNode = scenePass.add(bodyOutline.mul(arrowCoverage.oneMinus())).add(arrowOutline);
  renderPipeline.needsUpdate = true;

  const syncArrowOutline = (arrowGroups: Iterable<Group>, bodies: ReadonlyMap<string, { root: Object3D }>): void => {
    arrowOutlineMeshes = collectArrowOutlineMeshes(arrowGroups, bodies);
    arrowOutlinePass.selectedObjects = arrowOutlineMeshes;
  };

  const prepareFrame = (): void => {
    arrowCoverageMask.render(renderer, scene, camera, arrowOutlineMeshes);
  };

  const syncBodyOutline = (bodies: ReadonlyMap<string, { root: Object3D }>): void => {
    bodyOutlinePass.selectedObjects = collectMeshesForBodyNames(bodies, BODY_OUTLINE_NAMES);
  };

  return {
    renderPipeline,
    prepareFrame,
    syncArrowOutline,
    syncBodyOutline,
    setSize: (width: number, height: number) => {
      arrowOutlinePass.setSize(width, height);
      bodyOutlinePass.setSize(width, height);
      arrowCoverageMask.setSize(width, height);
    },
    dispose: () => {
      arrowOutlinePass.dispose();
      bodyOutlinePass.dispose();
      arrowCoverageMask.dispose();
      renderPipeline.dispose();
    },
  };
}
