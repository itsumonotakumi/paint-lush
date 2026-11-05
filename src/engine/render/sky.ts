import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
} from 'three';
import type { RenderModule, RenderModuleDeps } from './module';
import { PALETTE } from './palette';

/** Radius of the enclosing sky dome, in metres. */
export const SKY_RADIUS = 200;
/** Height where the horizon glow has fully blended into the pink mid sky. */
export const SKY_MID_HEIGHT = 60;
/** Height of the deepest blue-violet band. */
export const SKY_ZENITH_HEIGHT = 200;
/** Visible radius of the sun disc, in metres. */
export const SUN_RADIUS = 6;
/** How far along the sun direction the disc sits, still inside the dome. */
export const SUN_DISTANCE = 150;
/** Direction the low evening sun hangs in, matching the warm key light. */
export const SUN_DIRECTION = { x: -60, y: 18, z: -120 } as const;

const ZENITH = new Color(PALETTE.skyZenith);
const MID = new Color(PALETTE.skyMid);
const HORIZON = new Color(PALETTE.skyHorizon);

/**
 * Colour of the dome at one vertex height: warm horizon at ground level,
 * pink halfway up, deep violet at the top. Everything below the horizon keeps
 * the horizon colour so the lower half never turns dark.
 */
function colorAtHeight(y: number, out: Color): Color {
  if (!Number.isFinite(y) || y <= 0) return out.copy(HORIZON);
  if (y < SKY_MID_HEIGHT) {
    return out.lerpColors(HORIZON, MID, y / SKY_MID_HEIGHT);
  }
  if (y < SKY_ZENITH_HEIGHT) {
    return out.lerpColors(
      MID,
      ZENITH,
      (y - SKY_MID_HEIGHT) / (SKY_ZENITH_HEIGHT - SKY_MID_HEIGHT),
    );
  }
  return out.copy(ZENITH);
}

/** Vertex colours for the dome, written into a fresh attribute. */
function buildSkyColors(geometry: BufferGeometry): BufferAttribute {
  const position = geometry.getAttribute('position');
  const count = position.count;
  const colors = new Float32Array(count * 3);
  const scratch = new Color();

  for (let i = 0; i < count; i += 1) {
    colorAtHeight(position.getY(i), scratch);
    colors[i * 3] = scratch.r;
    colors[i * 3 + 1] = scratch.g;
    colors[i * 3 + 2] = scratch.b;
  }

  return new BufferAttribute(colors, 3);
}

/**
 * Builds the sunset dome and its flat sun disc. The dome is unlit and never
 * writes depth, so it always sits behind the town; the disc stays crisp and
 * is not affected by tone mapping.
 */
export function createSky(deps: RenderModuleDeps): RenderModule {
  const { scene } = deps;

  const domeGeometry = new SphereGeometry(SKY_RADIUS, 32, 20);
  domeGeometry.setAttribute('color', buildSkyColors(domeGeometry));

  const domeMaterial = new MeshBasicMaterial({
    vertexColors: true,
    side: BackSide,
    depthWrite: false,
    depthTest: false,
    toneMapped: false,
  });

  const dome = new Mesh(domeGeometry, domeMaterial);
  dome.renderOrder = -1;
  dome.frustumCulled = false;

  const sunGeometry = new SphereGeometry(SUN_RADIUS, 20, 14);
  const sunMaterial = new MeshBasicMaterial({
    color: PALETTE.sun,
    depthWrite: false,
    toneMapped: false,
  });

  const sun = new Mesh(sunGeometry, sunMaterial);
  const direction = new Vector3(
    SUN_DIRECTION.x,
    SUN_DIRECTION.y,
    SUN_DIRECTION.z,
  ).normalize();
  sun.position.copy(direction).multiplyScalar(SUN_DISTANCE);

  scene.add(dome, sun);
  scene.background = new Color(PALETTE.skyHorizon);

  let disposed = false;

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    scene.remove(dome, sun);
    domeGeometry.dispose();
    domeMaterial.dispose();
    sunGeometry.dispose();
    sunMaterial.dispose();
    scene.background = null;
  }

  return {
    update: () => undefined,
    dispose,
  };
}
