import * as THREE from "three";

/** Glow disc diameter in multiples of the sun mesh radius. */
const GLOW_DIAMETER_SUN_RADII = 16;
/** Billboard plane sits just outside the lit sphere facing the camera. */
export const SUN_GLOW_PLANE_OFFSET_SUN_RADII = 1.06;
const GLOW_TEXTURE_SIZE = 128;

const _sunWorld = new THREE.Vector3();
const _toCamera = new THREE.Vector3();
const _planeCenterWorld = new THREE.Vector3();
const _planeCenterLocal = new THREE.Vector3();

let sharedGlowTexture: THREE.CanvasTexture | null = null;

function sunGlowTexture(): THREE.CanvasTexture {
  if (sharedGlowTexture) {
    return sharedGlowTexture;
  }
  const canvas = document.createElement("canvas");
  canvas.width = GLOW_TEXTURE_SIZE;
  canvas.height = GLOW_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2d canvas context required for sun glow texture");
  }
  const center = GLOW_TEXTURE_SIZE / 2;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, center);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0)");
  gradient.addColorStop(0.18, "rgba(255, 245, 210, 0.85)");
  gradient.addColorStop(0.35, "rgba(255, 200, 80, 0.45)");
  gradient.addColorStop(0.62, "rgba(255, 140, 40, 0.12)");
  gradient.addColorStop(1, "rgba(255, 100, 20, 0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GLOW_TEXTURE_SIZE, GLOW_TEXTURE_SIZE);
  sharedGlowTexture = new THREE.CanvasTexture(canvas);
  sharedGlowTexture.needsUpdate = true;
  return sharedGlowTexture;
}

export function sunGlowDiameterAu(sunRadiusAu: number): number {
  return sunRadiusAu * GLOW_DIAMETER_SUN_RADII;
}

export function createSunGlowSprite(sunRadiusAu: number): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: sunGlowTexture(),
    color: new THREE.Color(1, 0.9, 0.55),
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    alphaTest: 0.04,
  });
  const sprite = new THREE.Sprite(material);
  sprite.userData.sunGlow = true;
  sprite.frustumCulled = false;
  sprite.renderOrder = 2;
  const diameter = sunGlowDiameterAu(sunRadiusAu);
  sprite.scale.set(diameter, diameter, 1);
  return sprite;
}

export function disposeSunGlowSprite(sprite: THREE.Sprite): void {
  (sprite.material as THREE.SpriteMaterial).dispose();
}

/** Slide the billboard to the sun limb toward the camera so the quad does not cut through the mesh. */
export function layoutSunGlow(
  sprite: THREE.Sprite,
  sunRoot: THREE.Object3D,
  sunRadiusAu: number,
  camera: THREE.Camera,
): void {
  sunRoot.updateMatrixWorld(true);
  sunRoot.getWorldPosition(_sunWorld);
  _toCamera.subVectors(camera.position, _sunWorld);
  if (_toCamera.lengthSq() < 1e-20) {
    sprite.position.set(0, 0, 0);
    return;
  }
  _toCamera.normalize();
  _planeCenterWorld.copy(_sunWorld).addScaledVector(_toCamera, sunRadiusAu * SUN_GLOW_PLANE_OFFSET_SUN_RADII);
  sunRoot.worldToLocal(_planeCenterLocal.copy(_planeCenterWorld));
  sprite.position.copy(_planeCenterLocal);
}
