import {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  HemisphereLight,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  PerspectiveCamera,
  RGFormat,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material } from 'three';
import type { GameEvent } from '../../core/events';
import { lerpAngle } from '../../core/math/vec3';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import type { EntityId, SurfaceId, Vec3 } from '../../core/types';
import { FIXED_DT } from '../../core/types';
import type { ICollision, IPaintGrid, SurfaceGrid } from '../../game/contracts';
import type { StageData } from '../../game/data/schemas';
import type { IRenderer } from '../ports';
import { createBombs } from './bombs';
import { CAMERA_FOV, computeCamera, PRE_SWEEP_SECONDS, preCamera, preCameraBlend } from './camera';
import type { CameraOutput } from './camera';
import { coverageByteLength, updateCoverage } from './coverage';
import { createDecor } from './decor';
import { DirtyUploadQueue, MAX_TEXTURE_UPLOADS_PER_FRAME } from './dirtyQueue';
import { createEffects } from './effects';
import { buildStaticFaces, buildSurfaceQuad } from './geometry';
import { INK_FRAGMENT_SHADER, INK_VERTEX_SHADER, inkUniforms } from './inkShader';
import type { EffectsModule, RenderModule, RenderModuleDeps } from './module';
import { createNinjas } from './ninja';
import { PALETTE } from './palette';
import { resolveQuality } from './quality';
import type { RenderQuality } from './quality';
import { createSky } from './sky';
import { boxTop, surfaceBase } from './stageColors';
import { createToonGradient } from './toon';

/** Number of projectile instances the renderer can display at once. */
const PROJECTILE_CAPACITY = 256;
/** Largest allowed drawing-buffer width or height, in device pixels. */
const MAX_RENDER_DIMENSION = 4096;
/** Largest allowed drawing-buffer area, in device pixels. */
const MAX_RENDER_PIXELS = 16_000_000;
/** Players or camera targets moving farther than this between ticks snap instead of sliding. */
const TELEPORT_DISTANCE_SQUARED = 9;
/** Upper bound for one visual frame, so a stalled tab does not fast-forward effects. */
const MAX_FRAME_SECONDS = 0.1;
/** The camera far plane clears the sky dome with room to spare. */
const CAMERA_FAR = 400;
/** Warm key light direction, shared by the lights and the painted wall shader. */
const SUN_POSITION = { x: 6, y: 14, z: 8 } as const;

interface SurfaceVisual {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  texture: DataTexture;
  /** RG coverage bytes uploaded to `texture`, rebuilt from the paint grid. */
  coverage: Uint8Array;
  /** Simulation-side source of truth; only ever read here. */
  surface: SurfaceGrid;
}

function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

function finiteSum(base: number, offset: number): number {
  const sum = base + offset;
  return Number.isFinite(sum) ? sum : base;
}

function toColor(hex: number): Color {
  return new Color(Number.isFinite(hex) ? hex : 0xffffff);
}

/** Palette hex to a linear-space Vec3, matching the ink shader's uniform inputs. */
function toLinearVector(hex: number): Vector3 {
  const color = toColor(hex);
  return new Vector3(color.r, color.g, color.b);
}

/** Phone profile: a touch device with four or fewer logical cores. */
function detectLowDetail(): boolean {
  if (typeof navigator === 'undefined') return false;
  const touchPoints = navigator.maxTouchPoints;
  const cores = navigator.hardwareConcurrency;
  return Number.isFinite(touchPoints) && touchPoints > 0 && Number.isFinite(cores) && cores <= 4;
}

/** Resolved canvas size and the pixel ratio that keeps the buffer within limits. */
export interface RenderSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * The frame is first scaled down so neither side exceeds 4096 px, then the
 * pixel ratio is reduced until the drawing buffer (`size * pixelRatio`) stays
 * within 4096 px per axis and the caller's pixel budget (16 megapixels by
 * default). Scaling both axes by the same factor preserves the aspect ratio
 * and camera framing.
 */
