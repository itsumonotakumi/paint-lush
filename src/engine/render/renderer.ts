import {
  AmbientLight,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  DynamicDrawUsage,
  GLSL3,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  NearestFilter,
  PerspectiveCamera,
  RedFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material } from 'three';
import { lerp, lerpAngle } from '../../core/math/vec3';
import type { PlayerView, WorldSnapshot } from '../../core/snapshot';
import type { EntityId, SurfaceId, TeamId, Vec3 } from '../../core/types';
import type { ICollision, IPaintGrid, SurfaceGrid } from '../../game/contracts';
import type { StageData } from '../../game/data/schemas';
import type { IRenderer } from '../ports';
import { CAMERA_FOV, computeCamera } from './camera';
import type { CameraOutput } from './camera';
import { buildStaticFaces, buildSurfaceQuad } from './geometry';

/** Deep night background, shared by the clear colour and scene background. */
const NIGHT = 0x06070d;
/** Number of projectile instances the renderer can display at once. */
const PROJECTILE_CAPACITY = 256;
/** Largest allowed drawing-buffer width or height, in device pixels. */
const MAX_RENDER_DIMENSION = 4096;
/** Largest allowed drawing-buffer area, in device pixels. */
const MAX_RENDER_PIXELS = 16_000_000;
/** Players or camera targets moving farther than this between ticks snap instead of sliding. */
const TELEPORT_DISTANCE_SQUARED = 9;

const SURFACE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

