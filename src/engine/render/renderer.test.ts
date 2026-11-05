import { describe, expect, it } from 'vitest';
import { DataTexture, LinearFilter, RGFormat, UnsignedByteType } from 'three';
import type { SurfaceGrid } from '../../game/contracts';
import {
  computeRenderSize,
  createSurfaceCoverage,
  markCoverageForRestore,
  paintTextureSize,
  releaseRendererForReuse,
} from './renderer';

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
  const AUTO_MAX_PIXELS = 3_500_000;

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

  it('honours a tighter auto budget on a large desktop frame', () => {
    const size = computeRenderSize(2568, 1746, 1.5, AUTO_MAX_PIXELS);
    const pixels = size.width * size.height * size.pixelRatio * size.pixelRatio;
    expect(pixels).toBeLessThanOrEqual(AUTO_MAX_PIXELS + 1);
    expect(size.pixelRatio).toBeLessThan(1);
    // The explicit high setting keeps its 2.0 ceiling under the default budget.
    const high = computeRenderSize(2568, 1746, 2, MAX_PIXELS);
    expect(high.pixelRatio).toBeGreaterThan(size.pixelRatio);
  });

  it('stays finite for invalid input', () => {
    const size = computeRenderSize(Number.NaN, Number.POSITIVE_INFINITY, Number.NaN);
    expect(size).toEqual({ width: 1, height: 1, pixelRatio: 1 });
    expect(Number.isFinite(computeRenderSize(-5, 0, -2).pixelRatio)).toBe(true);
    expect(Number.isFinite(computeRenderSize(800, 600, 1, Number.NaN).pixelRatio)).toBe(true);
  });
});

describe('createSurfaceCoverage', () => {
  it('uploads the initial RG coverage after converting the paint bytes', () => {
    const data = new Uint8Array([0, 1, 255, 255, 1, 0, 255, 255, 0, 0, 1, 1]);
    const surface = makeSurface({ data });
    const { texture, coverage } = createSurfaceCoverage(surface);

    expect(texture.image.data).toBe(coverage);
    expect(texture.image.width).toBe(4);
    expect(texture.image.height).toBe(3);
    expect(coverage).toHaveLength(4 * 3 * 2);
    expect(Array.from(coverage.slice(0, 8))).toEqual([
      255, 0,
      0, 255,
      0, 0,
      0, 0,
    ]);
    expect(texture.version).toBeGreaterThan(0);
    expect(texture.source.version).toBeGreaterThan(0);
  });

  it('never shares the simulation paint array with the GPU texture', () => {
    const surface = makeSurface();
    const { coverage } = createSurfaceCoverage(surface);

    expect(coverage).not.toBe(surface.data);
    expect(coverage.length).toBe(surface.data.length * 2);
  });

  it('marks every new coverage texture for upload independently', () => {
    const first = createSurfaceCoverage(makeSurface({ id: 1 }));
    const second = createSurfaceCoverage(
      makeSurface({ id: 2, w: 2, h: 2, data: new Uint8Array(4).fill(255) }),
    );

    expect(first.texture.version).toBe(1);
    expect(second.texture.version).toBe(1);
    expect(first.texture.source).not.toBe(second.texture.source);
    expect(first.coverage).not.toBe(second.coverage);
  });

  it('uses RG byte data with linear sampling, no mipmaps and byte alignment', () => {
    const { texture } = createSurfaceCoverage(makeSurface());

    expect(texture.format).toBe(RGFormat);
    expect(texture.minFilter).toBe(LinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    expect(texture.generateMipmaps).toBe(false);
    expect(texture.unpackAlignment).toBe(1);
  });

  it('clamps invalid grid dimensions to at least one texel', () => {
    expect(paintTextureSize(makeSurface({ w: Number.NaN, h: Number.POSITIVE_INFINITY }))).toEqual([
      1, 1,
    ]);
    expect(paintTextureSize(makeSurface({ w: -4, h: 0 }))).toEqual([1, 1]);
    expect(paintTextureSize(makeSurface({ w: 6.9, h: 2.2 }))).toEqual([6, 2]);
  });
});

describe('markCoverageForRestore', () => {
  function makeTexture(): DataTexture {
    return new DataTexture(new Uint8Array(2), 1, 1, RGFormat, UnsignedByteType);
  }

  it('re-flags every coverage texture so a restored context re-uploads it', () => {
    const first = makeTexture();
    const second = makeTexture();
    const firstVersion = first.version;
    const secondVersion = second.version;

    const count = markCoverageForRestore([{ texture: first }, { texture: second }]);

    expect(count).toBe(2);
    expect(first.version).toBe(firstVersion + 1);
    expect(second.version).toBe(secondVersion + 1);
  });

  it('accepts an empty set of textures', () => {
    expect(markCoverageForRestore([])).toBe(0);
  });
});

describe('releaseRendererForReuse', () => {
  it('disposes the renderer and clears its render lists for the next match', () => {
    const calls: string[] = [];

    releaseRendererForReuse({
      renderLists: {
        dispose: () => {
          calls.push('lists');
        },
      },
      dispose: () => {
        calls.push('renderer');
      },
    });

    expect(calls).toEqual(['renderer', 'lists']);
  });
});
