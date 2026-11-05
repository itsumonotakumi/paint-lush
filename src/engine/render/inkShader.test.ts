import { describe, expect, it } from 'vitest';
import { DataTexture, RGFormat, UnsignedByteType, Vector3 } from 'three';
import {
  INK_FRAGMENT_SHADER,
  INK_VERTEX_SHADER,
  inkUniforms,
} from './inkShader';
import type { InkUniformArgs, InkUniforms } from './inkShader';

function makeTexture(): DataTexture {
  const texture = new DataTexture(
    new Uint8Array([255, 0, 0, 255, 0, 0, 0, 0]),
    2,
    2,
    RGFormat,
    UnsignedByteType,
  );
  texture.needsUpdate = true;
  return texture;
}

function makeArgs(overrides: Partial<InkUniformArgs> = {}): InkUniformArgs {
  return {
    texture: makeTexture(),
    width: 4,
    height: 3,
    uLength: 2,
    vLength: 1.5,
    teamA: new Vector3(0.95, 0.32, 0.28),
    teamB: new Vector3(0.24, 0.58, 0.95),
    base: new Vector3(0.9, 0.86, 0.78),
    lightDir: new Vector3(0.4, 0.82, 0.42),
    axisU: new Vector3(1, 0, 0),
    axisV: new Vector3(0, 0, 1),
    ...overrides,
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function finiteComponents(uniforms: InkUniforms): number[] {
  return [
    uniforms.uSize.value.x,
    uniforms.uSize.value.y,
    uniforms.uMeters.value.x,
    uniforms.uMeters.value.y,
    uniforms.uTeamA.value.x,
    uniforms.uTeamA.value.y,
    uniforms.uTeamA.value.z,
    uniforms.uTeamB.value.x,
    uniforms.uTeamB.value.y,
    uniforms.uTeamB.value.z,
    uniforms.uBase.value.x,
    uniforms.uBase.value.y,
    uniforms.uBase.value.z,
    uniforms.uLightDir.value.x,
    uniforms.uLightDir.value.y,
    uniforms.uLightDir.value.z,
    uniforms.uAxisU.value.x,
    uniforms.uAxisU.value.y,
    uniforms.uAxisU.value.z,
    uniforms.uAxisV.value.x,
    uniforms.uAxisV.value.y,
    uniforms.uAxisV.value.z,
  ];
}

describe('ink shaders', () => {
  it('vertex stage forwards uv, normal and world position', () => {
    expect(INK_VERTEX_SHADER).toContain('vUv = uv;');
    expect(INK_VERTEX_SHADER).toContain('modelMatrix * vec4(position, 1.0)');
    expect(INK_VERTEX_SHADER).toContain('vWorldPos = worldPosition.xyz;');
    expect(INK_VERTEX_SHADER).toContain('gl_Position = projectionMatrix * viewMatrix');
    expect(INK_VERTEX_SHADER).toContain('vNormal = normalize(normal);');
  });

  it('declares and uses every uniform produced by inkUniforms', () => {
    const uniforms = inkUniforms(makeArgs());

    for (const name of Object.keys(uniforms)) {
      expect(INK_FRAGMENT_SHADER).toMatch(
        new RegExp(`uniform\\s+[A-Za-z0-9_]+\\s+${name}\\s*;`),
      );
      // One occurrence is the declaration; the shader body needs at least one more.
      expect(occurrences(INK_FRAGMENT_SHADER, name)).toBeGreaterThan(1);
    }

    expect(Object.keys(uniforms)).toEqual(
      expect.arrayContaining([
        'uPaint',
        'uSize',
        'uMeters',
        'uTeamA',
        'uTeamB',
        'uBase',
        'uLightDir',
        'uAxisU',
        'uAxisV',
      ]),
    );
  });

  it('reads the precomputed RG coverage with hardware bilinear taps only', () => {
    expect(INK_FRAGMENT_SHADER).toContain('texture(uPaint, vUv).rg');
    expect(INK_FRAGMENT_SHADER).toContain('vec2 halfTexel = texel * 0.5;');
    expect(INK_FRAGMENT_SHADER).not.toContain('texelFetch');
    expect(INK_FRAGMENT_SHADER).not.toContain('* 255.0');

    const reads = occurrences(INK_FRAGMENT_SHADER, 'texture(');
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(reads).toBeLessThanOrEqual(6);
  });

  it('builds the soft edge from one centre sample and four half-cell taps', () => {
    expect(INK_FRAGMENT_SHADER).toContain('vec2 cL = texture(uPaint, vUv - vec2(halfTexel.x, 0.0)).rg;');
    expect(INK_FRAGMENT_SHADER).toContain('vec2 cR = texture(uPaint, vUv + vec2(halfTexel.x, 0.0)).rg;');
    expect(INK_FRAGMENT_SHADER).toContain('vec2 cD = texture(uPaint, vUv - vec2(0.0, halfTexel.y)).rg;');
    expect(INK_FRAGMENT_SHADER).toContain('vec2 cU = texture(uPaint, vUv + vec2(0.0, halfTexel.y)).rg;');
    expect(INK_FRAGMENT_SHADER).toContain(
      'vec2 coverage = 0.4 * c00 + 0.15 * (cL + cR + cD + cU);',
    );
  });

  it('skips gloss and ink when all five samples are unpainted', () => {
    expect(INK_FRAGMENT_SHADER).toContain('float inkPresence = c00.x + c00.y');
    expect(INK_FRAGMENT_SHADER).toContain('if (inkPresence > 0.0) {');
    expect(INK_FRAGMENT_SHADER).toContain(
      'vec3 lit = baseTint * baseExposure * cornerShade;',
    );
  });

  it('derives the gradient from the same four taps', () => {
    expect(INK_FRAGMENT_SHADER).toContain(
      '(cR.x + cR.y) - (cL.x + cL.y)',
    );
    expect(INK_FRAGMENT_SHADER).toContain(
      'vec2 dC = 2.0 * vec2(',
    );
    expect(INK_FRAGMENT_SHADER).toContain('max(length(dC) * 0.5, 0.0001)');
  });

  it('wobbles the threshold with cheap smooth value noise on a 0.6 m grid', () => {
    expect(INK_FRAGMENT_SHADER).toContain('float valueNoise(vec2 p)');
    expect(INK_FRAGMENT_SHADER).toContain('f * f * (3.0 - 2.0 * f)');
    expect(INK_FRAGMENT_SHADER).toContain('valueNoise(metres / 0.6)');
    expect(INK_FRAGMENT_SHADER).toContain('0.5 + 0.08 * (noise - 0.5)');
    expect(INK_FRAGMENT_SHADER).toContain(
      'smoothstep(threshold - 0.03, threshold + 0.03, cov)',
    );
  });

  it('exposes diffuse light without clipping the cream base', () => {
    expect(INK_FRAGMENT_SHADER).toContain('0.62 + 0.38 * baseDiffuse');
    expect(INK_FRAGMENT_SHADER).toContain('0.62 + 0.38 * diffuse');
    expect(INK_FRAGMENT_SHADER).toContain('max(dot(diffNormal, l), 0.0)');
    expect(INK_FRAGMENT_SHADER).not.toContain('uAmbient');
  });

  it('darkens surface corners using metres from uMeters', () => {
    expect(INK_FRAGMENT_SHADER).toContain('clamp(vUv * safeMetres, vec2(0.0), safeMetres)');
    expect(INK_FRAGMENT_SHADER).toContain(
      'mix(0.86, 1.0, smoothstep(0.0, 0.6, borderDistance))',
    );
    expect(INK_FRAGMENT_SHADER).toContain('surfaceColor * exposure * cornerShade');
  });

  it('has the puffy normal, two-tier white gloss and inner dark band', () => {
    expect(INK_FRAGMENT_SHADER).toContain(
      '(dC.x * uAxisU + dC.y * uAxisV) * (4.0 * glossRim)',
    );
    expect(INK_FRAGMENT_SHADER).toContain('pow(nDotH, 12.0) * 0.35');
    expect(INK_FRAGMENT_SHADER).toContain('pow(nDotH, 60.0) * 0.7');
    expect(INK_FRAGMENT_SHADER).toContain('lit += vec3(gloss);');
    expect(INK_FRAGMENT_SHADER).toContain('1.0 - smoothstep(0.08, 0.12, edgeMetres)');
    expect(INK_FRAGMENT_SHADER).toContain('teamColor * 0.55');
  });

  it('keeps the tile wobble and output colour space', () => {
    expect(INK_FRAGMENT_SHADER).toContain('0.96 + 0.08 * hash(floor(tileCoord))');
    expect(INK_FRAGMENT_SHADER).toContain('#include <colorspace_fragment>');
  });
});

describe('inkUniforms', () => {
  it('returns finite values and preserves the texture, grid and metre size', () => {
    const texture = makeTexture();
    const uniforms = inkUniforms(makeArgs({ texture, width: 4, height: 3 }));

    expect(uniforms.uPaint.value).toBe(texture);
    expect(uniforms.uSize.value.x).toBe(4);
    expect(uniforms.uSize.value.y).toBe(3);
    expect(uniforms.uMeters.value.x).toBe(2);
    expect(uniforms.uMeters.value.y).toBe(1.5);
    for (const value of finiteComponents(uniforms)) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect('uAmbient' in uniforms).toBe(false);
  });

  it('normalises axes and the light direction', () => {
    const uniforms = inkUniforms(
      makeArgs({
        axisU: new Vector3(3, 0, 4),
        axisV: new Vector3(0, 0, -2),
        lightDir: new Vector3(0, 7, 0),
      }),
    );

    expect(uniforms.uAxisU.value.x).toBeCloseTo(0.6);
    expect(uniforms.uAxisU.value.z).toBeCloseTo(0.8);
    expect(uniforms.uAxisU.value.length()).toBeCloseTo(1);
    expect(uniforms.uAxisV.value.z).toBeCloseTo(-1);
    expect(uniforms.uAxisV.value.length()).toBeCloseTo(1);
    expect(uniforms.uLightDir.value.y).toBeCloseTo(1);
  });

  it('replaces zero axes and zero light with finite unit fallbacks', () => {
    const uniforms = inkUniforms(
      makeArgs({
        axisU: new Vector3(0, 0, 0),
        axisV: new Vector3(0, 0, 0),
        lightDir: new Vector3(0, 0, 0),
      }),
    );

    expect(uniforms.uAxisU.value.length()).toBeCloseTo(1);
    expect(uniforms.uAxisV.value.length()).toBeCloseTo(1);
    expect(uniforms.uLightDir.value.length()).toBeCloseTo(1);
    expect(uniforms.uAxisU.value.x).not.toBeCloseTo(uniforms.uAxisV.value.x);
  });

  it('sanitises non-finite and negative inputs', () => {
    const uniforms = inkUniforms(
      makeArgs({
        width: Number.NaN,
        height: Number.NEGATIVE_INFINITY,
        uLength: Number.NaN,
        vLength: -5,
        teamA: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: -5 },
        teamB: { x: 2, y: Number.NaN, z: 0.5 },
        base: { x: Number.NaN, y: Number.NaN, z: Number.NaN },
        lightDir: { x: Number.NaN, y: Number.POSITIVE_INFINITY, z: Number.NaN },
        axisU: { x: Number.NaN, y: 0, z: 0 },
        axisV: { x: Number.NaN, y: Number.NaN, z: Number.NaN },
      }),
    );

    expect(uniforms.uSize.value.x).toBe(1);
    expect(uniforms.uSize.value.y).toBe(1);
    expect(uniforms.uMeters.value.x).toBe(0);
    expect(uniforms.uMeters.value.y).toBe(0);
    for (const value of finiteComponents(uniforms)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(uniforms.uTeamA.value.z).toBe(0);
    expect(uniforms.uTeamB.value.x).toBe(2);
  });

  it('clamps absurd dimensions and surface sizes to finite GPU-safe values', () => {
    const uniforms = inkUniforms(
      makeArgs({ width: 1e12, height: -12.7, uLength: 1e12, vLength: Infinity }),
    );

    expect(uniforms.uSize.value.x).toBe(16384);
    expect(uniforms.uSize.value.y).toBe(1);
    expect(uniforms.uMeters.value.x).toBe(16384);
    expect(uniforms.uMeters.value.y).toBe(0);
    expect(Number.isFinite(uniforms.uSize.value.x)).toBe(true);
  });
});
