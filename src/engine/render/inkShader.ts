import { Vector2, Vector3 } from 'three';
import type { DataTexture } from 'three';

/**
 * World-space vertex stage. Surfaces are already built in world space by
 * geometry.ts, so the model matrix is identity in practice; keeping it here
 * means the shader still works if a caller ever adds a transform.
 */
export const INK_VERTEX_SHADER = /* glsl */ `
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

/**
 * Paint coverage is read straight from the single-channel paint texture.
 * 255 means "no team", 0 means team A and 1 means team B, so a texel only
 * contributes to one team. Bilinear coverage is blurred with a 3x3 tent so the
 * edge field is smooth and rounded instead of following cell stairs. A value
 * noise field wobbles the threshold and the specular break-up comes from the
 * same blurred field, which keeps every visual derived from one source.
 */
export const INK_FRAGMENT_SHADER = /* glsl */ `
out vec4 fragColor;
#define gl_FragColor fragColor

uniform sampler2D uPaint;
uniform vec2 uSize;
uniform vec2 uMeters;
uniform vec3 uTeamA;
uniform vec3 uTeamB;
uniform vec3 uBase;
uniform vec3 uLightDir;
uniform vec3 uAxisU;
uniform vec3 uAxisV;

varying vec2 vUv;
varying vec3 vNormal;
varying vec3 vWorldPos;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5);
}

/** Smooth value noise on a unit grid; callers scale metres to the cell size. */
float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 smoothF = f * f * (3.0 - 2.0 * f);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, smoothF.x), mix(c, d, smoothF.x), smoothF.y);
}

/** Both team coverages for one texel from a single fetch. */
vec2 cellCoverage(ivec2 texel) {
  float value = texelFetch(uPaint, texel, 0).r * 255.0;
  float teamA = 1.0 - step(0.5, abs(value - 0.0));
  float teamB = 1.0 - step(0.5, abs(value - 1.0));
  return vec2(teamA, teamB);
}

/** Bilinear coverage of the two teams at a continuous texel coordinate. */
vec2 sampleCoverage(vec2 continuous, ivec2 maxTexel) {
  vec2 baseF = floor(continuous);
  vec2 weight = continuous - baseF;

  ivec2 baseI = clamp(ivec2(baseF), ivec2(0), maxTexel);
  ivec2 rightI = clamp(baseI + ivec2(1, 0), ivec2(0), maxTexel);
  ivec2 upI = clamp(baseI + ivec2(0, 1), ivec2(0), maxTexel);
  ivec2 diagI = clamp(baseI + ivec2(1, 1), ivec2(0), maxTexel);

  vec2 w00 = vec2((1.0 - weight.x) * (1.0 - weight.y));
  vec2 w10 = vec2(weight.x * (1.0 - weight.y));
  vec2 w01 = vec2((1.0 - weight.x) * weight.y);
  vec2 w11 = vec2(weight.x * weight.y);

  return cellCoverage(baseI) * w00
       + cellCoverage(rightI) * w10
       + cellCoverage(upI) * w01
       + cellCoverage(diagI) * w11;
}

