import {
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import type { DataTexture, Material } from 'three';
import { PALETTE } from '../palette';
import { createToonMaterial } from '../toon';
import type {
  Anim,
  AttachPoint,
  CharacterAnimInput,
  CharacterAssetCache,
  CharacterBuildOptions,
  CharacterDef,
  CharacterRig,
  ColorRef,
  Expression,
  PartDef,
  Prim,
  TeamSlot,
  Vec3Tuple,
} from './types';

const TAU = Math.PI * 2;
const FALLBACK_GREY = 0x808080;
const WHITE_HEX = 0xfafafa;
const INK_HEX = PALETTE.outline;
const TEAM_DARK_FACTOR = 0.65;
const OUTLINE_SCALE = 1.06;
const BLINK_SECONDS = 0.12;
const BLINK_MIN_PERIOD = 2.5;
const BLINK_PERIOD_SPAN = 2.5;
const BLINK_SCALE = 0.08;
const RUN_FREQUENCY = 14;
const EXPRESSION_LERP_SPEED = 14;
const HEX_PATTERN = /^#[0-9a-f]{6}$/i;

/* Body template (2.6 heads, 1.60 m tall, soles on the ground plane). Def
 * numbers are read in these terms: headY is the crown, legLength is the hip
 * pivot height and bodyHeight/bodyWidth describe the torso block. */
const TEMPLATE_HEAD_TOP_Y = 1.6;
const TEMPLATE_HEAD_RADIUS = 0.33;
const TEMPLATE_HEAD_SCALE_Y = 0.94;
const TEMPLATE_BODY_WIDTH = 0.48;
const TEMPLATE_BODY_HEIGHT = 0.68;
const TEMPLATE_LEG_PIVOT_Y = 0.37;
const MIN_HEAD_HEIGHT = 0.58;
const MAX_HEAD_HEIGHT = 0.68;
const LEG_PIVOT_OFFSET = 0.02;
const LEG_OVERLAP = 0.06;
const FOOT_HEIGHT = 0.11;
const FROG_FOOT_HEIGHT = 0.08;
const FOOT_TOE_Z = -0.04;
const ARM_SPLAY = 0.22;
const BELT_LIFT = 0.21;
const BELT_KNOT_HEIGHT = 0.09;
const CREST_LIFT = 0.11;
const HEADBAND_LIFT = 0.1;
/* Thin bands: a fat tube reads as a pool float, so the scarf and belt hug the
 * neck / torso instead of orbiting the body. */
const SCARF_TUBE = 0.045;
const BELT_TUBE = 0.032;
const SCARF_GAP = 0.03;
const SCARF_BOX_DROP = 0.03;
const NECK_WIDTH_FACTOR = 0.55;
const MIN_NECK_RADIUS = 0.07;
const MAX_NECK_RADIUS = 0.2;
const MUZZLE_DROP = 0.03;
const MUZZLE_PUSH = 0.062;
const EYE_SPREAD_DEFAULT = 0.48;
const EYE_ELEVATION_DEFAULT = -0.08;
const EYE_WHITE_RADIUS = 0.11;
const IRIS_RADIUS = 0.07;
const IRIS_Z = 0.045;
const PUPIL_RADIUS = 0.042;
const PUPIL_Z = 0.065;
const HIGHLIGHT_RADIUS = 0.03;
const HIGHLIGHT_SMALL_RADIUS = 0.014;
const HIGHLIGHT_FORWARD = -0.06;
const HIGHLIGHT_BASE_X = 0.03;
const HIGHLIGHT_BASE_Y = 0.03;
const HIGHLIGHT_SMALL_X = -0.02;
const HIGHLIGHT_SMALL_Y = -0.025;
const TOP_EYE_RADIUS = 0.42;
const MOUTH_Y_FACTOR = 0.45;
const BROW_ELEVATION_LIFT = 0.4;
const CHEEK_DEFAULT = '#ffb0b8';

function safeNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positiveNumber(value: number, fallback: number): number {
  const safe = Number.isFinite(value) ? value : fallback;
  return safe > 0 ? safe : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function safeHex(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) & 0xffffff : 0xffffff;
}

function hexFromString(value: string, fallback: number): number {
  if (!HEX_PATTERN.test(value)) return fallback;
  const parsed = Number.parseInt(value.slice(1), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sanitizeSegments(value: number | undefined, fallback: number, min: number): number {
  if (value === undefined) return fallback;
  const safe = Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(64, Math.max(min, safe));
}

function sanitizeScale(value: Vec3Tuple, fallback: Vec3Tuple): [number, number, number] {
  return [
    positiveNumber(value[0], fallback[0]),
    positiveNumber(value[1], fallback[1]),
    positiveNumber(value[2], fallback[2]),
  ];
}

function positiveModulo(value: number, period: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(period) || period <= 0) return 0;
  const result = value % period;
  return result < 0 ? result + period : result;
}

/** Tiny integer hash used only for deterministic blink timing. */
function hash01(value: number): number {
  let x = Number.isFinite(value) ? Math.trunc(value) : 0;
  x = (x ^ 0x9e3779b9) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/* ------------------------------------------------------------------ */
/* Shared asset cache                                                  */
/* ------------------------------------------------------------------ */

interface AssetStore {
  geometries: Map<string, BufferGeometry>;
  toonMaterials: Map<string, MeshToonMaterial>;
  basicMaterials: Map<string, MeshBasicMaterial>;
}

const stores = new WeakMap<CharacterAssetCache, AssetStore>();

function createStore(): AssetStore {
  return {
    geometries: new Map<string, BufferGeometry>(),
    toonMaterials: new Map<string, MeshToonMaterial>(),
    basicMaterials: new Map<string, MeshBasicMaterial>(),
  };
}

/** One geometry/material cache for a renderer or preview. */
export function createCharacterCache(): CharacterAssetCache {
  const store = createStore();
  const cache: CharacterAssetCache = {
    dispose(): void {
      for (const geometry of store.geometries.values()) geometry.dispose();
      store.geometries.clear();
      for (const material of store.toonMaterials.values()) material.dispose();
      store.toonMaterials.clear();
      for (const material of store.basicMaterials.values()) material.dispose();
      store.basicMaterials.clear();
    },
  };
  stores.set(cache, store);
  return cache;
}

function storeFor(cache: CharacterAssetCache): AssetStore {
  const existing = stores.get(cache);
  if (existing !== undefined) return existing;
  const created = createStore();
  stores.set(cache, created);
  return created;
}

function createGeometry(prim: Prim, lowDetail: boolean): BufferGeometry {
  switch (prim.t) {
    case 'sphere': {
      const radius = positiveNumber(prim.r, 0.1);
      const seg = prim.seg;
      const width = sanitizeSegments(seg?.[0], lowDetail ? 12 : 18, 3);
      const height = sanitizeSegments(seg?.[1], lowDetail ? 8 : 14, 2);
      return new SphereGeometry(radius, width, height);
    }
    case 'capsule': {
      const radius = positiveNumber(prim.r, 0.06);
      const length = Math.max(0, safeNumber(prim.len, 0));
      return new CapsuleGeometry(radius, length, lowDetail ? 4 : 6, lowDetail ? 8 : 12);
    }
    case 'cylinder': {
      const rTop = positiveNumber(prim.rTop, 0.1);
      const rBot = positiveNumber(prim.rBot, rTop);
      const height = positiveNumber(prim.h, 0.1);
      const seg = sanitizeSegments(prim.seg, lowDetail ? 8 : 16, 3);
      return new CylinderGeometry(rTop, rBot, height, seg, 1);
    }
    case 'cone': {
      const radius = positiveNumber(prim.r, 0.1);
      const height = positiveNumber(prim.h, 0.1);
      const seg = sanitizeSegments(prim.seg, lowDetail ? 8 : 16, 3);
      return new ConeGeometry(radius, height, seg, 1);
    }
    case 'box': {
      const width = positiveNumber(prim.w, 0.1);
      const height = positiveNumber(prim.h, 0.1);
      const depth = positiveNumber(prim.d, 0.1);
      return new BoxGeometry(width, height, depth);
    }
    case 'torus': {
      const radius = positiveNumber(prim.R, 0.1);
      const tube = positiveNumber(prim.r, radius * 0.25);
      const arc = prim.arc === undefined ? TAU : clamp(prim.arc, 0.01, TAU);
      const radial = lowDetail ? 5 : 8;
      const tubular = lowDetail ? 12 : 20;
      return new TorusGeometry(radius, tube, radial, tubular, arc);
    }
    case 'lathe': {
      const points: Vector2[] = [];
      for (let i = 0; i < prim.profile.length; i += 1) {
        const pair = prim.profile[i];
        if (pair === undefined) continue;
        points.push(new Vector2(Math.max(0.0001, Math.abs(safeNumber(pair[0], 0))), safeNumber(pair[1], 0)));
      }
      if (points.length < 2) {
        points.push(new Vector2(0.0001, -0.5));
        points.push(new Vector2(0.0001, 0.5));
      }
      return new LatheGeometry(points, lowDetail ? 8 : 16);
    }
  }
}

function primitiveLength(prim: Prim): number {
  switch (prim.t) {
    case 'sphere':
      return Math.max(0.01, positiveNumber(prim.r, 0.1) * 2);
    case 'capsule':
      return Math.max(0.01, positiveNumber(prim.r, 0.06) * 2 + Math.max(0, safeNumber(prim.len, 0)));
    case 'cylinder':
      return Math.max(0.01, positiveNumber(prim.h, 0.1));
    case 'cone':
      return Math.max(0.01, positiveNumber(prim.h, 0.1));
    case 'box':
      return Math.max(0.01, positiveNumber(prim.h, 0.1));
    case 'torus':
      return Math.max(0.01, (positiveNumber(prim.R, 0.1) + positiveNumber(prim.r, 0.02)) * 2);
    case 'lathe': {
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < prim.profile.length; i += 1) {
        const pair = prim.profile[i];
        if (pair === undefined) continue;
        const y = safeNumber(pair[1], 0);
        if (y < min) min = y;
        if (y > max) max = y;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0.1;
      return max - min;
    }
  }
}

function geometryFor(store: AssetStore, prim: Prim, lowDetail: boolean): BufferGeometry {
  const key = `${lowDetail ? 'low' : 'high'}:${JSON.stringify(prim)}`;
  const cached = store.geometries.get(key);
  if (cached !== undefined) return cached;
  const geometry = createGeometry(prim, lowDetail);
  store.geometries.set(key, geometry);
  return geometry;
}

const MAX_CHARACTER_MESHES = 44;

function countMeshesIn(object: Object3D): number {
  let count = 0;
  object.traverse((child) => {
    if (child instanceof Mesh) count += 1;
  });
  return count;
}

function toonFor(store: AssetStore, hex: number, gradient: DataTexture): MeshToonMaterial {
  const key = `${hex.toString(16)}:${gradient.uuid}`;
  const cached = store.toonMaterials.get(key);
  if (cached !== undefined) return cached;
  const material = createToonMaterial(hex, gradient);
  store.toonMaterials.set(key, material);
  return material;
}

function basicFor(store: AssetStore, hex: number): MeshBasicMaterial {
  const key = `basic:${hex.toString(16)}`;
  const cached = store.basicMaterials.get(key);
  if (cached !== undefined) return cached;
  const material = new MeshBasicMaterial({ color: hex, toneMapped: false });
  store.basicMaterials.set(key, material);
  return material;
}

function outlineFor(store: AssetStore): MeshBasicMaterial {
  const key = 'outline';
  const cached = store.basicMaterials.get(key);
  if (cached !== undefined) return cached;
  const material = new MeshBasicMaterial({ color: PALETTE.outline, side: BackSide });
  store.basicMaterials.set(key, material);
  return material;
}

/* ------------------------------------------------------------------ */
/* Animation state                                                     */
/* ------------------------------------------------------------------ */

interface AnimState {
  target: Object3D;
  kind: Anim['k'];
  amp: number;
  hz: number;
  lag: number;
  axis: 'x' | 'y' | 'z';
  idle: number;
  run: number;
  from: number;
  to: number;
  hzIdle: number;
  hzAir: number;
  baseRotX: number;
  baseRotY: number;
  baseRotZ: number;
  baseScaleX: number;
  baseScaleY: number;
  baseScaleZ: number;
}

function makeAnimState(target: Object3D, anim: Anim): AnimState {
  const state: AnimState = {
    target,
    kind: anim.k,
    amp: 0,
    hz: 0,
    lag: 0,
    axis: 'x',
    idle: 0,
    run: 0,
    from: 1,
    to: 1,
    hzIdle: 0,
    hzAir: 0,
    baseRotX: target.rotation.x,
    baseRotY: target.rotation.y,
    baseRotZ: target.rotation.z,
    baseScaleX: target.scale.x,
    baseScaleY: target.scale.y,
    baseScaleZ: target.scale.z,
  };
  switch (anim.k) {
    case 'flutter':
      state.amp = safeNumber(anim.amp, 0);
      state.hz = safeNumber(anim.hz, 0);
      break;
    case 'swing':
      state.amp = safeNumber(anim.amp, 0);
      state.lag = safeNumber(anim.lag, 0);
      break;
    case 'wag':
      state.axis = anim.axis;
      state.amp = safeNumber(anim.amp, 0);
      state.hz = safeNumber(anim.hz, 0);
      break;
    case 'spin':
      state.axis = anim.axis;
      state.idle = safeNumber(anim.idle, 0);
      state.run = safeNumber(anim.run, 0);
      break;
    case 'flap':
      state.amp = safeNumber(anim.amp, 0);
      state.hzIdle = safeNumber(anim.hzIdle, 0);
      state.hzAir = safeNumber(anim.hzAir, 0);
      break;
    case 'pulse':
      state.from = safeNumber(anim.from, 1);
      state.to = safeNumber(anim.to, 1);
      state.hz = safeNumber(anim.hz, 0);
      break;
  }
  return state;
}

/* ------------------------------------------------------------------ */
/* Character builder                                                   */
/* ------------------------------------------------------------------ */

/**
 * Builds one chibi ninja from a data definition. The root sits with the soles
 * at the origin; all animation and recolouring happen on the returned rig.
 */
export function buildCharacter(def: CharacterDef, opts: CharacterBuildOptions): CharacterRig {
  const store = storeFor(opts.cache);
  const lowDetail = opts.lowDetail === true;
  const gradient = opts.gradient;
  const bodyDef = def.body;
  const colors = def.colors;

  const headRadius = positiveNumber(bodyDef.headRadius, TEMPLATE_HEAD_RADIUS);
  const headScale = sanitizeScale(bodyDef.headScale, [1, TEMPLATE_HEAD_SCALE_Y, 1]);
  const headY = safeNumber(bodyDef.headY ?? TEMPLATE_HEAD_TOP_Y, TEMPLATE_HEAD_TOP_Y);
  const bodyHeight = positiveNumber(bodyDef.bodyHeight, TEMPLATE_BODY_HEIGHT);
  const bodyWidth = positiveNumber(bodyDef.bodyWidth, TEMPLATE_BODY_WIDTH);
  const legLength = positiveNumber(bodyDef.legLength, TEMPLATE_LEG_PIVOT_Y);
  const stoop = clamp(safeNumber(bodyDef.stoop ?? 0, 0), -1.2, 1.2);

  /* headY is the crown, so the head pivot sits at its centre and the torso
   * hangs from the hip pivot owned by legLength. Heads keep the template
   * size and legs stay short: both are art-direction invariants that a def
   * may only narrow, never break. */
  const headScaleY = clamp(
    headScale[1],
    (MIN_HEAD_HEIGHT + 0.002) / (2 * headRadius),
    (MAX_HEAD_HEIGHT - 0.002) / (2 * headRadius),
  );
  const headHalfHeight = headRadius * headScaleY;
  const headCenterY = headY - headHalfHeight;
  const headBottomY = headCenterY - headHalfHeight;
  const footHeight = bodyDef.legStyle === 'frog' ? FROG_FOOT_HEIGHT : FOOT_HEIGHT;
  const maxLegPivot = 0.17 * headY + footHeight + LEG_PIVOT_OFFSET;
  const legPivotY = clamp(legLength, 0.1, Math.min(0.6, maxLegPivot));
  const hipY = legPivotY - LEG_PIVOT_OFFSET;
  const torsoBottomY = hipY;
  const torsoCenterY = torsoBottomY + bodyHeight / 2;
  const torsoTopY = torsoBottomY + bodyHeight;
  const hipHeight = clamp(bodyHeight * 0.18, 0.08, 0.14);
  const torsoBackZ = bodyDef.torso === 'box' ? bodyWidth * 0.375 : bodyWidth / 2;

  const legMeshHeight = Math.max(0.08, legPivotY - footHeight + LEG_OVERLAP);

  /** Horizontal torso radius at a world height: used to seat bands on the body. */
  function torsoRadiusAt(y: number): number {
    const halfWidth = bodyWidth / 2;
    const dy = y - torsoCenterY;
    if (bodyDef.torso === 'box') {
      return Math.abs(dy) <= bodyHeight / 2 ? halfWidth : 0;
    }
    if (bodyDef.torso === 'sphere') {
      const halfHeight = Math.max(0.01, bodyHeight / 2);
      const t = clamp(dy / halfHeight, -1, 1);
      return halfWidth * Math.sqrt(Math.max(0, 1 - t * t));
    }
    const coreHalf = Math.max(0.02, bodyHeight - bodyWidth) / 2;
    const over = Math.abs(dy) - coreHalf;
    if (over <= 0) return halfWidth;
    if (over >= halfWidth) return 0;
    return Math.sqrt(Math.max(0, halfWidth * halfWidth - over * over));
  }

  const shoulderY = torsoTopY - 0.1;
  const shoulderX = Math.max(0.16, bodyWidth / 2 + 0.02);
  const legX =
    bodyDef.legStyle === 'frog' ? Math.max(0.13, bodyWidth * 0.38) : Math.max(0.09, bodyWidth * 0.27 - 0.01);

  /* ---------- rig-owned materials ---------- */

  const teamMaterial = new MeshToonMaterial({ color: safeHex(opts.teamColor), gradientMap: gradient });
  const teamDarkMaterial = new MeshToonMaterial({ color: safeHex(opts.teamColor), gradientMap: gradient });
  teamDarkMaterial.color.multiplyScalar(TEAM_DARK_FACTOR);

  const skinHex = hexFromString(colors.skin, FALLBACK_GREY);
  const garbHex = hexFromString(colors.garb, FALLBACK_GREY);
  const skinMaterial = toonFor(store, skinHex, gradient).clone();
  const garbMaterial = toonFor(store, garbHex, gradient).clone();

  const teamMeshes: Mesh[] = [];
  const anims: AnimState[] = [];
  const eyeMeshes: Mesh[] = [];
  const eyeBaseScaleY: number[] = [];
  const irisMeshes: Mesh[] = [];
  const irisBaseX: number[] = [];
  const irisBaseY: number[] = [];
  const irisBaseZ: number[] = [];
  const highlightMeshes: Mesh[] = [];
  const highlightBaseX: number[] = [];
  const highlightBaseY: number[] = [];
  const highlightBaseZ: number[] = [];

  function setTeamColor(color: number): void {
    const hex = safeHex(color);
    teamMaterial.color.setHex(hex);
    teamDarkMaterial.color.setHex(hex);
    teamDarkMaterial.color.multiplyScalar(TEAM_DARK_FACTOR);
  }
  setTeamColor(opts.teamColor);

  function staticHex(ref: ColorRef): number {
    switch (ref) {
      case 'skin':
        return skinHex;
      case 'garb':
        return garbHex;
      case 'garbDark':
        return hexFromString(colors.garbDark, FALLBACK_GREY);
      case 'accent':
        return hexFromString(colors.accent, FALLBACK_GREY);
      case 'accent2':
        return hexFromString(colors.accent2, FALLBACK_GREY);
      case 'white':
        return WHITE_HEX;
      case 'ink':
        return INK_HEX;
      case 'team':
      case 'teamDark':
        return WHITE_HEX;
      default:
        return hexFromString(ref, FALLBACK_GREY);
    }
  }

  interface ChosenMaterial {
    material: Material;
    team: boolean;
  }

  function materialFor(ref: ColorRef, basic: boolean): ChosenMaterial {
    if (ref === 'team') return { material: teamMaterial, team: true };
    if (ref === 'teamDark') return { material: teamDarkMaterial, team: true };
    if (ref === 'skin') return { material: skinMaterial, team: false };
    if (ref === 'garb') return { material: garbMaterial, team: false };
    const hex = staticHex(ref);
    return { material: basic ? basicFor(store, hex) : toonFor(store, hex, gradient), team: false };
  }

  /* ---------- hierarchy ---------- */

  const root = new Group();
  root.name = def.id;

  const body = new Group();
  body.name = 'body';
  body.position.set(0, hipY, 0);
  body.rotation.x = -stoop;
  root.add(body);

  const torsoPivot = new Group();
  torsoPivot.name = 'torso-pivot';
  torsoPivot.position.set(0, torsoCenterY - hipY, 0);
  body.add(torsoPivot);

  const headPivot = new Group();
  headPivot.name = 'head-pivot';
  headPivot.position.set(0, headCenterY - hipY, 0);
  body.add(headPivot);

  const armL = new Group();
  armL.name = 'armL';
  armL.position.set(-shoulderX, shoulderY - hipY, 0);
  body.add(armL);

  const armLInner = new Group();
  armLInner.name = 'armL-splay';
  armLInner.rotation.z = -ARM_SPLAY;
  armL.add(armLInner);

  const armR = new Group();
  armR.name = 'armR';
  armR.position.set(shoulderX, shoulderY - hipY, 0);
  body.add(armR);

  const armRInner = new Group();
  armRInner.name = 'armR-splay';
  armRInner.rotation.z = ARM_SPLAY;
  armR.add(armRInner);

  const hipPivot = new Group();
  hipPivot.name = 'hip-pivot';
  hipPivot.position.set(0, hipY, 0);
  root.add(hipPivot);

  const legL = new Group();
  legL.name = 'legL';
  legL.position.set(-legX, legPivotY, 0);
  root.add(legL);

  const legR = new Group();
  legR.name = 'legR';
  legR.position.set(legX, legPivotY, 0);
  root.add(legR);

  function addOutline(source: Mesh): void {
    if (lowDetail) return;
    const outline = new Mesh(source.geometry, outlineFor(store));
    outline.name = `${source.name}-outline`;
    outline.scale.setScalar(OUTLINE_SCALE);
    source.add(outline);
  }

  function addTeamMesh(mesh: Mesh, team: boolean): void {
    if (team) teamMeshes.push(mesh);
  }

  /* ---------- body ---------- */

  const headMesh: Mesh =
    bodyDef.headShape === 'box'
      ? new Mesh(
          geometryFor(store, { t: 'box', w: headRadius * 2, h: headRadius * 2, d: headRadius * 2 }, lowDetail),
          skinMaterial,
        )
      : new Mesh(geometryFor(store, { t: 'sphere', r: headRadius }, lowDetail), skinMaterial);
  headMesh.name = 'head';
  headMesh.scale.set(headScale[0], headScaleY, headScale[2]);
  headPivot.add(headMesh);

  let torsoMesh: Mesh;
  switch (bodyDef.torso) {
    case 'sphere': {
      const radius = bodyWidth / 2;
      torsoMesh = new Mesh(geometryFor(store, { t: 'sphere', r: radius }, lowDetail), garbMaterial);
      torsoMesh.scale.set(1, Math.max(0.2, bodyHeight / bodyWidth), 1);
      break;
    }
    case 'box': {
      torsoMesh = new Mesh(
        geometryFor(store, { t: 'box', w: bodyWidth, h: bodyHeight, d: bodyWidth * 0.75 }, lowDetail),
        garbMaterial,
      );
      break;
    }
    case 'skirt': {
      const radius = bodyWidth / 2;
      const length = Math.max(0.02, bodyHeight - bodyWidth);
      torsoMesh = new Mesh(geometryFor(store, { t: 'capsule', r: radius, len: length }, lowDetail), garbMaterial);
      const flare = new Mesh(
        geometryFor(
          store,
          {
            t: 'cylinder',
            rTop: Math.max(0.05, bodyWidth * 0.32),
            rBot: Math.max(0.08, bodyWidth * 0.85),
            h: Math.max(0.05, bodyHeight * 0.4),
          },
          lowDetail,
        ),
        garbMaterial,
      );
      flare.name = 'skirt-flare';
      flare.position.set(0, -bodyHeight / 2 + 0.08, 0);
      torsoPivot.add(flare);
      break;
    }
    case 'capsule':
    default: {
      const radius = bodyWidth / 2;
      const length = Math.max(0.02, bodyHeight - bodyWidth);
      torsoMesh = new Mesh(geometryFor(store, { t: 'capsule', r: radius, len: length }, lowDetail), garbMaterial);
      break;
    }
  }
  torsoMesh.name = 'torso';
  torsoPivot.add(torsoMesh);
  addOutline(torsoMesh);

  /* The hip plate only exists for square torsos; rounded ones already close
   * their own silhouette at the pelvic line. */
  if (bodyDef.torso === 'box') {
    const hipWidth = Math.max(0.22, bodyWidth * 0.9);
    const hipMesh = new Mesh(
      geometryFor(store, { t: 'box', w: hipWidth, h: hipHeight, d: bodyWidth * 0.7 }, lowDetail),
      garbMaterial,
    );
    hipMesh.name = 'hip';
    hipPivot.add(hipMesh);
  }

  /* ---------- arms ---------- */

  const armRadius =
    bodyDef.armStyle === 'slim' ? clamp(bodyWidth * 0.1, 0.04, 0.055) : clamp(bodyWidth * 0.16, 0.05, 0.085);
  const armLength =
    bodyDef.armStyle === 'cyl' ? clamp(bodyHeight * 0.42, 0.16, 0.3) : clamp(bodyHeight * 0.24, 0.12, 0.22);
  const armTotal = bodyDef.armStyle === 'cyl' ? armLength : armLength + armRadius * 2;
  const handRadius = 0.096 * clamp(bodyWidth / TEMPLATE_BODY_WIDTH, 0.75, 1.2);

  function buildArm(pivot: Group, side: number): void {
    const armMesh =
      bodyDef.armStyle === 'cyl'
        ? new Mesh(geometryFor(store, { t: 'cylinder', rTop: armRadius, rBot: armRadius, h: armLength }, lowDetail), garbMaterial)
        : new Mesh(geometryFor(store, { t: 'capsule', r: armRadius, len: armLength }, lowDetail), garbMaterial);
    armMesh.name = side < 0 ? 'armL-mesh' : 'armR-mesh';
    armMesh.position.set(0, -armTotal / 2, 0);
    pivot.add(armMesh);
  }

  buildArm(armLInner, -1);
  buildArm(armRInner, 1);

  function makeHand(name: string): { group: Group; mesh: Mesh } {
    const group = new Group();
    group.name = name;
    let handMesh: Mesh;
    if (bodyDef.handStyle === 'sleeve') {
      handMesh = new Mesh(
        geometryFor(store, { t: 'cylinder', rTop: 0.07, rBot: 0.08, h: 0.2 }, lowDetail),
        garbMaterial,
      );
      handMesh.position.set(0, -0.08, 0);
    } else if (bodyDef.handStyle === 'box') {
      handMesh = new Mesh(geometryFor(store, { t: 'box', w: 0.12, h: 0.1, d: 0.1 }, lowDetail), skinMaterial);
    } else {
      const radius = bodyDef.handStyle === 'paw' ? handRadius * 0.94 : handRadius;
      handMesh = new Mesh(geometryFor(store, { t: 'sphere', r: radius }, lowDetail), skinMaterial);
    }
    handMesh.name = `${name}-mesh`;
    group.add(handMesh);
    return { group, mesh: handMesh };
  }

  const handL = makeHand('handL');
  handL.group.position.set(0, -armTotal, 0);
  armLInner.add(handL.group);

  const handR = makeHand('handR');
  handR.group.position.set(0, -armTotal, 0);
  armRInner.add(handR.group);

  /* ---------- legs ---------- */

  function buildLeg(pivot: Group, side: number): void {
    let legMesh: Mesh;
    if (bodyDef.legStyle === 'peg') {
      legMesh = new Mesh(
        geometryFor(store, { t: 'cylinder', rTop: 0.06, rBot: 0.06, h: legMeshHeight }, lowDetail),
        garbMaterial,
      );
    } else if (bodyDef.legStyle === 'slim') {
      legMesh = new Mesh(
        geometryFor(store, { t: 'capsule', r: 0.05, len: Math.max(0.02, legMeshHeight - 0.1) }, lowDetail),
        garbMaterial,
      );
    } else if (bodyDef.legStyle === 'frog') {
      legMesh = new Mesh(
        geometryFor(store, { t: 'capsule', r: 0.09, len: Math.max(0.02, legMeshHeight - 0.18) }, lowDetail),
        garbMaterial,
      );
    } else {
      legMesh = new Mesh(
        geometryFor(store, { t: 'box', w: 0.17, h: legMeshHeight, d: 0.19 }, lowDetail),
        garbMaterial,
      );
    }
    legMesh.name = side < 0 ? 'legL-mesh' : 'legR-mesh';
    legMesh.position.set(0, -(legPivotY - footHeight) / 2 + 0.03, 0);
    pivot.add(legMesh);

    const footMesh = new Mesh(
      geometryFor(
        store,
        bodyDef.legStyle === 'frog'
          ? { t: 'box', w: 0.26, h: footHeight, d: 0.34 }
          : { t: 'box', w: 0.21, h: footHeight, d: 0.3 },
        lowDetail,
      ),
      garbMaterial,
    );
    footMesh.name = side < 0 ? 'footL' : 'footR';
    footMesh.position.set(0, -(legPivotY - footHeight / 2), FOOT_TOE_Z);
    if (bodyDef.legStyle === 'frog') footMesh.rotation.y = side * -0.35;
    pivot.add(footMesh);
  }

  buildLeg(legL, -1);
  buildLeg(legR, 1);

  /* ---------- face ---------- */

  const face = def.face;
  const eyeSpread = clamp(Math.abs(safeNumber(face.eyeSpread, EYE_SPREAD_DEFAULT)), 0, 1.25);
  const eyeElevation = clamp(safeNumber(face.eyeY, EYE_ELEVATION_DEFAULT), -0.7, 1.1);
  const eyeRoots: Object3D[] = [];
  const highlightSlots: { x: number; y: number; z: number; side: number }[] = [];
  const browMeshes: Mesh[] = [];
  const browSides: number[] = [];
  const browBaseZ: number[] = [];

  const eyeWhiteMaterial = toonFor(store, WHITE_HEX, gradient);
  const irisHex = hexFromString(colors.iris, FALLBACK_GREY);
  const irisMaterial = toonFor(store, irisHex, gradient);
  const inkMaterial = toonFor(store, INK_HEX, gradient);
  const highlightMaterial = basicFor(store, WHITE_HEX);

  const eyeScale = eyeStyleScale(face.eye);
  /* Square heads have no curved surface: face features ride on the front
   * plane instead of an ellipsoid normal. */
  const boxHead = bodyDef.headShape === 'box';
  const boxFaceZ = -headRadius * headScale[2] * 1.02;

  interface EyeSpot {
    x: number;
    y: number;
    z: number;
    nx: number;
    ny: number;
    nz: number;
  }

  /** Eyes sit on the head surface; the 'top' style rides high on the skull. */
  function eyePlacement(side: number): EyeSpot {
    if (face.eye === 'top') {
      return {
        x: side * headRadius * headScale[0] * 0.6,
        y: headHalfHeight * 1.05,
        z: boxHead ? boxFaceZ : -headRadius * headScale[2] * 0.62,
        nx: side * 0.25,
        ny: 0.45,
        nz: -0.85,
      };
    }
    const azimuth = side * eyeSpread;
    const cosElevation = Math.cos(eyeElevation);
    const nx = Math.sin(azimuth) * cosElevation;
    const ny = Math.sin(eyeElevation);
    const nz = -Math.cos(azimuth) * cosElevation;
    return {
      x: nx * headRadius * headScale[0],
      y: ny * headRadius * headScaleY,
      z: boxHead ? boxFaceZ : nz * headRadius * headScale[2],
      nx,
      ny,
      nz,
    };
  }

  function makeEyeRoot(side: number): Group {
    const spot = eyePlacement(side);
    const rootGroup = new Group();
    rootGroup.name = side < 0 ? 'eye-root-L' : 'eye-root-R';
    rootGroup.position.set(spot.x, spot.y, spot.z);
    const normal = new Vector3(spot.nx, spot.ny, spot.nz);
    if (normal.lengthSq() < 0.0001) normal.set(0, 0, -1);
    normal.normalize();
    rootGroup.quaternion.copy(new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal));
    headPivot.add(rootGroup);
    return rootGroup;
  }

  for (const side of [-1, 1]) {
    const eye = makeEyeRoot(side);
    eyeRoots.push(eye);

    if (face.eye === 'disc') {
      const discMaterial = basicFor(store, hexFromString(colors.accent2, FALLBACK_GREY));
      const disc = new Mesh(geometryFor(store, { t: 'cylinder', rTop: 0.09, rBot: 0.09, h: 0.02 }, lowDetail), discMaterial);
      disc.name = side < 0 ? 'eye-disc-L' : 'eye-disc-R';
      disc.rotation.x = Math.PI / 2;
      eye.add(disc);
      eyeMeshes.push(disc);
      eyeBaseScaleY.push(disc.scale.y);
      const pupil = new Mesh(geometryFor(store, { t: 'cylinder', rTop: 0.035, rBot: 0.035, h: 0.02 }, lowDetail), inkMaterial);
      pupil.name = side < 0 ? 'pupil-disc-L' : 'pupil-disc-R';
      pupil.rotation.x = Math.PI / 2;
      pupil.position.set(0, 0, 0.02);
      eye.add(pupil);
      continue;
    }

    const eyeRadius = face.eye === 'top' ? headRadius * TOP_EYE_RADIUS : EYE_WHITE_RADIUS;
    const white = new Mesh(geometryFor(store, { t: 'sphere', r: eyeRadius }, lowDetail), eyeWhiteMaterial);
    white.name = side < 0 ? 'eye-white-L' : 'eye-white-R';
    white.scale.set(eyeScale[0], eyeScale[1], eyeScale[2]);
    if (face.eye === 'almond') white.rotation.z = side * 0.2;
    eye.add(white);
    eyeMeshes.push(white);
    eyeBaseScaleY.push(eyeScale[1]);

    const iris = new Mesh(
      geometryFor(store, { t: 'sphere', r: face.eye === 'top' ? 0.075 : IRIS_RADIUS }, lowDetail),
      irisMaterial,
    );
    iris.name = side < 0 ? 'iris-L' : 'iris-R';
    iris.position.set(0, 0, face.eye === 'top' ? 0.1 : IRIS_Z);
    eye.add(iris);
    irisMeshes.push(iris);
    irisBaseX.push(iris.scale.x);
    irisBaseY.push(iris.scale.y);
    irisBaseZ.push(iris.scale.z);

    const pupil = new Mesh(
      geometryFor(store, { t: 'sphere', r: face.eye === 'top' ? 0.045 : PUPIL_RADIUS }, lowDetail),
      inkMaterial,
    );
    pupil.name = side < 0 ? 'pupil-L' : 'pupil-R';
    pupil.position.set(0, 0, face.eye === 'top' ? 0.125 : PUPIL_Z);
    if (face.eye === 'top') pupil.scale.set(1.4, 0.7, 1);
    if (face.eye === 'cat') pupil.scale.set(0.5, 1.4, 1);
    eye.add(pupil);

    if (!lowDetail) {
      const spot = eyePlacement(side);
      /* Highlights live on the head, not inside each eye frame, so both eyes
       * catch the light on the same side. */
      highlightSlots.push({
        x: spot.x + HIGHLIGHT_BASE_X,
        y: spot.y + HIGHLIGHT_BASE_Y,
        z: spot.z + HIGHLIGHT_FORWARD,
        side,
      });
    }
  }

  /* brows */
  if (face.brow !== 'none') {
    for (const side of [-1, 1]) {
      const az = side * eyeSpread;
      const elev = face.eye === 'top' ? 0.9 : eyeElevation + BROW_ELEVATION_LIFT;
      const cosElev = Math.cos(elev);
      const bx = Math.sin(az) * cosElev * headRadius * headScale[0];
      const by = Math.sin(elev) * headRadius * headScaleY;
      const bz = boxHead ? boxFaceZ : -Math.cos(az) * cosElev * headRadius * headScale[2];
      const normal = new Vector3(bx, by, bz);
      if (normal.lengthSq() < 0.0001) normal.set(0, 0.2, -1);
      normal.normalize();

      let brow: Mesh;
      let baseZ = 0;
      if (face.brow === 'soft') {
        brow = new Mesh(
          geometryFor(store, { t: 'torus', R: 0.055, r: 0.012, arc: Math.PI }, lowDetail),
          inkMaterial,
        );
        baseZ = Math.PI;
      } else if (face.brow === 'thick') {
        brow = new Mesh(geometryFor(store, { t: 'box', w: 0.16, h: 0.05, d: 0.03 }, lowDetail), inkMaterial);
        baseZ = side * -0.12;
      } else if (face.brow === 'thin') {
        brow = new Mesh(geometryFor(store, { t: 'box', w: 0.12, h: 0.02, d: 0.02 }, lowDetail), inkMaterial);
        baseZ = side * -0.18;
      } else if (face.brow === 'worried') {
        brow = new Mesh(geometryFor(store, { t: 'box', w: 0.12, h: 0.025, d: 0.02 }, lowDetail), inkMaterial);
        baseZ = side * 0.28;
      } else {
        brow = new Mesh(geometryFor(store, { t: 'box', w: 0.12, h: 0.025, d: 0.02 }, lowDetail), inkMaterial);
        baseZ = side * -0.12;
      }
      brow.name = side < 0 ? 'brow-L' : 'brow-R';
      brow.position.set(bx, by, bz);
      brow.rotation.set(0, -Math.atan2(normal.x, -normal.z), baseZ);
      headPivot.add(brow);
      browMeshes.push(brow);
      browSides.push(side);
      browBaseZ.push(baseZ);
    }
  }

  /* The mouth hangs one eye-scoop below the eyes, so frog-style 'top' eyes
   * push the whole lower face up instead of burying the mouth in the chin.
   * Every style shares this anchor: none of them may drift off the head. */
  const extras = face.extras ?? [];
  const hasMuzzle = extras.includes('muzzle');
  const eyeCentreY =
    face.eye === 'top' ? headHalfHeight * 1.05 : Math.sin(eyeElevation) * headHalfHeight;
  const mouthY = eyeCentreY - headRadius * MOUTH_Y_FACTOR * headScaleY;
  const mouthRelative = clamp(mouthY / headHalfHeight, -1, 1);
  const mouthSurfaceZ = boxHead
    ? boxFaceZ
    : -headRadius * headScale[2] * Math.sqrt(Math.max(0, 1 - mouthRelative * mouthRelative));
  /* A mouth in front of a muzzle would be painted over by it, so pushed-out
   * faces get the mouth on the muzzle's own front surface. */
  const mouthDepth = mouthSurfaceZ - (hasMuzzle ? MUZZLE_PUSH : 0);
  const wideMouthRadius = Math.max(0.11, headRadius * headScale[0] * 0.55);
  const mouthDefault = new Group();
  mouthDefault.name = 'mouth-default';
  mouthDefault.position.set(0, mouthY, mouthDepth);
  headPivot.add(mouthDefault);

  function addMouthMesh(parent: Object3D, prim: Prim, name: string, rotationZ = 0): Mesh {
    const mesh = new Mesh(geometryFor(store, prim, lowDetail), inkMaterial);
    mesh.name = name;
    mesh.rotation.z = rotationZ;
    parent.add(mesh);
    return mesh;
  }

  switch (face.mouth) {
    case 'smile':
      addMouthMesh(mouthDefault, { t: 'torus', R: 0.045, r: 0.014, arc: Math.PI }, 'mouth-smile', Math.PI);
      break;
    case 'wide':
      addMouthMesh(mouthDefault, { t: 'torus', R: wideMouthRadius, r: 0.012, arc: Math.PI }, 'mouth-wide-base', Math.PI);
      break;
    case 'cat': {
      addMouthMesh(mouthDefault, { t: 'torus', R: 0.035, r: 0.01, arc: Math.PI }, 'mouth-cat-L', Math.PI).position.x = -0.035;
      addMouthMesh(mouthDefault, { t: 'torus', R: 0.035, r: 0.01, arc: Math.PI }, 'mouth-cat-R', Math.PI).position.x = 0.035;
      break;
    }
    case 'line':
      addMouthMesh(mouthDefault, { t: 'box', w: 0.08, h: 0.012, d: 0.01 }, 'mouth-line');
      break;
    case 'o':
      addMouthMesh(mouthDefault, { t: 'torus', R: 0.03, r: 0.012 }, 'mouth-o-base');
      break;
    case 'slit':
      addMouthMesh(mouthDefault, { t: 'box', w: 0.2, h: 0.03, d: 0.01 }, 'mouth-slit');
      break;
    case 'none':
      break;
  }

  const mouthO = new Group();
  mouthO.name = 'mouth-o';
  mouthO.position.copy(mouthDefault.position);
  mouthO.visible = false;
  headPivot.add(mouthO);
  addMouthMesh(mouthO, { t: 'torus', R: 0.03, r: 0.012 }, 'mouth-o-mesh');

  const mouthWide = new Group();
  mouthWide.name = 'mouth-wide';
  mouthWide.position.copy(mouthDefault.position);
  mouthWide.visible = false;
  headPivot.add(mouthWide);
  addMouthMesh(mouthWide, { t: 'torus', R: wideMouthRadius, r: 0.012, arc: Math.PI }, 'mouth-wide-mesh', Math.PI);

  /* cheeks are part of the base face: every face gets them unless it picks
   * its own tint. */
  if (!lowDetail) {
    const cheekHex = hexFromString(face.cheeks ?? CHEEK_DEFAULT, 0xffb0b8);
    const cheekMaterial = toonFor(store, cheekHex, gradient);
    for (const side of [-1, 1]) {
      const cheek = new Mesh(geometryFor(store, { t: 'sphere', r: 0.05 }, lowDetail), cheekMaterial);
      cheek.name = side < 0 ? 'cheek-L' : 'cheek-R';
      cheek.position.set(
        side * headRadius * 0.62 * headScale[0],
        -headRadius * 0.25 * headScaleY,
        boxHead ? boxFaceZ : -headRadius * headScale[2] * 0.9,
      );
      cheek.scale.set(1, 0.65, 0.3);
      headPivot.add(cheek);
    }
  }

  const hasBeardPart = def.parts.some((part) => part.id === 'beard');
  for (let i = 0; i < extras.length; i += 1) {
    const extra = extras[i];
    if (extra === undefined) continue;
    if (extra === 'whiskers') {
      if (lowDetail) continue;
      for (const side of [-1, 1]) {
        const whisker = new Mesh(geometryFor(store, { t: 'box', w: 0.14, h: 0.01, d: 0.01 }, lowDetail), inkMaterial);
        whisker.name = side < 0 ? 'whisker-L' : 'whisker-R';
        whisker.position.set(
          side * headRadius * 0.52 * headScale[0],
          mouthY - MUZZLE_DROP * 0.5,
          mouthSurfaceZ - 0.01,
        );
        whisker.rotation.z = side * 0.12;
        headPivot.add(whisker);
      }
    } else if (extra === 'muzzle') {
      /* The muzzle sits below the nose line so the mouth rides on its front. */
      const muzzle = new Mesh(geometryFor(store, { t: 'sphere', r: 0.09 }, lowDetail), toonFor(store, hexFromString(colors.accent, FALLBACK_GREY), gradient));
      muzzle.name = 'muzzle';
      muzzle.position.set(0, mouthY - MUZZLE_DROP, mouthSurfaceZ);
      muzzle.scale.set(1.3, 0.8, 0.6);
      headPivot.add(muzzle);
    } else if (extra === 'lashes') {
      for (const side of [-1, 1]) {
        const lash = new Mesh(geometryFor(store, { t: 'box', w: 0.1, h: 0.015, d: 0.01 }, lowDetail), inkMaterial);
        lash.name = side < 0 ? 'lash-L' : 'lash-R';
        lash.position.set(side * headRadius * 0.38 * headScale[0], headRadius * 0.34 * headScaleY, mouthSurfaceZ * 0.9);
        lash.rotation.z = side * 0.22;
        headPivot.add(lash);
      }
    } else if (extra === 'bandaid') {
      const bandaid = new Mesh(
        geometryFor(store, { t: 'box', w: 0.14, h: 0.04, d: 0.01 }, lowDetail),
        toonFor(store, hexFromString(colors.accent2, FALLBACK_GREY), gradient),
      );
      bandaid.name = 'bandaid';
      bandaid.position.set(headRadius * 0.1 * headScale[0], headRadius * 0.15 * headScaleY, -headRadius * 0.96 * headScale[2]);
      bandaid.rotation.z = 0.25;
      headPivot.add(bandaid);
    } else if (extra === 'beard' && !hasBeardPart) {
      const beard = new Mesh(
        geometryFor(store, { t: 'cone', r: 0.12, h: 0.3 }, lowDetail),
        toonFor(store, hexFromString(colors.accent, FALLBACK_GREY), gradient),
      );
      beard.name = 'extra-beard';
      beard.position.set(0, mouthY - 0.12, mouthSurfaceZ * 0.7);
      beard.rotation.x = Math.PI;
      headPivot.add(beard);
    }
  }

  /* ---------- parts and team slots ---------- */

  function attachObject(attach: AttachPoint): Object3D {
    switch (attach) {
      case 'head':
        return headPivot;
      case 'torso':
        return torsoPivot;
      case 'hip':
        return hipPivot;
      case 'armL':
        return armL;
      case 'armR':
        return armR;
      case 'legL':
        return legL;
      case 'legR':
        return legR;
      case 'root':
      default:
        return root;
    }
  }

  function attachOrigin(attach: AttachPoint): [number, number, number] {
    switch (attach) {
      case 'head':
        return [0, headCenterY, 0];
      case 'torso':
        return [0, torsoCenterY, 0];
      case 'hip':
        return [0, hipY, 0];
      case 'armL':
        return [-shoulderX, shoulderY, 0];
      case 'armR':
        return [shoulderX, shoulderY, 0];
      case 'legL':
        return [-legX, legPivotY, 0];
      case 'legR':
        return [legX, legPivotY, 0];
      case 'root':
      default:
        return [0, 0, 0];
    }
  }

  function buildPart(part: PartDef, mirrored: boolean): void {
    const parent = attachObject(part.attach);
    const origin = attachOrigin(part.attach);
    const px = (mirrored ? -safeNumber(part.pos[0], 0) : safeNumber(part.pos[0], 0)) - origin[0];
    const py = safeNumber(part.pos[1], 0) - origin[1];
    const pz = safeNumber(part.pos[2], 0) - origin[2];
    const rotX = safeNumber(part.rot?.[0] ?? 0, 0);
    const rotY = safeNumber(part.rot?.[1] ?? 0, 0) * (mirrored ? -1 : 1);
    const rotZ = safeNumber(part.rot?.[2] ?? 0, 0) * (mirrored ? -1 : 1);
    const scale = sanitizeScale(part.scale ?? [1, 1, 1], [1, 1, 1]);
    const geometry = geometryFor(store, part.prim, lowDetail);
    const chosen = materialFor(part.color, part.basic === true);
    const name = mirrored ? `${part.id}-mirror` : part.id;
    const chain = part.chain === undefined ? 1 : Math.max(1, Math.min(16, Math.floor(safeNumber(part.chain, 1))));

    if (chain > 1) {
      const segmentLength = primitiveLength(part.prim) * scale[1];
      const bendX = safeNumber(part.chainBend?.[0] ?? 0, 0);
      const bendY = safeNumber(part.chainBend?.[1] ?? 0, 0) * (mirrored ? -1 : 1);
      const bendZ = safeNumber(part.chainBend?.[2] ?? 0, 0) * (mirrored ? -1 : 1);
      let previous: Object3D = parent;
      for (let index = 0; index < chain; index += 1) {
        const pivot = new Group();
        pivot.name = index === 0 ? name : `${name}-${index}`;
        if (index === 0) {
          pivot.position.set(px, py, pz);
          /* Only the root segment carries the authored rotation; each later
           * segment adds the gentle chainBend so the tail can curl. */
          pivot.rotation.set(rotX, rotY, rotZ);
        } else {
          pivot.position.set(0, -segmentLength, 0);
          pivot.rotation.set(bendX, bendY, bendZ);
        }
        previous.add(pivot);
        const mesh = new Mesh(geometry, chosen.material);
        mesh.name = `${name}-segment-${index}`;
        mesh.position.set(0, -segmentLength / 2, 0);
        mesh.scale.set(scale[0], scale[1], scale[2]);
        pivot.add(mesh);
        addTeamMesh(mesh, chosen.team);
        if (part.outline === true) addOutline(mesh);
        if (part.anim !== undefined) anims.push(makeAnimState(pivot, part.anim));
        previous = pivot;
      }

      if (part.chainTip !== undefined) {
        const tipChosen = materialFor(part.chainTip.color, false);
        const tip = new Mesh(geometryFor(store, part.chainTip.prim, lowDetail), tipChosen.material);
        tip.name = `${name}-tip`;
        tip.position.set(0, -segmentLength, 0);
        previous.add(tip);
        addTeamMesh(tip, tipChosen.team);
      }
      return;
    }

    if (part.anchor === 'base') {
      /* 'base' pivots at the bottom of the primitive (spikes, wings, beards)
       * so rotations and animations swing it from its root, not its middle. */
      const pivot = new Group();
      pivot.name = name;
      pivot.position.set(px, py, pz);
      pivot.rotation.set(rotX, rotY, rotZ);
      parent.add(pivot);
      const mesh = new Mesh(geometry, chosen.material);
      mesh.name = `${name}-mesh`;
      mesh.position.set(0, (primitiveLength(part.prim) * scale[1]) / 2, 0);
      mesh.scale.set(scale[0], scale[1], scale[2]);
      pivot.add(mesh);
      addTeamMesh(mesh, chosen.team);
      if (part.outline === true) addOutline(mesh);
      if (part.anim !== undefined) anims.push(makeAnimState(pivot, part.anim));
      return;
    }

    const mesh = new Mesh(geometry, chosen.material);
    mesh.name = name;
    mesh.position.set(px, py, pz);
    mesh.rotation.set(rotX, rotY, rotZ);
    mesh.scale.set(scale[0], scale[1], scale[2]);
    parent.add(mesh);
    addTeamMesh(mesh, chosen.team);
    if (part.outline === true) addOutline(mesh);
    if (part.anim !== undefined) anims.push(makeAnimState(mesh, part.anim));
  }

  const overridden = new Set<TeamSlot>();
  for (let i = 0; i < def.parts.length; i += 1) {
    const part = def.parts[i];
    if (part !== undefined && part.slot !== undefined) overridden.add(part.slot);
  }

  /* Team-slot defaults anchored to the body that was actually built. The scarf
   * wraps the neck and the belt wraps the torso at its own height, so neither
   * band reads as a floating pool float. */
  const neckRadius = clamp(
    Math.min(headRadius * Math.max(headScale[0], headScale[2]), bodyWidth * 0.5) * NECK_WIDTH_FACTOR,
    MIN_NECK_RADIUS,
    MAX_NECK_RADIUS,
  );
  const scarfRadius = neckRadius + SCARF_GAP;
  /* A box head has a flat underside that reaches further down than a sphere;
   * the collar drops below it so the face stays clear. */
  const scarfY =
    bodyDef.headShape === 'box' ? headBottomY - SCARF_TUBE - SCARF_BOX_DROP : headBottomY + 0.02;
  const beltY = torsoBottomY + BELT_LIFT;
  const beltRadius = Math.max(0.12, torsoRadiusAt(beltY) + 0.01);

  const defaultScarf: PartDef = {
    id: 'default-scarf',
    prim: { t: 'torus', R: scarfRadius, r: SCARF_TUBE },
    attach: 'torso',
    pos: [0, scarfY, 0],
    rot: [Math.PI / 2, 0, 0],
    color: 'team',
    outline: false,
  };
  buildPart(defaultScarf, false);

  if (!overridden.has('scarfTail')) {
    for (const side of [-1, 1]) {
      buildPart(
        {
          id: side < 0 ? 'default-scarfTail-L' : 'default-scarfTail-R',
          prim: { t: 'box', w: 0.1, h: 0.32, d: 0.05 },
          attach: 'torso',
          pos: [side * 0.07, scarfY - 0.02, torsoBackZ + 0.01],
          rot: [-0.3, 0, 0],
          color: 'team',
          anim: { k: 'flutter', amp: 0.3, hz: 9 },
        },
        false,
      );
    }
  }

  if (!overridden.has('backCrest')) {
    buildPart(
      {
        id: 'default-backCrest',
        prim: { t: 'cylinder', rTop: 0.15, rBot: 0.15, h: 0.02 },
        attach: 'torso',
        pos: [0, torsoCenterY + CREST_LIFT, torsoBackZ + 0.01],
        rot: [Math.PI / 2, 0, 0],
        color: 'team',
      },
      false,
    );
  }

  if (!overridden.has('belt')) {
    buildPart(
      {
        id: 'default-belt',
        prim: { t: 'torus', R: beltRadius, r: BELT_TUBE },
        attach: 'hip',
        pos: [0, beltY, 0],
        rot: [Math.PI / 2, 0, 0],
        color: 'team',
      },
      false,
    );
    buildPart(
      {
        id: 'default-beltKnot',
        prim: { t: 'box', w: 0.12, h: BELT_KNOT_HEIGHT, d: 0.07 },
        attach: 'hip',
        pos: [0, beltY, beltRadius],
        color: 'teamDark',
      },
      false,
    );
  }

  if (!overridden.has('headBand')) {
    if (bodyDef.headShape === 'box') {
      buildPart(
        {
          id: 'default-headBand',
          prim: {
            t: 'box',
            w: headRadius * 2 * headScale[0] + 0.02,
            h: Math.max(0.04, headRadius * headScaleY * 0.18),
            d: headRadius * 2 * headScale[2] + 0.02,
          },
          attach: 'head',
          pos: [0, headCenterY + HEADBAND_LIFT, 0],
          color: 'team',
        },
        false,
      );
    } else {
      buildPart(
        {
          id: 'default-headBand',
          prim: { t: 'torus', R: headRadius * 1.02, r: 0.045 },
          attach: 'head',
          pos: [0, headCenterY + HEADBAND_LIFT, 0],
          rot: [Math.PI / 2, 0, 0],
          scale: [headScale[0], headScale[2], 1],
          color: 'team',
        },
        false,
      );
    }
  }

  for (let i = 0; i < def.parts.length; i += 1) {
    const part = def.parts[i];
    if (part === undefined) continue;
    buildPart(part, false);
    if (part.mirror === true) buildPart(part, true);
  }

  /* Optional detail is budgeted in priority order: eye sparkles, then the
   * crown hull, then the small secondary glints. Everything here happens at
   * build time, never inside update(). */
  let detailBudget = MAX_CHARACTER_MESHES - countMeshesIn(root);

  if (!lowDetail && detailBudget > 0) {
    for (let i = 0; i < highlightSlots.length && detailBudget > 0; i += 1) {
      const slot = highlightSlots[i];
      if (slot === undefined) continue;
      const primary = new Mesh(geometryFor(store, { t: 'sphere', r: HIGHLIGHT_RADIUS }, lowDetail), highlightMaterial);
      primary.name = slot.side < 0 ? 'highlight-L' : 'highlight-R';
      primary.position.set(slot.x, slot.y, slot.z);
      headPivot.add(primary);
      highlightMeshes.push(primary);
      highlightBaseX.push(primary.scale.x);
      highlightBaseY.push(primary.scale.y);
      highlightBaseZ.push(primary.scale.z);
      detailBudget -= 1;
    }

    if (detailBudget > 0) {
      /* The crown hull is a sibling so the named head keeps its exact template
       * height (the hull grows 6% but must not lift the silhouette). */
      const headOutline = new Mesh(headMesh.geometry, outlineFor(store));
      headOutline.name = 'head-outline';
      headOutline.position.copy(headMesh.position);
      headOutline.rotation.copy(headMesh.rotation);
      headOutline.scale.copy(headMesh.scale).multiplyScalar(OUTLINE_SCALE);
      headPivot.add(headOutline);
      detailBudget -= 1;
    }

    for (let i = 0; i < highlightSlots.length && detailBudget > 0; i += 1) {
      const slot = highlightSlots[i];
      if (slot === undefined) continue;
      const secondary = new Mesh(
        geometryFor(store, { t: 'sphere', r: HIGHLIGHT_SMALL_RADIUS }, lowDetail),
        highlightMaterial,
      );
      secondary.name = slot.side < 0 ? 'highlight-small-L' : 'highlight-small-R';
      secondary.position.set(slot.x + HIGHLIGHT_SMALL_X, slot.y + HIGHLIGHT_SMALL_Y, slot.z);
      headPivot.add(secondary);
      highlightMeshes.push(secondary);
      highlightBaseX.push(secondary.scale.x);
      highlightBaseY.push(secondary.scale.y);
      highlightBaseZ.push(secondary.scale.z);
      detailBudget -= 1;
    }
  }

  /* ---------- expression / blink state ---------- */

  const headBaseRotZ = headPivot.rotation.z;
  const blinkPeriod = BLINK_MIN_PERIOD + hash01(opts.seed) * BLINK_PERIOD_SPAN;
  const blinkOffset = hash01(opts.seed + 1013904223) * blinkPeriod;
  let squint = 0;
  let browTilt = 0;
  let mouthOpen = 0;

  function update(input: CharacterAnimInput): void {
    const time = safeNumber(input.time, 0);
    const dt = Number.isFinite(input.dtSec) && input.dtSec > 0 ? input.dtSec : 0;
    const run = clamp01(Number.isFinite(input.run) ? input.run : 0);
    const airborne = input.airborne === true;

    for (let i = 0; i < anims.length; i += 1) {
      const anim = anims[i];
      if (anim === undefined) continue;
      let rotX = anim.baseRotX;
      let rotY = anim.baseRotY;
      let rotZ = anim.baseRotZ;
      let scaleX = anim.baseScaleX;
      let scaleY = anim.baseScaleY;
      let scaleZ = anim.baseScaleZ;

      switch (anim.kind) {
        case 'flutter': {
          const wave = Math.sin(time * anim.hz);
          rotX += wave * anim.amp;
          rotY += Math.sin(time * anim.hz + 0.7) * anim.amp * 0.35;
          break;
        }
        case 'swing': {
          const swing = Math.sin((time - anim.lag) * RUN_FREQUENCY) * anim.amp * (0.18 + 0.82 * run);
          rotX += swing;
          rotY += swing * 0.25;
          break;
        }
        case 'wag': {
          const wave = Math.sin(time * anim.hz) * anim.amp;
          if (anim.axis === 'x') rotX += wave;
          else if (anim.axis === 'y') rotY += wave;
          else rotZ += wave;
          break;
        }
        case 'spin': {
          const speed = anim.idle + (anim.run - anim.idle) * run;
          const angle = time * speed;
          if (anim.axis === 'x') rotX += angle;
          else if (anim.axis === 'y') rotY += angle;
          else rotZ += angle;
          break;
        }
        case 'flap': {
          const hz = airborne ? anim.hzAir : anim.hzIdle;
          const amplitude = anim.amp * (airborne ? 1 : 0.35);
          rotZ += Math.sin(time * hz) * amplitude;
          break;
        }
        case 'pulse': {
          const factor = anim.from + (anim.to - anim.from) * (0.5 + 0.5 * Math.sin(time * anim.hz));
          scaleX = anim.baseScaleX * factor;
          scaleY = anim.baseScaleY * factor;
          scaleZ = anim.baseScaleZ * factor;
          break;
        }
      }

      anim.target.rotation.set(
        safeNumber(rotX, anim.baseRotX),
        safeNumber(rotY, anim.baseRotY),
        safeNumber(rotZ, anim.baseRotZ),
      );
      anim.target.scale.set(
        safeNumber(scaleX, anim.baseScaleX),
        safeNumber(scaleY, anim.baseScaleY),
        safeNumber(scaleZ, anim.baseScaleZ),
      );
    }

    const target = expressionTargets(input.expression);
    const blend = dt > 0 ? Math.min(1, dt * EXPRESSION_LERP_SPEED) : 0;
    squint += (target.squint - squint) * blend;
    browTilt += (target.browTilt - browTilt) * blend;
    mouthOpen += (target.mouthOpen - mouthOpen) * blend;
    squint = clamp01(squint);
    browTilt = clamp(browTilt, -1, 1);
    mouthOpen = clamp(mouthOpen, 0, 2);

    const blinkPhase = positiveModulo(time + blinkOffset, blinkPeriod);
    const blink = blinkPhase < BLINK_SECONDS ? BLINK_SCALE : 1;
    const eyeScaleY = clamp01(1 - squint) * (1 + Math.max(0, -browTilt) * 0.15);
    for (let i = 0; i < eyeRoots.length; i += 1) {
      const eyeRoot = eyeRoots[i];
      if (eyeRoot === undefined) continue;
      eyeRoot.scale.y = safeNumber(eyeScaleY * blink, 1);
    }
    for (let i = 0; i < eyeMeshes.length; i += 1) {
      const eyeMesh = eyeMeshes[i];
      const baseY = eyeBaseScaleY[i];
      if (eyeMesh === undefined || baseY === undefined) continue;
      eyeMesh.scale.y = safeNumber(baseY * blink, baseY);
    }

    const irisScale = 1 + Math.max(0, -browTilt) * 0.2;
    for (let i = 0; i < irisMeshes.length; i += 1) {
      const iris = irisMeshes[i];
      const baseX = irisBaseX[i];
      const baseY = irisBaseY[i];
      const baseZ = irisBaseZ[i];
      if (iris === undefined || baseX === undefined || baseY === undefined || baseZ === undefined) continue;
      iris.scale.set(
        safeNumber(baseX * irisScale, baseX),
        safeNumber(baseY * irisScale, baseY),
        safeNumber(baseZ * irisScale, baseZ),
      );
    }
    const highlightScale = 1 + Math.max(0, -browTilt) * 0.6;
    for (let i = 0; i < highlightMeshes.length; i += 1) {
      const highlight = highlightMeshes[i];
      const baseX = highlightBaseX[i];
      const baseY = highlightBaseY[i];
      const baseZ = highlightBaseZ[i];
      if (highlight === undefined || baseX === undefined || baseY === undefined || baseZ === undefined) continue;
      highlight.scale.set(
        safeNumber(baseX * highlightScale, baseX),
        safeNumber(baseY * highlightScale, baseY),
        safeNumber(baseZ * highlightScale, baseZ),
      );
    }

    for (let i = 0; i < browMeshes.length; i += 1) {
      const brow = browMeshes[i];
      const side = browSides[i];
      const baseZ = browBaseZ[i];
      if (brow === undefined || side === undefined || baseZ === undefined) continue;
      brow.rotation.z = safeNumber(baseZ + side * browTilt * 0.25, baseZ);
    }

    headPivot.rotation.z = safeNumber(headBaseRotZ + Math.max(0, browTilt) * 0.15, headBaseRotZ);

    const wide = mouthOpen > 1.5;
    const open = !wide && mouthOpen > 0.5;
    mouthDefault.visible = !wide && !open;
    mouthO.visible = open;
    mouthWide.visible = wide;
  }

  function setFlash(strength: number): void {
    const value = Number.isFinite(strength) ? clamp01(strength) : 0;
    skinMaterial.emissive.setRGB(value, value, value);
    garbMaterial.emissive.setRGB(value, value, value);
  }

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    skinMaterial.dispose();
    garbMaterial.dispose();
    teamMaterial.dispose();
    teamDarkMaterial.dispose();
  }

  return {
    def,
    root,
    pivots: {
      body,
      head: headPivot,
      torso: torsoPivot,
      armL,
      armR,
      legL,
      legR,
      handR: handR.group,
    },
    teamMeshes,
    flashMaterials: [skinMaterial, garbMaterial],
    setTeamColor,
    setFlash,
    update,
    dispose,
  };
}

interface ExpressionTargets {
  squint: number;
  browTilt: number;
  mouthOpen: number;
}

const NEUTRAL_TARGET: ExpressionTargets = { squint: 0, browTilt: 0, mouthOpen: 0 };
const HURT_TARGET: ExpressionTargets = { squint: 0.65, browTilt: 1, mouthOpen: 1 };
const POWER_TARGET: ExpressionTargets = { squint: 0, browTilt: -1, mouthOpen: 2 };
const HAPPY_TARGET: ExpressionTargets = { squint: 0.75, browTilt: 0, mouthOpen: 2 };

/** Returns shared target records so the per-frame update stays allocation-free. */
function expressionTargets(expression: Expression): ExpressionTargets {
  switch (expression) {
    case 'hurt':
      return HURT_TARGET;
    case 'power':
      return POWER_TARGET;
    case 'happy':
      return HAPPY_TARGET;
    case 'neutral':
    default:
      return NEUTRAL_TARGET;
  }
}

function eyeStyleScale(style: CharacterFaceEye): [number, number, number] {
  switch (style) {
    case 'almond':
      return [1, 0.95, 0.45];
    case 'cat':
      return [1, 1.35, 0.45];
    case 'top':
      return [1, 1, 1];
    case 'sleepy':
      return [1, 0.5, 0.45];
    case 'disc':
      return [1, 1, 1];
    case 'huge':
      return [1.25, 1.45, 0.45];
    case 'round':
    default:
      return [1, 1.25, 0.45];
  }
}

type CharacterFaceEye = CharacterDef['face']['eye'];