export function computeRenderSize(
  width: number,
  height: number,
  pixelRatio: number,
  maxPixels = MAX_RENDER_PIXELS,
): RenderSize {
  const rawWidth = Math.max(1, Math.floor(safe(width)));
  const rawHeight = Math.max(1, Math.floor(safe(height)));
  // Scale both axes together so capping a very large frame keeps its aspect ratio.
  const sizeScale = Math.min(
    1,
    MAX_RENDER_DIMENSION / rawWidth,
    MAX_RENDER_DIMENSION / rawHeight,
  );
  const widthPx = Math.max(1, Math.floor(rawWidth * sizeScale));
  const heightPx = Math.max(1, Math.floor(rawHeight * sizeScale));

  const requested = safe(pixelRatio);
  let ratio = Math.min(3, Math.max(0.5, requested === 0 ? 1 : requested));

  const budget =
    Number.isFinite(maxPixels) && maxPixels > 0 ? maxPixels : MAX_RENDER_PIXELS;

  const dimensionCap = Math.min(
    MAX_RENDER_DIMENSION / widthPx,
    MAX_RENDER_DIMENSION / heightPx,
  );
  const pixelCap = Math.sqrt(budget / (widthPx * heightPx));
  ratio = Math.min(ratio, dimensionCap, pixelCap);
  if (!Number.isFinite(ratio) || ratio <= 0) ratio = 0.01;

  return { width: widthPx, height: heightPx, pixelRatio: ratio };
}

/** True when interpolation would slide a player across the map, e.g. after a respawn. */
function movedTooFar(from: Vec3, to: Vec3): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) return true;
  return dx * dx + dy * dy + dz * dz > TELEPORT_DISTANCE_SQUARED;
}

/** Linear lookup over the previous snapshot, avoiding a per-frame map rebuild. */
function findPreviousPlayer(
  players: readonly PlayerView[],
  id: EntityId,
): PlayerView | undefined {
  for (let i = 0; i < players.length; i += 1) {
    const player = players[i];
    if (player !== undefined && player.id === id) return player;
  }
  return undefined;
}

/** Texture dimensions derived from a paint surface, always at least one texel. */
export function paintTextureSize(surface: SurfaceGrid): [number, number] {
  return [
    Math.max(1, Math.trunc(safe(surface.w))),
    Math.max(1, Math.trunc(safe(surface.h))),
  ];
}

/** RG coverage texture plus the byte array uploaded from it. */
export interface SurfaceCoverage {
  texture: DataTexture;
  coverage: Uint8Array;
}

/**
 * Builds the RG coverage texture for one surface. The paint grid is read once
 * here to seed the mask; afterwards only a dirty surface is rebuilt.
 */
export function createSurfaceCoverage(surface: SurfaceGrid): SurfaceCoverage {
  const [width, height] = paintTextureSize(surface);
  const coverage = new Uint8Array(coverageByteLength(width * height));
  updateCoverage(surface.data, coverage);

  const texture = new DataTexture(coverage, width, height, RGFormat, UnsignedByteType);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return { texture, coverage };
}

/**
 * Re-flags every coverage texture after a WebGL context restore. three rebuilds
 * its own GL objects, but the RG pixels live in `DataTexture` CPU buffers, so
 * bumping `version` guarantees they are uploaded to the fresh context.
 * Returns how many textures were flagged.
 */
export function markCoverageForRestore(visuals: Iterable<{ texture: DataTexture }>): number {
  let count = 0;
  for (const visual of visuals) {
    visual.texture.needsUpdate = true;
    count += 1;
  }
  return count;
}

/** Minimal renderer surface needed to hand the canvas back between matches. */
export interface ReusableRenderer {
  renderLists: { dispose(): void };
  dispose(): void;
}

/**
 * Releases per-match GL state so a second match can build a new renderer over
 * the same canvas. `renderer.dispose` frees listeners, programs and caches;
 * clearing the render lists again drops any scene entries still referenced.
 */
export function releaseRendererForReuse(renderer: ReusableRenderer): void {
  renderer.dispose();
  renderer.renderLists.dispose();
}

