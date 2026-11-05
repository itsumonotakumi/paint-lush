import { NO_TEAM } from '../../core/types';

/**
 * Number of bytes in an RG coverage buffer for `cellCount` paint cells.
 * The shader reads two channels per cell: R for team 0 and G for team 1.
 */
export function coverageByteLength(cellCount: number): number {
  const cells = Number.isFinite(cellCount) ? Math.max(0, Math.trunc(cellCount)) : 0;
  return cells * 2;
}

/**
 * Converts the simulation's paint bytes into the renderer's RG coverage bytes.
 *
 * A team-0 cell writes 255 to R, a team-1 cell writes 255 to G, and every
 * other value (notably {@link NO_TEAM}, 255) writes zero to both channels.
 * That keeps unpainted cells fully transparent to the ink shader while the
 * paint grid stays the simulation's only source of truth.
 *
 * The loop is tight and writes only into `cover`, so a dirty surface can be
 * rebuilt every time it leaves the upload queue without allocating.
 */
export function updateCoverage(data: Uint8Array, cover: Uint8Array): void {
  const cells = data.length;
  for (let i = 0; i < cells; i += 1) {
    const value = data[i] ?? NO_TEAM;
    const offset = i * 2;

    if (value === 0) {
      cover[offset] = 255;
      cover[offset + 1] = 0;
    } else if (value === 1) {
      cover[offset] = 0;
      cover[offset + 1] = 255;
    } else {
      cover[offset] = 0;
      cover[offset + 1] = 0;
    }
  }
}