void main() {
  vUv = uv;
  vNormal = normalize(normal);
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPosition.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

const SURFACE_FRAGMENT_SHADER = /* glsl */ `
out vec4 fragColor;
#define gl_FragColor fragColor

uniform sampler2D uPaint;
uniform vec2 uSize;
uniform vec3 uTeamA;
uniform vec3 uTeamB;
uniform vec3 uBase;
uniform vec3 uLightDir;
uniform float uAmbient;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

float teamAt(ivec2 texel, float team) {
  float value = texelFetch(uPaint, texel, 0).r * 255.0;
  return 1.0 - step(0.5, abs(value - team));
}

void main() {
  ivec2 size = ivec2(uSize);
  ivec2 maxTexel = max(size - ivec2(1), ivec2(0));
  vec2 continuous = vUv * uSize - vec2(0.5);
  vec2 baseF = floor(continuous);
  vec2 weight = continuous - baseF;
  ivec2 baseI = clamp(ivec2(baseF), ivec2(0), maxTexel);
  ivec2 rightI = clamp(baseI + ivec2(1, 0), ivec2(0), maxTexel);
  ivec2 upI = clamp(baseI + ivec2(0, 1), ivec2(0), maxTexel);
  ivec2 diagI = clamp(baseI + ivec2(1, 1), ivec2(0), maxTexel);

  float w00 = (1.0 - weight.x) * (1.0 - weight.y);
  float w10 = weight.x * (1.0 - weight.y);
  float w01 = (1.0 - weight.x) * weight.y;
  float w11 = weight.x * weight.y;

  float covA = teamAt(baseI, 0.0) * w00 + teamAt(rightI, 0.0) * w10
             + teamAt(upI, 0.0) * w01 + teamAt(diagI, 0.0) * w11;
  float covB = teamAt(baseI, 1.0) * w00 + teamAt(rightI, 1.0) * w10
             + teamAt(upI, 1.0) * w01 + teamAt(diagI, 1.0) * w11;

  float cov = covA + covB;
  vec3 teamColor = (uTeamA * covA + uTeamB * covB) / max(cov, 0.0001);
  float painted = smoothstep(0.42, 0.58, cov);
  float rim = smoothstep(0.30, 0.48, cov) * (1.0 - smoothstep(0.52, 0.72, cov));

  vec3 baseTint = uBase * (0.94 + 0.06 * vNormal);
  vec3 surfaceColor = mix(baseTint, teamColor, painted);
  surfaceColor *= 1.0 - 0.30 * rim;

  vec3 n = normalize(vNormal);
  vec3 l = normalize(uLightDir);
  float diffuse = max(dot(n, l), 0.0);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  vec3 halfDir = normalize(l + viewDir);
  float specular = pow(max(dot(n, halfDir), 0.0), 42.0) * painted * 0.45;

  vec3 lit = surfaceColor * (uAmbient + diffuse * 0.95) + vec3(specular);
  gl_FragColor = vec4(lit, 1.0);
  #include <colorspace_fragment>
}
`;

interface SurfaceVisual {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  texture: DataTexture;
}

interface PlayerVisual {
  group: Group;
  body: Group;
  blob: Mesh;
  teamMeshes: Mesh[];
  team: TeamId;
}

function safe(n: number): number {
  return Number.isFinite(n) ? n + 0 : 0;
}

function toColor(hex: number): Color {
  return new Color(Number.isFinite(hex) ? hex : 0xffffff);
}

/** Resolved canvas size and the pixel ratio that keeps the buffer within limits. */
export interface RenderSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * The frame is first scaled down so neither side exceeds 4096 px, then the
 * pixel ratio is reduced until the drawing buffer (`size * pixelRatio`) also
 * stays within 4096 px per axis and 16 megapixels in total. Scaling both axes
 * by the same factor preserves the aspect ratio and camera framing.
 */
export function computeRenderSize(
  width: number,
  height: number,
  pixelRatio: number,
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

  const dimensionCap = Math.min(
    MAX_RENDER_DIMENSION / widthPx,
    MAX_RENDER_DIMENSION / heightPx,
  );
  const pixelCap = Math.sqrt(MAX_RENDER_PIXELS / (widthPx * heightPx));
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

/** Texture dimensions derived from a paint surface, always at least one texel. */
export function paintTextureSize(surface: SurfaceGrid): [number, number] {
  return [
    Math.max(1, Math.trunc(safe(surface.w))),
    Math.max(1, Math.trunc(safe(surface.h))),
  ];
}

/**
 * Builds the paint texture for one surface. The initial data is uploaded
 * immediately so unpainted cells (NO_TEAM) never render as team 0.
 */
export function createSurfaceTexture(surface: SurfaceGrid): DataTexture {
  const [width, height] = paintTextureSize(surface);
  const texture = new DataTexture(surface.data, width, height, RedFormat, UnsignedByteType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
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
}

export function createThreeRenderer(deps: ThreeRendererDeps): IRenderer {
  const { canvas, stage, paint, collision, teamColors } = deps;

  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(NIGHT, 1);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setPixelRatio(1);
  renderer.setSize(1, 1, false);

  const handleContextLost = (event: Event): void => {
    event.preventDefault();
  };
  canvas.addEventListener('webglcontextlost', handleContextLost, false);

  const scene = new Scene();
  scene.background = new Color(NIGHT);

  const camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.05, 400);
  camera.position.set(0, 10, 14);
  camera.lookAt(0, 0, 0);

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

  const ambient = new AmbientLight(0x5a6896, 1.35);
  const keyLight = new DirectionalLight(0xd6e2ff, 2.1);
  keyLight.position.set(9, 18, 7);
  const rimLight = new DirectionalLight(0x6a4dff, 0.7);
  rimLight.position.set(-12, 6, -10);
  scene.add(ambient, keyLight, rimLight);

  /* ---------- paintable surfaces ---------- */

  const teamA = toColor(teamColors[0]);
  const teamB = toColor(teamColors[1]);
  const baseTint = new Vector3(0.095, 0.11, 0.155);
  const lightDirection = new Vector3(0.45, 0.82, 0.36).normalize();

  const surfaceVisuals = new Map<SurfaceId, SurfaceVisual>();

  const addSurface = (surface: SurfaceGrid): void => {
    const [texWidth, texHeight] = paintTextureSize(surface);

    const texture = trackTexture(createSurfaceTexture(surface));

    const material = trackMaterial(
      new ShaderMaterial({
        glslVersion: GLSL3,
        uniforms: {
          uPaint: { value: texture },
          uSize: { value: new Vector2(texWidth, texHeight) },
          uTeamA: { value: teamA },
          uTeamB: { value: teamB },
          uBase: { value: baseTint },
          uLightDir: { value: lightDirection },
          uAmbient: { value: 0.62 },
        },
        vertexShader: SURFACE_VERTEX_SHADER,
        fragmentShader: SURFACE_FRAGMENT_SHADER,
      }),
    );

    const quad = buildSurfaceQuad(surface);
    const geometry = trackGeometry(new BufferGeometry());
    geometry.setAttribute('position', new BufferAttribute(quad.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(quad.normals, 3));
    geometry.setAttribute('uv', new BufferAttribute(quad.uvs, 2));

    const mesh = new Mesh(geometry, material);
    mesh.position.set(0, 0, 0);
    scene.add(mesh);
    surfaceVisuals.set(surface.id, { mesh, texture });
  };

  for (const surface of paint.surfaces) addSurface(surface);

  /* ---------- static, unpaintable faces ---------- */

  const staticBatch = buildStaticFaces(stage, paint);
  if (staticBatch.vertexCount > 0) {
    const geometry = trackGeometry(new BufferGeometry());
    geometry.setAttribute('position', new BufferAttribute(staticBatch.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(staticBatch.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(staticBatch.colors, 3));

    const material = trackMaterial(new MeshLambertMaterial({ vertexColors: true }));
    scene.add(new Mesh(geometry, material));
  }

  /* ---------- neon strips on the bounds ---------- */

  const minX = Math.min(safe(stage.bounds.min.x), safe(stage.bounds.max.x));
  const maxX = Math.max(safe(stage.bounds.min.x), safe(stage.bounds.max.x));
  const minY = Math.min(safe(stage.bounds.min.y), safe(stage.bounds.max.y));
  const maxY = Math.max(safe(stage.bounds.min.y), safe(stage.bounds.max.y));
  const minZ = Math.min(safe(stage.bounds.min.z), safe(stage.bounds.max.z));
  const maxZ = Math.max(safe(stage.bounds.min.z), safe(stage.bounds.max.z));
  const width = safe(maxX - minX);
  const height = safe(maxY - minY);
  const depth = safe(maxZ - minZ);
  const centerX = safe((minX + maxX) * 0.5);
  const centerY = safe((minY + maxY) * 0.5);
  const centerZ = safe((minZ + maxZ) * 0.5);

  const neonGeometry = trackGeometry(new BoxGeometry(1, 1, 1));
  const neonMaterials = [
    trackMaterial(new MeshBasicMaterial({ color: 0x2df3d2, toneMapped: false })),
    trackMaterial(new MeshBasicMaterial({ color: 0xff3fa4, toneMapped: false })),
    trackMaterial(new MeshBasicMaterial({ color: 0xffc14d, toneMapped: false })),
    trackMaterial(new MeshBasicMaterial({ color: 0x7d5cff, toneMapped: false })),
  ];

  const addStrip = (
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
    colorIndex: number,
  ): void => {
    const material = neonMaterials[colorIndex % neonMaterials.length];
    if (!material) return;
    const strip = new Mesh(neonGeometry, material);
    strip.position.set(safe(x), safe(y), safe(z));
    strip.scale.set(
      Math.max(0.02, Math.abs(safe(sx))),
      Math.max(0.02, Math.abs(safe(sy))),
      Math.max(0.02, Math.abs(safe(sz))),
    );
    scene.add(strip);
  };

  const topY = safe(maxY - 0.08);
  const inset = 0.09;
  addStrip(centerX, topY, minZ + inset, width, 0.07, 0.07, 0);
  addStrip(centerX, topY, maxZ - inset, width, 0.07, 0.07, 1);
  addStrip(minX + inset, topY, centerZ, 0.07, 0.07, depth, 2);
  addStrip(maxX - inset, topY, centerZ, 0.07, 0.07, depth, 3);

  const midY = safe(minY + height * 0.55);
  addStrip(centerX, midY, minZ + inset, width * 0.82, 0.05, 0.05, 3);
  addStrip(centerX, midY, maxZ - inset, width * 0.82, 0.05, 0.05, 0);

  const postHeight = Math.max(0.5, height * 0.35);
  const postY = safe(minY + postHeight * 0.5);
  addStrip(minX + inset, postY, minZ + inset, 0.08, postHeight, 0.08, 1);
  addStrip(maxX - inset, postY, minZ + inset, 0.08, postHeight, 0.08, 2);
  addStrip(minX + inset, postY, maxZ - inset, 0.08, postHeight, 0.08, 1);
  addStrip(maxX - inset, postY, maxZ - inset, 0.08, postHeight, 0.08, 2);

  /* ---------- procedural ninja ---------- */

  const garbMaterial = trackMaterial(new MeshLambertMaterial({ color: 0x20222e }));
  const garbDarkMaterial = trackMaterial(new MeshLambertMaterial({ color: 0x14161f }));
  const gourdMaterial = trackMaterial(new MeshLambertMaterial({ color: 0x7c5533 }));
  const teamMaterials: [MeshLambertMaterial, MeshLambertMaterial] = [
    trackMaterial(
      new MeshLambertMaterial({
        color: teamColors[0],
        emissive: toColor(teamColors[0]).multiplyScalar(0.18),
      }),
    ),
    trackMaterial(
      new MeshLambertMaterial({
        color: teamColors[1],
        emissive: toColor(teamColors[1]).multiplyScalar(0.18),
      }),
    ),
  ];

  const torsoGeometry = trackGeometry(new CapsuleGeometry(0.26, 0.5, 4, 10));
  const headGeometry = trackGeometry(new SphereGeometry(0.21, 14, 10));
  const legGeometry = trackGeometry(new BoxGeometry(0.16, 0.62, 0.2));
  const footGeometry = trackGeometry(new BoxGeometry(0.18, 0.1, 0.3));
  const armGeometry = trackGeometry(new CapsuleGeometry(0.065, 0.32, 3, 8));
  const bandGeometry = trackGeometry(new CylinderGeometry(0.218, 0.218, 0.12, 14, 1, true));
  const scarfGeometry = trackGeometry(new BoxGeometry(0.5, 0.08, 0.24));
  const gourdGeometry = trackGeometry(new SphereGeometry(0.12, 10, 8));
  const gourdNeckGeometry = trackGeometry(new CylinderGeometry(0.045, 0.055, 0.09, 8));
  const blobGeometry = trackGeometry(new SphereGeometry(0.55, 14, 8));

  const visualById = new Map<EntityId, PlayerVisual>();

  const createPlayerVisual = (team: TeamId): PlayerVisual => {
    const group = new Group();
    const body = new Group();
    group.add(body);

    const torso = new Mesh(torsoGeometry, garbMaterial);
    torso.position.set(0, 0.1, 0);
    body.add(torso);

    const head = new Mesh(headGeometry, garbDarkMaterial);
    head.position.set(0, 0.72, 0);
    body.add(head);

    const band = new Mesh(bandGeometry, teamMaterials[team]);
    band.position.set(0, 0.74, 0);
    body.add(band);

    const scarf = new Mesh(scarfGeometry, teamMaterials[team]);
    scarf.position.set(0, 0.45, 0.15);
    scarf.rotation.x = 0.35;
    body.add(scarf);

    const leftLeg = new Mesh(legGeometry, garbMaterial);
    leftLeg.position.set(-0.14, -0.55, 0);
    body.add(leftLeg);

    const rightLeg = new Mesh(legGeometry, garbMaterial);
    rightLeg.position.set(0.14, -0.55, 0);
    body.add(rightLeg);

    const leftFoot = new Mesh(footGeometry, garbDarkMaterial);
    leftFoot.position.set(-0.14, -0.87, -0.05);
    body.add(leftFoot);

    const rightFoot = new Mesh(footGeometry, garbDarkMaterial);
    rightFoot.position.set(0.14, -0.87, -0.05);
    body.add(rightFoot);

    const leftArm = new Mesh(armGeometry, garbMaterial);
    leftArm.position.set(-0.33, 0.15, 0);
    leftArm.rotation.z = -0.16;
    body.add(leftArm);

    const rightArm = new Mesh(armGeometry, garbMaterial);
    rightArm.position.set(0.33, 0.15, 0);
    rightArm.rotation.z = 0.16;
    body.add(rightArm);

    const gourd = new Mesh(gourdGeometry, gourdMaterial);
    gourd.position.set(0.29, -0.2, 0.1);
    gourd.scale.set(1, 1.15, 1);
    body.add(gourd);

    const gourdNeck = new Mesh(gourdNeckGeometry, gourdMaterial);
    gourdNeck.position.set(0.29, -0.03, 0.1);
    body.add(gourdNeck);

    const blob = new Mesh(blobGeometry, teamMaterials[team]);
    blob.position.set(0, -0.72, 0);
    blob.scale.set(1.25, 0.18, 1.25);
    blob.visible = false;
    group.add(blob);

    return {
      group,
      body,
      blob,
      teamMeshes: [band, scarf, blob],
      team,
    };
  };

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

  /* ---------- per-frame scratch state ---------- */

  const previousById = new Map<EntityId, PlayerView>();
  const seenPlayers = new Set<EntityId>();
  const scratchMatrix = new Matrix4();
  const cameraView: PlayerView = {
    id: 0,
    team: 0,
    state: 'stance',
    pos: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    hp: 0,
    ink: 0,
  };
  const cameraOut: CameraOutput = {
    position: { x: 0, y: 0, z: 0 },
    lookTarget: { x: 0, y: 0, z: 0 },
    fov: CAMERA_FOV,
  };

  const raycast: ICollision['raycast'] = (origin, dir, maxDist) =>
    collision.raycast(origin, dir, maxDist);

  const overview = {
    x: safe(centerX),
    y: safe(maxY + Math.max(6, height * 0.6)),
    z: safe(maxZ + Math.max(8, depth * 0.5)),
    targetX: centerX,
    targetY: centerY,
    targetZ: centerZ,
  };

  let disposed = false;

  function resize(w: number, h: number, pixelRatio: number): void {
    const size = computeRenderSize(w, h, pixelRatio);
    renderer.setPixelRatio(size.pixelRatio);
    renderer.setSize(size.width, size.height, false);
    camera.aspect = size.width / size.height;
    camera.updateProjectionMatrix();
  }

  function render(prev: WorldSnapshot, curr: WorldSnapshot, alpha: number, cameraPlayerId: number): void {
    const dirty = paint.takeDirty();
    for (const id of dirty) {
      const visual = surfaceVisuals.get(id);
      if (visual) visual.texture.needsUpdate = true;
    }

    previousById.clear();
    for (const player of prev.players) previousById.set(player.id, player);

    seenPlayers.clear();
    for (const player of curr.players) {
      seenPlayers.add(player.id);
      let visual = visualById.get(player.id);
      if (!visual) {
        visual = createPlayerVisual(player.team);
        visualById.set(player.id, visual);
        scene.add(visual.group);
      }

      if (visual.team !== player.team) {
        visual.team = player.team;
        for (const mesh of visual.teamMeshes) mesh.material = teamMaterials[player.team];
      }

      const previous = previousById.get(player.id);
      if (previous && !movedTooFar(previous.pos, player.pos)) {
        const pos = lerp(previous.pos, player.pos, alpha);
        visual.group.position.set(pos.x, pos.y, pos.z);
        visual.group.rotation.y = -lerpAngle(previous.yaw, player.yaw, alpha);
      } else {
        visual.group.position.set(safe(player.pos.x), safe(player.pos.y), safe(player.pos.z));
        visual.group.rotation.y = -safe(player.yaw);
      }

      const hidden = player.state === 'down' || player.state === 'respawn';
      visual.group.visible = !hidden;
      const diving = player.state === 'dive';
      visual.body.visible = !diving;
      visual.blob.visible = diving;
    }

    for (const [id, visual] of visualById) {
      if (!seenPlayers.has(id)) visual.group.visible = false;
    }

    let target: PlayerView | undefined;
    for (const player of curr.players) {
      if (player.id === cameraPlayerId) {
        target = player;
        break;
      }
    }
    if (!target) target = curr.players[0];

    if (target) {
      const previous = previousById.get(target.id);
      cameraView.id = target.id;
      cameraView.team = target.team;
      cameraView.state = target.state;
      cameraView.hp = target.hp;
      cameraView.ink = target.ink;

      if (previous && !movedTooFar(previous.pos, target.pos)) {
        const pos = lerp(previous.pos, target.pos, alpha);
        cameraView.pos.x = pos.x;
        cameraView.pos.y = pos.y;
        cameraView.pos.z = pos.z;
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
      camera.lookAt(cameraOut.lookTarget.x, cameraOut.lookTarget.y, cameraOut.lookTarget.z);
    } else {
      camera.position.set(overview.x, overview.y, overview.z);
      camera.lookAt(overview.targetX, overview.targetY, overview.targetZ);
    }

    const camX = camera.position.x;
    const camZ = camera.position.z;
    let count = 0;
    for (const projectile of curr.projectiles) {
      if (count >= PROJECTILE_CAPACITY) break;

      const px = safe(projectile.pos.x);
      const py = safe(projectile.pos.y);
      const pz = safe(projectile.pos.z);
      const angle = safe(Math.atan2(camX - px, camZ - pz));

      scratchMatrix.makeRotationY(angle);
      scratchMatrix.setPosition(px, py, pz);
      projectiles.setMatrixAt(count, scratchMatrix);
      projectiles.setColorAt(count, projectile.team === 0 ? teamA : teamB);
      count += 1;
    }

    projectiles.count = count;
    if (count > 0) {
      projectiles.instanceMatrix.needsUpdate = true;
      if (projectiles.instanceColor) projectiles.instanceColor.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    for (const texture of textures) texture.dispose();
    for (const material of materials) material.dispose();
    for (const geometry of geometries) geometry.dispose();

    canvas.removeEventListener('webglcontextlost', handleContextLost, false);

    surfaceVisuals.clear();
    visualById.clear();
    scene.clear();
    renderer.dispose();
  }

  resize(canvas.clientWidth, canvas.clientHeight, 1);

  return { render, resize, dispose };
}