/** A small four-pointed star with a little thickness, built without assets. */
function createStarGeometry(): BufferGeometry {
  const outer = 0.12;
  const inner = 0.045;
  const halfDepth = 0.025;
  const rim: { x: number; y: number }[] = [];

  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2;
    const radius = i % 2 === 0 ? outer : inner;
    rim.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }

  const positions: number[] = [];
  const normals: number[] = [];

  const pushTriangle = (
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    cx: number,
    cy: number,
    cz: number,
  ): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);

    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cx - ax;
    const vy = cy - ay;
    const vz = cz - az;
    let nx = safe(uy * vz - uz * vy);
    let ny = safe(uz * vx - ux * vz);
    let nz = safe(ux * vy - uy * vx);
    const len = Math.hypot(nx, ny, nz);
    if (len > 0 && Number.isFinite(len)) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 0;
      nz = 1;
    }
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };

  for (let i = 0; i < 8; i += 1) {
    const p = rim[i];
    const q = rim[(i + 1) % 8];
    if (!p || !q) continue;

    pushTriangle(0, 0, halfDepth, p.x, p.y, halfDepth, q.x, q.y, halfDepth);
    pushTriangle(0, 0, -halfDepth, q.x, q.y, -halfDepth, p.x, p.y, -halfDepth);
    pushTriangle(p.x, p.y, halfDepth, q.x, q.y, halfDepth, q.x, q.y, -halfDepth);
    pushTriangle(p.x, p.y, halfDepth, q.x, q.y, -halfDepth, p.x, p.y, -halfDepth);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  return geometry;
}

export interface ThreeRendererDeps {
  canvas: HTMLCanvasElement;
  stage: StageData;
  paint: IPaintGrid;
  collision: ICollision;
  teamColors: [number, number];
  localPlayerId: number;
  /** Parsed decoration file for this stage. Validated by createDecor. */
  decor: unknown;
  /** Requested visual quality; 'auto' keeps the touch-device rule. */
  quality: RenderQuality;
}

