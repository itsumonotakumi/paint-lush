import type { SurfaceId } from '../../core/types';

/** Maximum paint textures uploaded in one visual frame. */
export const MAX_TEXTURE_UPLOADS_PER_FRAME = 6;

/** Reclaim consumed slots once this many are sitting in front of the queue. */
const COMPACT_THRESHOLD = 256;

/**
 * FIFO queue for paint-surface texture uploads.
 *
 * Each frame the renderer drains at most {@link MAX_TEXTURE_UPLOADS_PER_FRAME}
 * ids; anything left stays queued in the original order and is uploaded on a
 * later frame. Duplicate ids are collapsed because one upload covers every
 * change to the same texture. The queue is a plain helper with no three.js
 * dependencies, so its ordering is tested directly.
 */
export class DirtyUploadQueue {
  private readonly pending: SurfaceId[] = [];
  private readonly queued = new Set<SurfaceId>();
  private head = 0;

  /** Number of ids still waiting for an upload. */
  get size(): number {
    const size = this.pending.length - this.head;
    return size > 0 ? size : 0;
  }

  /** Appends newly dirty ids, ignoring duplicates already waiting. */
  enqueue(ids: readonly SurfaceId[]): void {
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (id === undefined || !Number.isFinite(id)) continue;
      if (this.queued.has(id)) continue;
      this.queued.add(id);
      this.pending.push(id);
    }
  }

  /**
   * Moves up to `limit` ids into `out`, oldest first, and returns the count.
   * `out` is cleared first and reused by the caller, so no array is allocated
   * per frame.
   */
  drain(limit: number, out: SurfaceId[]): number {
    out.length = 0;
    let max = 0;
    if (Number.isNaN(limit) || limit < 0) max = 0;
    else if (!Number.isFinite(limit)) max = this.pending.length;
    else max = Math.trunc(limit);
    let count = 0;

    while (count < max && this.head < this.pending.length) {
      const id = this.pending[this.head];
      this.head += 1;
      if (id === undefined) continue;
      this.queued.delete(id);
      out.push(id);
      count += 1;
    }

    this.reclaim();
    return count;
  }

  /** Drops every queued id, used when the renderer is disposed. */
  clear(): void {
    this.pending.length = 0;
    this.queued.clear();
    this.head = 0;
  }

  private reclaim(): void {
    if (this.head === this.pending.length) {
      this.pending.length = 0;
      this.head = 0;
      return;
    }
    if (this.head < COMPACT_THRESHOLD) return;

    // Shift the live tail to the front in place, avoiding a new array.
    let write = 0;
    for (let read = this.head; read < this.pending.length; read += 1) {
      const id = this.pending[read];
      if (id !== undefined) {
        this.pending[write] = id;
        write += 1;
      }
    }
    this.pending.length = write;
    this.head = 0;
  }
}
