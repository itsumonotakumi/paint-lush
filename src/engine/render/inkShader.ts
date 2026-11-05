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
 * Paint coverage comes from a precomputed RG texture. R is the team-0 mask and
 * G is the team-1 mask, each already reduced to 0 or 1 by the CPU, so the
 * fragment stage never decodes simulation bytes per texel.
 *
 * One centre sample plus four half-cell taps, all through hardware bilinear
 * filtering, give both the soft rounded edge blur and its gradient. That is
 * five texture reads per pixel on painted and unpainted pixels alike. When all
 * five are zero the shader skips every ink, rim and gloss term and only shades
 * the base stone.
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

void main() {
  vec2 texel = 1.0 / max(uSize, vec2(1.0));
  vec2 halfTexel = texel * 0.5;

  // Five bilinear reads: centre plus the four half-cell neighbours. The RG
  // format already holds the two team masks, so these are the only samples.
  vec2 c00 = texture(uPaint, vUv).rg;
  vec2 cL = texture(uPaint, vUv - vec2(halfTexel.x, 0.0)).rg;
  vec2 cR = texture(uPaint, vUv + vec2(halfTexel.x, 0.0)).rg;
  vec2 cD = texture(uPaint, vUv - vec2(0.0, halfTexel.y)).rg;
  vec2 cU = texture(uPaint, vUv + vec2(0.0, halfTexel.y)).rg;

  // A small tent over the taps keeps the ink edge soft and rounded instead of
  // following cell stairs, without a 3x3 per-texel blur.
  vec2 coverage = 0.4 * c00 + 0.15 * (cL + cR + cD + cU);
  float covA = coverage.x;
  float covB = coverage.y;
  float cov = covA + covB;

  // Surface metres for edge-relative effects. uMeters is the real face size,
  // so the 0.6 m noise grid and the corner darkening stay resolution-free.
  vec2 safeMetres = max(uMeters, vec2(0.0));
  vec2 metres = clamp(vUv * safeMetres, vec2(0.0), safeMetres);

  float normalLength = length(vNormal);
  vec3 n = normalLength > 0.0001 ? vNormal / normalLength : vec3(0.0, 1.0, 0.0);

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

  float lightLength = length(uLightDir);
  vec3 l = lightLength > 0.0001 ? uLightDir / lightLength : vec3(0.0, 1.0, 0.0);

  // Exposure stays within the base colour: a lit top is about 1.0 and a face
  // turned away from the sun keeps 0.62, so the cream never blows out.
  float baseDiffuse = max(dot(n, l), 0.0);
  float baseExposure = 0.62 + 0.38 * baseDiffuse;

  // Soft corner darkening, measured from the real surface border in metres.
  vec2 toEdge = min(metres, safeMetres - metres);
  float borderDistance = max(min(toEdge.x, toEdge.y), 0.0);
  float cornerShade = mix(0.86, 1.0, smoothstep(0.0, 0.6, borderDistance));

  vec3 lit = baseTint * baseExposure * cornerShade;

  float inkPresence = c00.x + c00.y
                    + cL.x + cL.y
                    + cR.x + cR.y
                    + cD.x + cD.y
                    + cU.x + cU.y;

  if (inkPresence > 0.0) {
    // Organic threshold wobble: continuous value noise over a 0.6 m grid.
    float noise = valueNoise(metres / 0.6);
    float threshold = 0.5 + 0.08 * (noise - 0.5);

    // A 0.06-wide smoothstep gives a clean, rounded ink edge.
    float painted = smoothstep(threshold - 0.03, threshold + 0.03, cov);

    vec3 teamColor = (uTeamA * covA + uTeamB * covB) / max(cov, 0.0001);

    // Outer rim reads as a drawn outline around the fresh paint.
    float rim = smoothstep(threshold - 0.16, threshold - 0.06, cov)
              * (1.0 - smoothstep(threshold - 0.06, threshold + 0.04, cov));

    // The same four taps give a cheap gradient across roughly two cells, so the
    // puffy normal and the edge distance keep the old tent-blur response.
    vec2 dC = 2.0 * vec2(
      (cR.x + cR.y) - (cL.x + cL.y),
      (cU.x + cU.y) - (cD.x + cD.y)
    );

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

    vec3 bump = (dC.x * uAxisU + dC.y * uAxisV) * (4.0 * glossRim);
    vec3 bumpedNormal = n - bump;
    float bumpedLength = length(bumpedNormal);
    vec3 n2 = bumpedLength > 0.0001 ? bumpedNormal / bumpedLength : n;

    vec3 viewDelta = cameraPosition - vWorldPos;
    float viewLength = length(viewDelta);
    vec3 viewDir = viewLength > 0.0001 ? viewDelta / viewLength : n2;

    vec3 diffNormal = mix(n, n2, painted);
    float diffuse = max(dot(diffNormal, l), 0.0);
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

    vec3 surfaceColor = mix(baseTint, teamColor, painted);
    surfaceColor = mix(surfaceColor, teamColor * 0.55, rim * 0.8);
    surfaceColor = mix(surfaceColor, teamColor * 0.5, innerBand * 0.6);

    lit = surfaceColor * exposure * cornerShade;
    lit += teamColor * fresnel;
    lit += vec3(gloss);
  }

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
  /** RG coverage texture: R is team 0, G is team 1, both already 0 or 255. */
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
