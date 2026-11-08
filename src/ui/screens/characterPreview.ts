import {
  Box3,
  DirectionalLight,
  Group,
  HemisphereLight,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
import type { Camera, DataTexture, Object3D } from 'three';
import { buildCharacter, createCharacterCache } from '../../engine/render/characters/builder';
import { getCharacter } from '../../engine/render/characters/defs';
import {
  DEFAULT_CHARACTER_ID,
  isCharacterId,
} from '../../engine/render/characters/roster';
import type {
  CharacterAssetCache,
  CharacterRig,
} from '../../engine/render/characters/types';
import { createToonGradient } from '../../engine/render/toon';

const TEAM_COLOR = 0xff8a1f;
const TURN_SPEED = 0.6;
const TAU = Math.PI * 2;
const CAMERA_FOV = 35;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 100;
const MAX_PIXEL_RATIO = 2;
const MAX_FRAME_SECONDS = 0.1;
const SEED = 17;

/** Full body occupies this share of the preview canvas height. */
const PREVIEW_FILL = 0.85;
/** Slightly off the -Z axis so the face reads as a three-quarter view. */
const PREVIEW_YAW = 0.42;
const PREVIEW_PITCH = 0.1;

/** Head-and-shoulders portrait for the roster cards. */
const ICON_PORTION = 0.55;
const ICON_FILL = 0.94;
const ICON_YAW = 0;
const ICON_PITCH = 0.05;
const ICON_MIN_PIXELS = 16;
const ICON_FALLBACK_SIZE = 64;
const ICON_MAX_SIZE = 1024;
const MIN_EXTENT = 0.01;
const MIN_DISTANCE = 0.4;
const MAX_DISTANCE = 60;
const DEG_TO_RAD = Math.PI / 180;
const DATA_PNG_PREFIX = 'data:image/png;base64,';

/** The tiny subset of a renderer the preview actually needs. Easy to fake in tests. */
export interface PreviewRenderer {
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
}

export interface CharacterPreviewOptions {
  /** Test hook; production uses a private WebGLRenderer. */
  createRenderer?: (canvas: HTMLCanvasElement) => PreviewRenderer;
}

export interface IconRenderOptions {
  /** Test hook; production uses a private offscreen WebGLRenderer. */
  createRenderer?: (canvas: HTMLCanvasElement) => PreviewRenderer;
  /** Test hook; production uses a detached canvas element. */
  createCanvas?: () => HTMLCanvasElement;
}

export interface CharacterPreview {
  /** Rebuilds the visible rig for the given roster id. Unknown ids fall back. */
  show(id: string): void;
  /** Freezes the turntable and shows the character's back (+Z) to the camera. */
  setBack(back: boolean): void;
  /** Renders head-and-shoulders PNG data URLs for the roster cards. */
  renderIcons(ids: readonly string[], size: number, opts?: IconRenderOptions): Map<string, string>;
  dispose(): void;
}

/* ------------------------------------------------------------------ */
/* Pure framing math (no DOM, no GPU, easy to test)                    */
/* ------------------------------------------------------------------ */

export type Vec3 = readonly [number, number, number];

export interface FramingBox {
  center: Vec3;
  size: Vec3;
}

export interface FramingOptions {
  /** Canvas aspect ratio (width / height). Defaults to 1. */
  aspect?: number;
  fovDegrees?: number;
  /** Share of the viewport the box should cover, 0..1. */
  fill?: number;
  /** Rotation around the target, measured from -Z toward +X. 0 is a front view. */
  yaw?: number;
  /** Camera elevation above the target in radians. */
  pitch?: number;
}

export interface Framing {
  position: readonly [number, number, number];
  target: readonly [number, number, number];
  distance: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Places a camera so the given box fills `fill` of the viewport, on the -Z
 * side by default (characters face -Z). Always returns finite numbers.
 */
export function frameCharacter(box: FramingBox, opts: FramingOptions = {}): Framing {
  const centerX = finiteOr(box.center[0], 0);
  const centerY = finiteOr(box.center[1], 0.8);
  const centerZ = finiteOr(box.center[2], 0);
  const sizeX = Math.max(MIN_EXTENT, Math.abs(finiteOr(box.size[0], 0.6)));
  const sizeY = Math.max(MIN_EXTENT, Math.abs(finiteOr(box.size[1], 1.6)));
  const sizeZ = Math.max(MIN_EXTENT, Math.abs(finiteOr(box.size[2], 0.6)));

  const aspect = clamp(finiteOr(opts.aspect ?? 1, 1), 0.1, 12);
  const fovDegrees = clamp(finiteOr(opts.fovDegrees ?? CAMERA_FOV, CAMERA_FOV), 10, 110);
  const fill = clamp(finiteOr(opts.fill ?? PREVIEW_FILL, PREVIEW_FILL), 0.2, 1);
  const yaw = finiteOr(opts.yaw ?? PREVIEW_YAW, PREVIEW_YAW);
  const pitch = clamp(finiteOr(opts.pitch ?? PREVIEW_PITCH, PREVIEW_PITCH), -1.2, 1.2);

  const tanHalfFov = Math.tan(fovDegrees * DEG_TO_RAD * 0.5);
  const vertical = sizeY / (2 * tanHalfFov * fill);
  const horizontal = sizeX / (2 * tanHalfFov * aspect * fill);
  const distance = clamp(
    Math.max(vertical, horizontal) + sizeZ * 0.5,
    MIN_DISTANCE,
    MAX_DISTANCE,
  );

  const cosPitch = Math.cos(pitch);
  const offsetX = Math.sin(yaw) * cosPitch * distance;
  const offsetY = Math.sin(pitch) * distance;
  const offsetZ = -Math.cos(yaw) * cosPitch * distance;

  return {
    position: [centerX + offsetX, centerY + offsetY, centerZ + offsetZ],
    target: [centerX, centerY, centerZ],
    distance,
  };
}

/**
 * Takes the top slice of a body box (head and shoulders for 0.55) so the icon
 * camera can frame the face instead of the whole silhouette.
 */
export function headAndShouldersBox(box: FramingBox, portion = ICON_PORTION): FramingBox {
  const centerX = finiteOr(box.center[0], 0);
  const centerY = finiteOr(box.center[1], 0.8);
  const centerZ = finiteOr(box.center[2], 0);
  const height = Math.max(MIN_EXTENT, Math.abs(finiteOr(box.size[1], 1.6)));
  const width = Math.max(MIN_EXTENT, Math.abs(finiteOr(box.size[0], 0.6)));
  const depth = Math.max(MIN_EXTENT, Math.abs(finiteOr(box.size[2], 0.6)));
  const slicePortion = clamp(finiteOr(portion, ICON_PORTION), 0.1, 1);
  const sliceHeight = height * slicePortion;
  const top = centerY + height * 0.5;

  return {
    center: [centerX, top - sliceHeight * 0.5, centerZ],
    size: [width, sliceHeight, depth],
  };
}

/** Box3 -> the plain tuple shape the framing helpers take. */
export function boxToFraming(box: Box3): FramingBox {
  return {
    center: [box.min.x * 0.5 + box.max.x * 0.5, box.min.y * 0.5 + box.max.y * 0.5, box.min.z * 0.5 + box.max.z * 0.5],
    size: [
      Math.abs(box.max.x - box.min.x),
      Math.abs(box.max.y - box.min.y),
      Math.abs(box.max.z - box.min.z),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function createDefaultRenderer(canvas: HTMLCanvasElement): PreviewRenderer {
  return new WebGLRenderer({ canvas, alpha: true, antialias: true });
}

function createIconRenderer(canvas: HTMLCanvasElement): PreviewRenderer {
  return new WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
}

function createDefaultCanvas(): HTMLCanvasElement {
  return document.createElement('canvas');
}

function nowSeconds(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return 0;
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return 0;
}

function cancelFrame(id: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(id);
  }
}

function safePixelRatio(): number {
  const raw = typeof globalThis.devicePixelRatio === 'number' ? globalThis.devicePixelRatio : 1;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(MAX_PIXEL_RATIO, Math.max(0.5, raw));
}

function canvasWidth(canvas: HTMLCanvasElement): number {
  const width = canvas.clientWidth > 0 ? canvas.clientWidth : canvas.width;
  return Number.isFinite(width) && width > 0 ? width : 1;
}

function canvasHeight(canvas: HTMLCanvasElement): number {
  const height = canvas.clientHeight > 0 ? canvas.clientHeight : canvas.height;
  return Number.isFinite(height) && height > 0 ? height : 1;
}

function iconPixelSize(size: number): number {
  const requested = Number.isFinite(size) && size > 0 ? size : ICON_FALLBACK_SIZE;
  const scaled = Math.round(requested * safePixelRatio());
  return clamp(scaled, ICON_MIN_PIXELS, ICON_MAX_SIZE);
}

function resolveId(id: string): string {
  return isCharacterId(id) ? id : DEFAULT_CHARACTER_ID;
}

/* ------------------------------------------------------------------ */
/* Icon rendering                                                      */
/* ------------------------------------------------------------------ */

/**
 * Renders one head-and-shoulders portrait per roster id into PNG data URLs.
 * Uses its own short-lived offscreen renderer and cache, and disposes both.
 * Returns an empty map when WebGL or the canvas is unavailable so the cards
 * keep working with names only.
 */
export function renderCharacterIcons(
  ids: readonly string[],
  size: number,
  opts: IconRenderOptions = {},
): Map<string, string> {
  const icons = new Map<string, string>();
  if (ids.length === 0) return icons;

  const pixels = iconPixelSize(size);

  let canvas: HTMLCanvasElement | null = null;
  let renderer: PreviewRenderer | null = null;
  let gradient: DataTexture | null = null;
  let cache: CharacterAssetCache | null = null;
  let rig: CharacterRig | null = null;

  try {
    canvas = (opts.createCanvas ?? createDefaultCanvas)();
    canvas.width = pixels;
    canvas.height = pixels;
    renderer = (opts.createRenderer ?? createIconRenderer)(canvas);
    renderer.setPixelRatio(1);
    renderer.setSize(pixels, pixels, false);

    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x9aa0c8, 1.7));

    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(1.4, 2.6, -3);
    scene.add(key);

    const fill = new DirectionalLight(0xffe0b0, 0.75);
    fill.position.set(-1.8, 1.2, 2);
    scene.add(fill);

    gradient = createToonGradient();
    cache = createCharacterCache();

    const camera = new PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    const rendered = new Set<string>();

    for (const rawId of ids) {
      if (typeof rawId !== 'string' || rendered.has(rawId)) continue;
      rendered.add(rawId);
      if (renderer === null || canvas === null || gradient === null || cache === null) break;

      const def = getCharacter(resolveId(rawId));
      rig = buildCharacter(def, {
        gradient,
        teamColor: TEAM_COLOR,
        lowDetail: false,
        cache,
        seed: SEED,
      });
      scene.add(rig.root);
      rig.update({ time: 0, dtSec: 0, run: 0, airborne: false, expression: 'neutral' });

      const head = headAndShouldersBox(boxToFraming(new Box3().setFromObject(rig.root)));
      const framing = frameCharacter(head, {
        aspect: 1,
        fill: ICON_FILL,
        yaw: ICON_YAW,
        pitch: ICON_PITCH,
      });
      camera.position.set(framing.position[0], framing.position[1], framing.position[2]);
      camera.lookAt(framing.target[0], framing.target[1], framing.target[2]);
      camera.updateMatrixWorld();

      renderer.render(scene, camera);
      const url = canvas.toDataURL('image/png');
      if (typeof url === 'string' && url.startsWith(DATA_PNG_PREFIX) && url.length > DATA_PNG_PREFIX.length) {
        icons.set(rawId, url);
      }

      scene.remove(rig.root);
      rig.dispose();
      rig = null;
    }
  } catch {
    icons.clear();
  } finally {
    if (rig !== null) {
      rig.dispose();
      rig = null;
    }
    cache?.dispose();
    gradient?.dispose();
    renderer?.dispose();
  }

  return icons;
}

/* ------------------------------------------------------------------ */
/* Live preview                                                        */
/* ------------------------------------------------------------------ */

/**
 * Small self-contained turntable for one character. The preview owns its own
 * renderer, scene, light rig, material cache and toon ramp, so disposing it
 * leaves nothing behind. WebGL failures hide the canvas instead of throwing.
 */
export function createCharacterPreview(
  canvas: HTMLCanvasElement,
  opts: CharacterPreviewOptions = {},
): CharacterPreview {
  let renderer: PreviewRenderer | null = null;
  try {
    renderer = (opts.createRenderer ?? createDefaultRenderer)(canvas);
  } catch {
    // No WebGL: hide the preview; the surrounding card grid keeps working.
    canvas.hidden = true;
    return {
      show: (): void => {
        /* preview unavailable */
      },
      setBack: (): void => {
        /* preview unavailable */
      },
      renderIcons: (): Map<string, string> => new Map<string, string>(),
      dispose: (): void => {
        /* nothing was created */
      },
    };
  }

  const scene = new Scene();
  const camera = new PerspectiveCamera(CAMERA_FOV, 1, CAMERA_NEAR, CAMERA_FAR);

  const turntable = new Group();
  turntable.name = 'character-turntable';
  let angle = 0;
  turntable.rotation.y = angle;
  scene.add(turntable);

  const sky = new HemisphereLight(0xffffff, 0x9aa0c8, 1.5);
  scene.add(sky);

  const key = new DirectionalLight(0xffffff, 2.2);
  key.position.set(2.5, 4, -3);
  scene.add(key);

  const rim = new DirectionalLight(0xffe0b0, 0.7);
  rim.position.set(-2, 2.5, 3);
  scene.add(rim);

  const gradient: DataTexture = createToonGradient();
  const cache: CharacterAssetCache = createCharacterCache();

  let rig: CharacterRig | null = null;
  let rafId: number | null = null;
  let disposed = false;
  let back = false;
  let elapsed = 0;
  let lastTimestamp: number | null = null;
  let lastWidth = -1;
  let lastHeight = -1;
  let lastRatio = -1;
  let frameBox: FramingBox | null = null;

  function applyCamera(): void {
    const box = frameBox ?? { center: [0, 0.8, 0], size: [0.6, 1.6, 0.6] };
    const framing = frameCharacter(box, {
      aspect: camera.aspect,
      fill: PREVIEW_FILL,
      yaw: PREVIEW_YAW,
      pitch: PREVIEW_PITCH,
    });
    camera.position.set(framing.position[0], framing.position[1], framing.position[2]);
    camera.lookAt(framing.target[0], framing.target[1], framing.target[2]);
    camera.updateMatrixWorld();
  }

  function resize(): void {
    if (renderer === null) return;
    const width = canvasWidth(canvas);
    const height = canvasHeight(canvas);
    const ratio = safePixelRatio();
    if (width === lastWidth && height === lastHeight && ratio === lastRatio) return;
    lastWidth = width;
    lastHeight = height;
    lastRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    applyCamera();
  }

  function disposeRig(): void {
    if (rig === null) return;
    turntable.remove(rig.root);
    rig.dispose();
    rig = null;
  }

  function frame(timestamp: number): void {
    if (disposed || renderer === null) return;
    rafId = requestFrame(frame);

    const stamp = Number.isFinite(timestamp) ? timestamp : nowSeconds();
    if (lastTimestamp === null) lastTimestamp = stamp;
    const deltaMs = Math.min(MAX_FRAME_SECONDS * 1000, Math.max(0, stamp - lastTimestamp));
    lastTimestamp = stamp;
    const dt = deltaMs / 1000;

    if (!back) {
      angle = (angle + TURN_SPEED * dt) % TAU;
      turntable.rotation.y = angle;
    }

    if (rig !== null) {
      elapsed += dt;
      rig.update({ time: elapsed, dtSec: dt, run: 0, airborne: false, expression: 'neutral' });
    }

    resize();
    renderer.render(scene, camera);
  }

  function show(id: string): void {
    if (disposed) return;
    disposeRig();
    const def = getCharacter(resolveId(id));
    rig = buildCharacter(def, {
      gradient,
      teamColor: TEAM_COLOR,
      lowDetail: false,
      cache,
      seed: SEED,
    });
    turntable.add(rig.root);
    rig.root.updateMatrixWorld(true);
    frameBox = boxToFraming(new Box3().setFromObject(rig.root));
    applyCamera();
  }

  function setBack(value: boolean): void {
    if (disposed) return;
    back = value === true;
    if (back) {
      angle = Math.PI;
      turntable.rotation.y = angle;
    }
  }

  function renderIcons(
    ids: readonly string[],
    size: number,
    iconOpts?: IconRenderOptions,
  ): Map<string, string> {
    if (disposed) return new Map<string, string>();
    return renderCharacterIcons(ids, size, iconOpts);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    if (rafId !== null) {
      cancelFrame(rafId);
      rafId = null;
    }
    disposeRig();
    cache.dispose();
    gradient.dispose();
    if (renderer !== null) {
      renderer.dispose();
      renderer = null;
    }
  }

  resize();
  applyCamera();
  rafId = requestFrame(frame);

  return { show, setBack, renderIcons, dispose };
}
