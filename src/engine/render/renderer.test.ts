import { describe, expect, it } from 'vitest';
import type { SurfaceGrid } from '../../game/contracts';
import { computeRenderSize, createSurfaceTexture, paintTextureSize } from './renderer';

function makeSurface(overrides: Partial<SurfaceGrid> = {}): SurfaceGrid {
  return {
    id: 1,
    boxIndex: 0,
    face: '+y',
    w: 4,
    h: 3,
    cellSize: 0.5,
    uLength: 2,
    vLength: 1.5,
    origin: { x: 0, y: 0, z: 0 },
    axisU: { x: 1, y: 0, z: 0 },
    axisV: { x: 0, y: 0, z: 1 },
    data: new Uint8Array(12).fill(255),
    ...overrides,
  };
}

describe('computeRenderSize', () => {
  const MAX_DIMENSION = 4096;
  const MAX_PIXELS = 16_000_000;

  it('leaves small frames at their requested ratio', () => {
    expect(computeRenderSize(800, 600, 1)).toEqual({ width: 800, height: 600, pixelRatio: 1 });
  });

  it('caps each side at 4096 while keeping the aspect ratio', () => {
    const size = computeRenderSize(8000, 4000, 3);
    expect(size.width).toBe(MAX_DIMENSION);
    expect(size.height).toBe(MAX_DIMENSION / 2);
    expect(size.width * size.pixelRatio).toBeLessThanOrEqual(MAX_DIMENSION + 1e-6);
    expect(size.height * size.pixelRatio).toBeLessThanOrEqual(MAX_DIMENSION + 1e-6);
    expect(size.pixelRatio).toBeGreaterThan(0);
  });

  it('reduces the pixel ratio until the buffer area fits 16 megapixels', () => {
    const size = computeRenderSize(4096, 4096, 2);
    const pixels = size.width * size.height * size.pixelRatio * size.pixelRatio;
    expect(pixels).toBeLessThanOrEqual(MAX_PIXELS + 1);
    expect(size.pixelRatio).toBeLessThan(1);
  });

  it('stays finite for invalid input', () => {
    const size = computeRenderSize(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    expect(size).toEqual({ width: 1, height: 1, pixelRatio: 1 });
    expect(Number.isFinite(computeRenderSize(-5, 0, -2).pixelRatio)).toBe(true);
  });
});

describe('createSurfaceTexture', () => {
  it('uploads the initial unpainted fill when the texture is created', () => {
    const surface = makeSurface();
    const texture = createSurfaceTexture(surface);

    expect(texture.image.data).toBe(surface.data);
    expect(texture.image.width).toBe(4);
    expect(texture.image.height).toBe(3);
    expect(texture.version).toBeGreaterThan(0);
    expect(texture.source.version).toBeGreaterThan(0);
    expect(Array.from(surface.data).every((value) => value === 255)).toBe(true);
  });

  it('marks every new texture for upload independently', () => {
    const first = createSurfaceTexture(makeSurface({ id: 1 }));
    const second = createSurfaceTexture(makeSurface({ id: 2, w: 2, h: 2, data: new Uint8Array(4).fill(255) }));

    expect(first.version).toBe(1);
    expect(second.version).toBe(1);
    expect(first.source).not.toBe(second.source);
  });

  it('uses nearest sampling with no mipmaps and byte alignment', () => {
    const texture = createSurfaceTexture(makeSurface());

    expect(texture.generateMipmaps).toBe(false);
    expect(texture.unpackAlignment).toBe(1);
    expect(texture.minFilter).toBe(texture.magFilter);
  });

  it('clamps invalid grid dimensions to at least one texel', () => {
    expect(paintTextureSize(makeSurface({ w: Number.NaN, h: Number.POSITIVE_INFINITY }))).toEqual([
      1, 1,
    ]);
    expect(paintTextureSize(makeSurface({ w: -4, h: 0 }))).toEqual([1, 1]);
    expect(paintTextureSize(makeSurface({ w: 6.9, h: 2.2 }))).toEqual([6, 2]);
  });
});