void main() {
  ivec2 maxTexel = max(ivec2(uSize) - ivec2(1), ivec2(0));
  vec2 continuous = vUv * uSize - vec2(0.5);

  // 3x3 tent blur: weights 1,2,1 / 2,4,2 / 1,2,1 over 16. Each tap is one
  // continuous cell away, so the result is a soft blobby coverage field.
  vec2 cMM = sampleCoverage(continuous + vec2(-1.0, -1.0), maxTexel);
  vec2 cM0 = sampleCoverage(continuous + vec2(-1.0, 0.0), maxTexel);
  vec2 cMP = sampleCoverage(continuous + vec2(-1.0, 1.0), maxTexel);
  vec2 c0M = sampleCoverage(continuous + vec2(0.0, -1.0), maxTexel);
  vec2 c00 = sampleCoverage(continuous, maxTexel);
  vec2 c0P = sampleCoverage(continuous + vec2(0.0, 1.0), maxTexel);
  vec2 cPM = sampleCoverage(continuous + vec2(1.0, -1.0), maxTexel);
  vec2 cP0 = sampleCoverage(continuous + vec2(1.0, 0.0), maxTexel);
  vec2 cPP = sampleCoverage(continuous + vec2(1.0, 1.0), maxTexel);

  vec2 coverage = (cMM + cMP + cPM + cPP
                 + 2.0 * (cM0 + c0M + c0P + cP0)
                 + 4.0 * c00) / 16.0;

  float covA = coverage.x;
  float covB = coverage.y;
  float cov = covA + covB;

  // Column and row averages of the same blurred taps give a cheap gradient of
  // the coverage field for the puffy normal perturbation.
  float sMM = cMM.x + cMM.y;
  float sM0 = cM0.x + cM0.y;
  float sMP = cMP.x + cMP.y;
  float s0M = c0M.x + c0M.y;
  float s0P = c0P.x + c0P.y;
  float sPM = cPM.x + cPM.y;
  float sP0 = cP0.x + cP0.y;
  float sPP = cPP.x + cPP.y;

  float leftColumn = (sMM + 2.0 * sM0 + sMP) * 0.25;
  float rightColumn = (sPM + 2.0 * sP0 + sPP) * 0.25;
  float downRow = (sMM + 2.0 * s0M + sPM) * 0.25;
  float upRow = (sMP + 2.0 * s0P + sPP) * 0.25;
  vec2 dC = vec2(rightColumn - leftColumn, upRow - downRow);

  // Surface metres for edge-relative effects. uMeters is the real face size,
  // so the 0.6 m noise grid and the corner darkening stay resolution-free.
  vec2 safeMetres = max(uMeters, vec2(0.0));
  vec2 metres = clamp(vUv * safeMetres, vec2(0.0), safeMetres);

  // Organic threshold wobble: continuous value noise over a 0.6 m grid.
  float noise = valueNoise(metres / 0.6);
  float threshold = 0.5 + 0.08 * (noise - 0.5);

  // A 0.06-wide smoothstep gives a clean, rounded ink edge.
  float painted = smoothstep(threshold - 0.03, threshold + 0.03, cov);

  vec3 teamColor = (uTeamA * covA + uTeamB * covB) / max(cov, 0.0001);

  // Outer rim reads as a drawn outline around the fresh paint.
  float rim = smoothstep(threshold - 0.16, threshold - 0.06, cov)
            * (1.0 - smoothstep(threshold - 0.06, threshold + 0.04, cov));

  // Approximate distance in metres from the blurred edge. The flat middle has
  // almost no gradient, so the inner band fades out and only hugs the edge.
  vec2 safeSize = max(uSize, vec2(1.0));
  vec2 cellMetres = max(uMeters, vec2(0.0001)) / safeSize;
  float cellMetre = max(0.5 * (cellMetres.x + cellMetres.y), 0.0001);
  float slope = max(length(dC) * 0.5, 0.0001);
  float edgeMetres = ((cov - threshold) / slope) * cellMetre;

  // Darker band roughly 0.08 m inside the edge makes the ink look puffy.
  float innerBand = smoothstep(0.02, 0.05, edgeMetres)
                  * (1.0 - smoothstep(0.08, 0.12, edgeMetres));

  // Gloss lives on the rim and is damped to zero across the flat middle.
  float glossRim = smoothstep(threshold - 0.14, threshold - 0.04, cov)
                 * (1.0 - smoothstep(threshold + 0.06, threshold + 0.20, cov));

  float normalLength = length(vNormal);
  vec3 n = normalLength > 0.0001 ? vNormal / normalLength : vec3(0.0, 1.0, 0.0);

  vec3 bump = (dC.x * uAxisU + dC.y * uAxisV) * (4.0 * glossRim);
  vec3 bumpedNormal = n - bump;
  float bumpedLength = length(bumpedNormal);
  vec3 n2 = bumpedLength > 0.0001 ? bumpedNormal / bumpedLength : n;

  // Unpainted stone keeps a per-metre brightness wobble on the two world
  // axes that lie in the face plane.
  vec3 nAbs = abs(n);
  vec2 tileCoord;
  if (nAbs.y >= nAbs.x && nAbs.y >= nAbs.z) {
    tileCoord = vWorldPos.xz;
  } else if (nAbs.x >= nAbs.z) {
    tileCoord = vWorldPos.zy;
  } else {
    tileCoord = vWorldPos.xy;
  }
  float tileTint = 0.96 + 0.08 * hash(floor(tileCoord));
  vec3 baseTint = uBase * tileTint;

  vec3 surfaceColor = mix(baseTint, teamColor, painted);
  surfaceColor = mix(surfaceColor, teamColor * 0.55, rim * 0.8);
  surfaceColor = mix(surfaceColor, teamColor * 0.5, innerBand * 0.6);

  float lightLength = length(uLightDir);
  vec3 l = lightLength > 0.0001 ? uLightDir / lightLength : vec3(0.0, 1.0, 0.0);

  vec3 viewDelta = cameraPosition - vWorldPos;
  float viewLength = length(viewDelta);
  vec3 viewDir = viewLength > 0.0001 ? viewDelta / viewLength : n2;

  vec3 diffNormal = mix(n, n2, painted);
  float diffuse = max(dot(diffNormal, l), 0.0);

  // Exposure stays within the base colour: a lit top is about 1.0 and a face
  // turned away from the sun keeps 0.62, so the cream never blows out.
  float exposure = 0.62 + 0.38 * diffuse;

  vec3 halfSum = l + viewDir;
  float halfLength = length(halfSum);
  vec3 halfDir = halfLength > 0.0001 ? halfSum / halfLength : n2;
  float nDotH = max(dot(n2, halfDir), 0.0);
  float broadGloss = pow(nDotH, 12.0) * 0.35;
  float tightGloss = pow(nDotH, 60.0) * 0.7;
  float gloss = (broadGloss + tightGloss) * glossRim;

  float viewFacing = clamp(dot(n2, viewDir), 0.0, 1.0);
  float fresnel = pow(1.0 - viewFacing, 3.0) * 0.25 * painted;

  // Soft corner darkening, measured from the real surface border in metres.
  vec2 toEdge = min(metres, safeMetres - metres);
  float borderDistance = max(min(toEdge.x, toEdge.y), 0.0);
  float cornerShade = mix(0.86, 1.0, smoothstep(0.0, 0.6, borderDistance));

  vec3 lit = surfaceColor * exposure * cornerShade;
  lit += teamColor * fresnel;
  lit += vec3(gloss);

  gl_FragColor = vec4(lit, 1.0);
  #include <colorspace_fragment>
}
`;

/** Anything with x/y/z components: a THREE.Color or a THREE.Vector3 both fit. */
export interface InkRgb {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Inputs used to build one surface's ink material. */
export interface InkUniformArgs {
  /** Single-channel paint texture: 255 is unpainted, 0 and 1 are the teams. */
  texture: DataTexture;
  /** Texture width in texels. */
  width: number;
  height: number;
  /** Real face size in metres, used for edge distances and noise scale. */
  uLength: number;
  vLength: number;
  teamA: InkRgb;
  teamB: InkRgb;
  /** Unpainted surface tint, in linear space. */
  base: InkRgb;
  lightDir: InkRgb;
  /** World-space unit vectors matching the surface's paint grid axes. */
  axisU: InkRgb;
  axisV: InkRgb;
}

/** The exact uniform block consumed by {@link INK_FRAGMENT_SHADER}. */
export interface InkUniforms {
  uPaint: { value: DataTexture };
  uSize: { value: Vector2 };
  uMeters: { value: Vector2 };
  uTeamA: { value: Vector3 };
  uTeamB: { value: Vector3 };
  uBase: { value: Vector3 };
  uLightDir: { value: Vector3 };
  uAxisU: { value: Vector3 };
  uAxisV: { value: Vector3 };
}

const MAX_TEXTURE_DIMENSION = 16384;
const MAX_SURFACE_METRES = 16384;
const MAX_COLOR_COMPONENT = 16;
const EPSILON = 1e-6;

function safe(n: number, fallback: number): number {
  return Number.isFinite(n) ? n : fallback;
}

function dimension(n: number): number {
  const value = Math.floor(safe(n, 1));
  return Math.min(MAX_TEXTURE_DIMENSION, Math.max(1, value));
}

function lengthMetres(n: number): number {
  const value = safe(n, 0);
  return Math.min(MAX_SURFACE_METRES, Math.max(0, value));
}

function colorComponent(n: number, fallback: number): number {
  const value = safe(n, fallback);
  return Math.min(MAX_COLOR_COMPONENT, Math.max(0, value));
}

function colorVector(value: InkRgb, fallback: InkRgb): Vector3 {
  return new Vector3(
    colorComponent(value.x, fallback.x),
    colorComponent(value.y, fallback.y),
    colorComponent(value.z, fallback.z),
  );
}

/** Normalises an axis with a finite fallback when the input is zero or invalid. */
function unitVector(value: InkRgb, fallback: InkRgb): Vector3 {
  const x = safe(value.x, fallback.x);
  const y = safe(value.y, fallback.y);
  const z = safe(value.z, fallback.z);
  const length = Math.hypot(x, y, z);

  if (!Number.isFinite(length) || length <= EPSILON) {
    const fx = safe(fallback.x, 0);
    const fy = safe(fallback.y, 1);
    const fz = safe(fallback.z, 0);
    const fallbackLength = Math.hypot(fx, fy, fz);
    if (fallbackLength > EPSILON) {
      return new Vector3(fx / fallbackLength, fy / fallbackLength, fz / fallbackLength);
    }
    return new Vector3(0, 1, 0);
  }

  return new Vector3(x / length, y / length, z / length);
}

const NEUTRAL_BASE: InkRgb = { x: 0.92, y: 0.88, z: 0.8 };
const FALLBACK_LIGHT: InkRgb = { x: 0.4, y: 0.82, z: 0.42 };
const FALLBACK_AXIS_U: InkRgb = { x: 1, y: 0, z: 0 };
const FALLBACK_AXIS_V: InkRgb = { x: 0, y: 0, z: 1 };

/**
 * Builds the uniform object for one paintable surface. Every numeric input is
 * sanitised so the shader never receives NaN or an infinite value.
 */
export function inkUniforms(args: InkUniformArgs): InkUniforms {
  return {
    uPaint: { value: args.texture },
    uSize: { value: new Vector2(dimension(args.width), dimension(args.height)) },
    uMeters: { value: new Vector2(lengthMetres(args.uLength), lengthMetres(args.vLength)) },
    uTeamA: { value: colorVector(args.teamA, { x: 1, y: 1, z: 1 }) },
    uTeamB: { value: colorVector(args.teamB, { x: 1, y: 1, z: 1 }) },
    uBase: { value: colorVector(args.base, NEUTRAL_BASE) },
    uLightDir: { value: unitVector(args.lightDir, FALLBACK_LIGHT) },
    uAxisU: { value: unitVector(args.axisU, FALLBACK_AXIS_U) },
    uAxisV: { value: unitVector(args.axisV, FALLBACK_AXIS_V) },
  };
}