export function createThreeRenderer(deps: ThreeRendererDeps): IRenderer {
  const { canvas, stage, paint, collision, teamColors, localPlayerId, quality } = deps;
  const profile = resolveQuality(quality, detectLowDetail());
  const lowDetail = profile.lowDetail;
  const pixelRatioCap = profile.pixelRatio;
  const maxPixels = profile.maxPixels;

  const renderer = new WebGLRenderer({
    canvas,
    antialias: !lowDetail,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(PALETTE.skyHorizon, 1);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(1, 1, false);

  const handleContextLost = (event: Event): void => {
    event.preventDefault();
  };
  /**
   * three rebuilds its GL objects on restore; the CPU-backed coverage textures
   * must be flagged for upload and the frame clock reset so the first restored
   * frame does not inherit a long stale delta.
   */
  const handleContextRestored = (): void => {
    lastFrameMs = -1;
    markCoverageForRestore(surfaceVisuals.values());
  };
  canvas.addEventListener('webglcontextlost', handleContextLost, false);
  canvas.addEventListener('webglcontextrestored', handleContextRestored, false);

  const scene = new Scene();

  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.05, CAMERA_FAR);
  camera.position.set(0, 10, 14);
  camera.lookAt(0, 0, 0);

  const gradient = createToonGradient();

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: DataTexture[] = [];

  const trackGeometry = <T extends BufferGeometry>(geometry: T): T => {
    geometries.push(geometry);
    return geometry;
  };
  const trackMaterial = <T extends Material>(material: T): T => {
    materials.push(material);
    return material;
  };
  const trackTexture = <T extends DataTexture>(texture: T): T => {
    textures.push(texture);
    return texture;
  };

  /* ---------- lighting ---------- */

  const ambient = new AmbientLight(0xffe1c8, 1.2);
  const hemisphere = new HemisphereLight(0x9fb8ff, 0xffd2a8, 0.8);
  const sunLight = new DirectionalLight(0xfff1d6, 2.2);
  sunLight.position.set(SUN_POSITION.x, SUN_POSITION.y, SUN_POSITION.z);
  scene.add(ambient, hemisphere, sunLight);

  /* ---------- paintable surfaces ---------- */

  const teamA = toLinearVector(teamColors[0]);
  const teamB = toLinearVector(teamColors[1]);
  const lightDirection = new Vector3(
    SUN_POSITION.x,
    SUN_POSITION.y,
    SUN_POSITION.z,
  ).normalize();

  const surfaceVisuals = new Map<SurfaceId, SurfaceVisual>();

  const addSurface = (surface: SurfaceGrid): void => {
    const [texWidth, texHeight] = paintTextureSize(surface);
    const { texture, coverage } = createSurfaceCoverage(surface);
    trackTexture(texture);

    const stageBox = stage.boxes[surface.boxIndex];
    const top = stageBox
      ? boxTop(stageBox.box)
      : { x: 0, z: 0, y: 0, width: 0, depth: 0 };
    const base = toLinearVector(surfaceBase(surface.boxIndex, surface.face, top, stage.id));

    const material = trackMaterial(
      new ShaderMaterial({
        glslVersion: GLSL3,
        uniforms: {
          ...inkUniforms({
            texture,
            width: texWidth,
            height: texHeight,
            uLength: surface.uLength,
            vLength: surface.vLength,
            teamA,
            teamB,
            base,
            lightDir: lightDirection,
            axisU: surface.axisU,
            axisV: surface.axisV,
          }),
        },
        vertexShader: INK_VERTEX_SHADER,
        fragmentShader: INK_FRAGMENT_SHADER,
      }),
    );

    const quad = buildSurfaceQuad(surface);
    const geometry = trackGeometry(new BufferGeometry());
    geometry.setAttribute('position', new BufferAttribute(quad.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(quad.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(quad.uvs, 2));

    const mesh = new Mesh(geometry, material);
    scene.add(mesh);
    surfaceVisuals.set(surface.id, { mesh, texture, coverage, surface });
  };

  for (const surface of paint.surfaces) addSurface(surface);

  /* ---------- static, unpaintable faces ---------- */

  const staticBatch = buildStaticFaces(stage, paint);
  if (staticBatch.vertexCount > 0) {
    const geometry = trackGeometry(new BufferGeometry());
    geometry.setAttribute('position', new BufferAttribute(staticBatch.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(staticBatch.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(staticBatch.colors, 3));

    const material = trackMaterial(
      new MeshToonMaterial({ vertexColors: true, gradientMap: gradient }),
    );
    scene.add(new Mesh(geometry, material));
  }

  /* ---------- modules: sky, town, ninjas, effects ---------- */

  const moduleDeps: RenderModuleDeps = {
    scene,
    teamColors,
    gradient,
    localPlayerId,
    lowDetail,
  };

  const effects: EffectsModule = createEffects(moduleDeps);
  const modules: RenderModule[] = [
    createSky(moduleDeps),
    createDecor({ ...moduleDeps, stage, decor: deps.decor }),
    createNinjas(moduleDeps),
    createBombs(moduleDeps),
    effects,
  ];

  /* ---------- projectiles ---------- */

  const starGeometry = trackGeometry(createStarGeometry());
  const starMaterial = trackMaterial(
    new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, toneMapped: false }),
  );
  const projectiles = new InstancedMesh(starGeometry, starMaterial, PROJECTILE_CAPACITY);
  projectiles.instanceMatrix.setUsage(DynamicDrawUsage);
  projectiles.frustumCulled = false;
  projectiles.count = 0;
  scene.add(projectiles);

  const projectileColors: [Color, Color] = [toColor(teamColors[0]), toColor(teamColors[1])];

  /* ---------- per-frame scratch state ---------- */

  const scratchMatrix = new Matrix4();
  const shakeOffset = { x: 0, y: 0, z: 0 };
  const dirtyQueue = new DirtyUploadQueue();
  const dirtyBatch: SurfaceId[] = [];
  const cameraView: PlayerView = {
    id: 0,
    team: 0,
    state: 'stance',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 0,
    ink: 0,
    weaponId: '',
    gauge: 0,
    specialActive: false,
    charge: 0,
    kills: 0,
  };
  const cameraOut: CameraOutput = {
    position: { x: 0, y: 0, z: 0 },
    lookTarget: { x: 0, y: 0, z: 0 },
    fov: CAMERA_FOV,
  };
  const preCameraOut: CameraOutput = {
    position: { x: 0, y: 0, z: 0 },
    lookTarget: { x: 0, y: 0, z: 0 },
    fov: CAMERA_FOV,
  };

  const raycast: ICollision['raycast'] = (origin, dir, maxDist) =>
    collision.raycast(origin, dir, maxDist);

  const minX = Math.min(safe(stage.bounds.min.x), safe(stage.bounds.max.x));
  const maxX = Math.max(safe(stage.bounds.min.x), safe(stage.bounds.max.x));
  const minY = Math.min(safe(stage.bounds.min.y), safe(stage.bounds.max.y));
  const maxY = Math.max(safe(stage.bounds.min.y), safe(stage.bounds.max.y));
  const minZ = Math.min(safe(stage.bounds.min.z), safe(stage.bounds.max.z));
  const maxZ = Math.max(safe(stage.bounds.min.z), safe(stage.bounds.max.z));
  const height = safe(maxY - minY);
  const depth = safe(maxZ - minZ);
  const centerX = safe((minX + maxX) * 0.5);
  const centerY = safe((minY + maxY) * 0.5);
  const centerZ = safe((minZ + maxZ) * 0.5);

  const overview = {
    x: centerX,
    y: safe(maxY + Math.max(6, height * 0.6)),
    z: safe(maxZ + Math.max(8, depth * 0.5)),
    targetX: centerX,
    targetY: centerY,
    targetZ: centerZ,
  };

  let disposed = false;
  let lastFrameMs = -1;

  /** Seconds since the previous visual frame, clamped so a stalled tab cannot skip effects. */
  function frameSeconds(): number {
    const now = performance.now();
    const previous = lastFrameMs;
    lastFrameMs = now;
    if (!Number.isFinite(now) || previous < 0 || !Number.isFinite(previous)) return 0;
    const dt = (now - previous) / 1000;
    if (!Number.isFinite(dt)) return 0;
    return Math.min(MAX_FRAME_SECONDS, Math.max(0, dt));
  }

  function resize(w: number, h: number, pixelRatio: number): void {
    const size = computeRenderSize(
      w,
      h,
      Math.min(safe(pixelRatio), pixelRatioCap),
      maxPixels,
    );
    renderer.setPixelRatio(size.pixelRatio);
    renderer.setSize(size.width, size.height, false);
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
  }

  function render(prev: WorldSnapshot, curr: WorldSnapshot, alpha: number, cameraPlayerId: number): void {
    const dtSec = frameSeconds();

    const dirty = paint.takeDirty();
    dirtyQueue.enqueue(dirty);
    const uploads = dirtyQueue.drain(MAX_TEXTURE_UPLOADS_PER_FRAME, dirtyBatch);
    for (let i = 0; i < uploads; i += 1) {
      const id = dirtyBatch[i];
      if (id === undefined) continue;
      const visual = surfaceVisuals.get(id);
      if (visual) {
        updateCoverage(visual.surface.data, visual.coverage);
        visual.texture.needsUpdate = true;
      }
    }

    for (let i = 0; i < modules.length; i += 1) {
      const module = modules[i];
      if (module !== undefined) module.update(dtSec, prev, curr, alpha);
    }

    let target: PlayerView | undefined;
    for (let i = 0; i < curr.players.length; i += 1) {
      const player = curr.players[i];
      if (player !== undefined && player.id === cameraPlayerId) {
        target = player;
        break;
      }
    }
    if (!target) target = curr.players[0];

    let lookX = overview.targetX;
    let lookY = overview.targetY;
    let lookZ = overview.targetZ;

    if (target) {
      const previous = findPreviousPlayer(prev.players, target.id);
      cameraView.id = target.id;
      cameraView.team = target.team;
      cameraView.state = target.state;
      cameraView.hp = target.hp;
      cameraView.ink = target.ink;

      if (previous && !movedTooFar(previous.pos, target.pos)) {
        cameraView.pos.x = safe(previous.pos.x + (target.pos.x - previous.pos.x) * alpha);
        cameraView.pos.y = safe(previous.pos.y + (target.pos.y - previous.pos.y) * alpha);
        cameraView.pos.z = safe(previous.pos.z + (target.pos.z - previous.pos.z) * alpha);
        cameraView.yaw = lerpAngle(previous.yaw, target.yaw, alpha);
        cameraView.pitch = lerpAngle(previous.pitch, target.pitch, alpha);
      } else {
        cameraView.pos.x = safe(target.pos.x);
        cameraView.pos.y = safe(target.pos.y);
        cameraView.pos.z = safe(target.pos.z);
        cameraView.yaw = safe(target.yaw);
        cameraView.pitch = safe(target.pitch);
      }

      computeCamera(cameraView, raycast, cameraOut);
      camera.position.set(cameraOut.position.x, cameraOut.position.y, cameraOut.position.z);
      lookX = cameraOut.lookTarget.x;
      lookY = cameraOut.lookTarget.y;
      lookZ = cameraOut.lookTarget.z;
    } else {
      camera.position.set(overview.x, overview.y, overview.z);
    }

    // Plan ch. 3 step 1: while the whistle is still upcoming, sweep the stage
    // and then ease into the player's camera over the final 0.8 s.
    if (curr.phase === 'pre' && target) {
      const blendAlpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
      const prevTick = safe(prev.tick);
      const currTick = safe(curr.tick);
      const interpolatedTick = prevTick + (currTick - prevTick) * blendAlpha;
      const timeLeftInPre = PRE_SWEEP_SECONDS - interpolatedTick * FIXED_DT;
      const blend = preCameraBlend(timeLeftInPre);

      if (blend < 1) {
        preCamera(timeLeftInPre, preCameraOut, centerX, centerY, centerZ);
        const orbit = 1 - blend;
        camera.position.set(
          preCameraOut.position.x * orbit + cameraOut.position.x * blend,
          preCameraOut.position.y * orbit + cameraOut.position.y * blend,
          preCameraOut.position.z * orbit + cameraOut.position.z * blend,
        );
        lookX = preCameraOut.lookTarget.x * orbit + lookX * blend;
        lookY = preCameraOut.lookTarget.y * orbit + lookY * blend;
        lookZ = preCameraOut.lookTarget.z * orbit + lookZ * blend;
      }
    }

    // Shake is added after computeCamera so the base framing stays untouched.
    effects.shake(shakeOffset);
    camera.position.set(
      finiteSum(camera.position.x, shakeOffset.x),
      finiteSum(camera.position.y, shakeOffset.y),
      finiteSum(camera.position.z, shakeOffset.z),
    );
    camera.lookAt(lookX, lookY, lookZ);

    const targetFov = CAMERA_FOV + effects.fovBoost();
    if (Number.isFinite(targetFov) && targetFov > 0 && targetFov !== camera.fov) {
      camera.fov = targetFov;
      camera.updateProjectionMatrix();
    }

    const camX = camera.position.x;
    const camZ = camera.position.z;
    let count = 0;
    for (let i = 0; i < curr.projectiles.length; i += 1) {
      if (count >= PROJECTILE_CAPACITY) break;
      const projectile = curr.projectiles[i];
      if (projectile === undefined) continue;

      const px = safe(projectile.pos.x);
      const py = safe(projectile.pos.y);
      const pz = safe(projectile.pos.z);
      const angle = safe(Math.atan2(camX - px, camZ - pz));

      scratchMatrix.makeRotationY(angle);
      scratchMatrix.setPosition(px, py, pz);
      projectiles.setMatrixAt(count, scratchMatrix);
      projectiles.setColorAt(count, projectile.team === 0 ? projectileColors[0] : projectileColors[1]);
      count += 1;
    }

    projectiles.count = count;
    if (count > 0) {
      projectiles.instanceMatrix.needsUpdate = true;
      if (projectiles.instanceColor) projectiles.instanceColor.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  function handle(event: GameEvent): void {
    if (disposed) return;
    for (let i = 0; i < modules.length; i += 1) {
      const module = modules[i];
      if (module !== undefined && module.handle !== undefined) module.handle(event);
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    for (const module of modules) module.dispose();
    modules.length = 0;

    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();
    gradient.dispose();

    canvas.removeEventListener('webglcontextlost', handleContextLost, false);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored, false);

    surfaceVisuals.clear();
    dirtyQueue.clear();
    scene.clear();
    releaseRendererForReuse(renderer);
  }

  resize(canvas.clientWidth, canvas.clientHeight, 1);

  return { render, handle, resize, dispose };
}
