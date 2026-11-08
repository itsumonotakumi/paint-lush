// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Box3, Mesh } from 'three';
import type { Object3D } from 'three';
import { buildCharacter, createCharacterCache } from '../../engine/render/characters/builder';
import { CHARACTERS } from '../../engine/render/characters/defs';
import { createToonGradient } from '../../engine/render/toon';
import {
  boxToFraming,
  createCharacterPreview,
  frameCharacter,
  headAndShouldersBox,
  renderCharacterIcons,
} from './characterPreview';
import type { PreviewRenderer } from './characterPreview';

interface RendererCalls {
  pixelRatios: number[];
  sizes: Array<[number, number, boolean | undefined]>;
  renders: number;
  meshesPerRender: number[];
  disposed: number;
  lastScene: Object3D | null;
}

interface FakeRenderer {
  renderer: PreviewRenderer;
  calls: RendererCalls;
}

function makeRenderer(): FakeRenderer {
  const calls: RendererCalls = {
    pixelRatios: [],
    sizes: [],
    renders: 0,
    meshesPerRender: [],
    disposed: 0,
    lastScene: null,
  };
  const renderer: PreviewRenderer = {
    setPixelRatio(value: number): void {
      calls.pixelRatios.push(value);
    },
    setSize(width: number, height: number, updateStyle?: boolean): void {
      calls.sizes.push([width, height, updateStyle]);
    },
    render(scene: Object3D): void {
      calls.renders += 1;
      calls.lastScene = scene;
      let meshes = 0;
      scene.traverse((child) => {
        if (child instanceof Mesh) meshes += 1;
      });
      calls.meshesPerRender.push(meshes);
    },
    dispose(): void {
      calls.disposed += 1;
    },
  };
  return { renderer, calls };
}

function makeCanvas(width = 240, height = 180): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  Object.defineProperty(canvas, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(canvas, 'clientHeight', { value: height, configurable: true });
  return canvas;
}

let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
let requestCount: number;
let cancelledIds: number[];

function runFrame(timestamp: number): void {
  const entry = frames.entries().next();
  if (entry.done === true) throw new Error('no animation frame was scheduled');
  const [id, callback] = entry.value;
  frames.delete(id);
  callback(timestamp);
}

beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  requestCount = 0;
  cancelledIds = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextFrameId;
    nextFrameId += 1;
    requestCount += 1;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    cancelledIds.push(id);
    frames.delete(id);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('createCharacterPreview', () => {
  it('owns the renderer, sizes it and draws animated frames', () => {
    const canvas = makeCanvas();
    const { renderer, calls } = makeRenderer();
    const preview = createCharacterPreview(canvas, { createRenderer: () => renderer });

    expect(calls.sizes[0]?.[0]).toBe(240);
    expect(calls.sizes[0]?.[1]).toBe(180);
    expect(requestCount).toBe(1);

    preview.show('komomo');
    preview.show('gonta');

    runFrame(0);
    expect(calls.renders).toBe(1);
    expect(calls.lastScene).not.toBeNull();
    expect(requestCount).toBe(2);

    preview.dispose();
  });

  it('frames the character and faces the front before turning', () => {
    const canvas = makeCanvas();
    const { renderer, calls } = makeRenderer();
    const preview = createCharacterPreview(canvas, { createRenderer: () => renderer });

    preview.show('hayate');
    runFrame(0);

    const turntable = calls.lastScene?.getObjectByName('character-turntable');
    expect(turntable).toBeDefined();
    expect(turntable?.rotation.y).toBeCloseTo(0, 5);

    preview.dispose();
  });

  it('freezes facing the back when setBack is true', () => {
    const canvas = makeCanvas();
    const { renderer, calls } = makeRenderer();
    const preview = createCharacterPreview(canvas, { createRenderer: () => renderer });

    preview.show('kuroha');
    preview.setBack(true);
    runFrame(0);
    runFrame(600);

    const turntable = calls.lastScene?.getObjectByName('character-turntable');
    expect(turntable?.rotation.y).toBeCloseTo(Math.PI, 5);

    preview.setBack(false);
    runFrame(700);
    expect(turntable?.rotation.y).toBeGreaterThan(Math.PI);

    preview.dispose();
  });

  it('caps the pixel ratio and cancels its animation frame on dispose', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const canvas = makeCanvas();
    const { renderer, calls } = makeRenderer();
    const preview = createCharacterPreview(canvas, { createRenderer: () => renderer });

    expect(calls.pixelRatios[0]).toBe(2);
    expect(cancelledIds).toHaveLength(0);

    preview.dispose();
    expect(cancelledIds).toHaveLength(1);
    expect(frames.size).toBe(0);
    expect(calls.disposed).toBe(1);

    preview.dispose();
    expect(calls.disposed).toBe(1);
    expect(cancelledIds).toHaveLength(1);
  });

  it('stops rendering when a stale frame callback runs after dispose', () => {
    const canvas = makeCanvas();
    const { renderer, calls } = makeRenderer();
    const preview = createCharacterPreview(canvas, { createRenderer: () => renderer });
    preview.show('mame');

    const pending = frames.values().next();
    expect(pending.done).toBe(false);
    preview.dispose();
    if (pending.done === false) pending.value(1000);

    expect(calls.renders).toBe(0);
    expect(requestCount).toBe(1);
  });

  it('fails silently and hides the canvas when WebGL is unavailable', () => {
    const canvas = makeCanvas();
    const preview = createCharacterPreview(canvas, {
      createRenderer: () => {
        throw new Error('no webgl');
      },
    });

    expect(canvas.hidden).toBe(true);
    expect(requestCount).toBe(0);
    expect(() => {
      preview.show('hayate');
      preview.setBack(true);
      preview.dispose();
    }).not.toThrow();
    expect(preview.renderIcons(['hayate'], 64).size).toBe(0);
  });
});

