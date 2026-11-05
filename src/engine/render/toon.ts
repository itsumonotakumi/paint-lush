import { DataTexture, MeshToonMaterial, NearestFilter, RedFormat, UnsignedByteType } from 'three';

/** Three-band ramp for toon shading. The caller owns the texture and disposes it. */
export function createToonGradient(): DataTexture {
  const texture = new DataTexture(new Uint8Array([115, 191, 255]), 3, 1, RedFormat, UnsignedByteType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export function createToonMaterial(color: number, gradient: DataTexture): MeshToonMaterial {
  return new MeshToonMaterial({ color, gradientMap: gradient });
}