function makeIconCanvas(url = 'data:image/png;base64,iVBORw0KGgo='): {
  canvas: HTMLCanvasElement;
  calls: () => number;
} {
  const canvas = document.createElement('canvas');
  let count = 0;
  Object.defineProperty(canvas, 'toDataURL', {
    configurable: true,
    value: (): string => {
      count += 1;
      return url;
    },
  });
  return { canvas, calls: () => count };
}

describe('frameCharacter', () => {
  it('returns finite front-side framing for every roster body', () => {
    const cache = createCharacterCache();
    const gradient = createToonGradient();

    for (const def of CHARACTERS) {
      const rig = buildCharacter(def, {
        gradient,
        teamColor: 0xff8a1f,
        lowDetail: true,
        cache,
        seed: 3,
      });
      try {
        const body = boxToFraming(new Box3().setFromObject(rig.root));
        expect(body.size[1], def.id).toBeGreaterThan(0.5);

        const full = frameCharacter(body, { aspect: 1.4 });
        const icon = frameCharacter(headAndShouldersBox(body), { aspect: 1, fill: 0.94 });

        for (const frame of [full, icon]) {
          for (const value of [...frame.position, ...frame.target, frame.distance]) {
            expect(Number.isFinite(value), def.id).toBe(true);
          }
          expect(frame.distance, def.id).toBeGreaterThan(0);
          // Characters face -Z, so the camera belongs on the -Z side.
          expect(frame.position[2], def.id).toBeLessThan(frame.target[2]);
        }

        // The icon frame aims at the head, above the body centre.
        expect(icon.target[1], def.id).toBeGreaterThan(body.center[1]);
      } finally {
        rig.dispose();
      }
    }

    cache.dispose();
    gradient.dispose();
  });

  it('keeps hostile boxes and options finite', () => {
    const frame = frameCharacter(
      {
        center: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
        size: [Number.NaN, -4, 0],
      },
      {
        aspect: 0,
        fovDegrees: Number.NaN,
        fill: Number.NaN,
        yaw: Number.NaN,
        pitch: Number.NaN,
      },
    );
    const head = headAndShouldersBox(
      { center: [Number.NaN, Number.NaN, Number.NaN], size: [Number.NaN, Number.NaN, Number.NaN] },
      Number.NaN,
    );
    const headFrame = frameCharacter(head);

    for (const value of [
      ...frame.position,
      ...frame.target,
      frame.distance,
      ...head.center,
      ...head.size,
      ...headFrame.position,
    ]) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('moves the camera back for taller bodies and smaller fills', () => {
    const base = frameCharacter({ center: [0, 0.8, 0], size: [0.6, 1.6, 0.6] });
    const taller = frameCharacter({ center: [0, 0.8, 0], size: [0.6, 3.2, 0.6] });
    const loose = frameCharacter({ center: [0, 0.8, 0], size: [0.6, 1.6, 0.6] }, { fill: 0.5 });

    expect(taller.distance).toBeGreaterThan(base.distance);
    expect(loose.distance).toBeGreaterThan(base.distance);
  });
});

describe('renderCharacterIcons', () => {
  it('renders one portrait per id and disposes its renderer', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { renderer, calls } = makeRenderer();
    const icon = makeIconCanvas();

    const icons = renderCharacterIcons(['hayate', 'komomo', 'hayate', 'ghost'], 64, {
      createRenderer: () => renderer,
      createCanvas: () => icon.canvas,
    });

    expect(icons.size).toBe(3);
    expect(icons.get('hayate')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(icons.get('ghost')).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(calls.renders).toBe(3);
    expect(calls.meshesPerRender.every((count) => count > 0)).toBe(true);
    expect(icon.calls()).toBe(3);

    // Rigs are removed from the scene before everything is torn down.
    let leftover = 0;
    calls.lastScene?.traverse((child) => {
      if (child instanceof Mesh) leftover += 1;
    });
    expect(leftover).toBe(0);

    expect(icon.canvas.width).toBe(128);
    expect(icon.canvas.height).toBe(128);
    expect(calls.pixelRatios).toEqual([1]);
    expect(calls.sizes).toEqual([[128, 128, false]]);
    expect(calls.disposed).toBe(1);
  });

  it('returns an empty map when WebGL is unavailable', () => {
    const icon = makeIconCanvas();
    const icons = renderCharacterIcons(['hayate', 'komomo'], 64, {
      createRenderer: () => {
        throw new Error('no webgl');
      },
      createCanvas: () => icon.canvas,
    });

    expect(icons.size).toBe(0);
    expect(icon.calls()).toBe(0);
  });

  it('drops canvases that do not yield a PNG data URL, still disposing', () => {
    const { renderer, calls } = makeRenderer();
    const icons = renderCharacterIcons(['hayate'], 32, {
      createRenderer: () => renderer,
      createCanvas: () => makeIconCanvas('about:blank').canvas,
    });

    expect(icons.size).toBe(0);
    expect(calls.disposed).toBe(1);
  });

  it('is exposed on the preview and stops after dispose', () => {
    const canvas = makeCanvas();
    const { renderer } = makeRenderer();
    const iconRenderer = makeRenderer();
    const preview = createCharacterPreview(canvas, { createRenderer: () => renderer });

    const icons = preview.renderIcons(['mame'], 32, {
      createRenderer: () => iconRenderer.renderer,
      createCanvas: () => makeIconCanvas().canvas,
    });
    expect(icons.size).toBe(1);
    expect(iconRenderer.calls.disposed).toBe(1);

    preview.dispose();
    expect(preview.renderIcons(['mame'], 32).size).toBe(0);
  });
});

