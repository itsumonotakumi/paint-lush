import { describe, expect, it } from 'vitest';
import type { SurfaceId } from '../../core/types';
import { DirtyUploadQueue, MAX_TEXTURE_UPLOADS_PER_FRAME } from './dirtyQueue';

describe('DirtyUploadQueue', () => {
  it('drains at most six ids per frame and keeps the rest in order', () => {
    const queue = new DirtyUploadQueue();
    const incoming: SurfaceId[] = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const out: SurfaceId[] = [];

    queue.enqueue(incoming);
    expect(MAX_TEXTURE_UPLOADS_PER_FRAME).toBe(6);
    expect(queue.size).toBe(7);

    expect(queue.drain(MAX_TEXTURE_UPLOADS_PER_FRAME, out)).toBe(6);
    expect(out).toEqual([3, 1, 4, 5, 9, 2]);
    expect(queue.size).toBe(1);

    expect(queue.drain(MAX_TEXTURE_UPLOADS_PER_FRAME, out)).toBe(1);
    expect(out).toEqual([6]);
    expect(queue.size).toBe(0);

    expect(queue.drain(MAX_TEXTURE_UPLOADS_PER_FRAME, out)).toBe(0);
    expect(out).toEqual([]);
  });

  it('keeps order across many frames without dropping anything', () => {
    const queue = new DirtyUploadQueue();
    const out: SurfaceId[] = [];
    const expected: SurfaceId[] = [];
    for (let i = 0; i < 900; i += 1) {
      expected.push(i);
      queue.enqueue([i]);
    }

    const seen: SurfaceId[] = [];
    while (queue.size > 0) {
      const count = queue.drain(MAX_TEXTURE_UPLOADS_PER_FRAME, out);
      expect(count).toBeLessThanOrEqual(MAX_TEXTURE_UPLOADS_PER_FRAME);
      for (let i = 0; i < out.length; i += 1) {
        const id = out[i];
        if (id !== undefined) seen.push(id);
      }
    }
    expect(seen).toEqual(expected);
  });

  it('coalesces duplicate ids while they are waiting', () => {
    const queue = new DirtyUploadQueue();
    const out: SurfaceId[] = [];

    queue.enqueue([7, 7, 7]);
    expect(queue.size).toBe(1);

    queue.drain(1, out);
    expect(out).toEqual([7]);

    // Once uploaded, the same surface may become dirty again.
    queue.enqueue([7, 8]);
    expect(queue.size).toBe(2);
    queue.drain(5, out);
    expect(out).toEqual([7, 8]);
  });

  it('clamps hostile limits and ignores broken ids', () => {
    const queue = new DirtyUploadQueue();
    const out: SurfaceId[] = [99];

    queue.enqueue([1, Number.NaN, Number.POSITIVE_INFINITY, 2, 1]);
    expect(queue.size).toBe(2);

    expect(queue.drain(Number.NaN, out)).toBe(0);
    expect(out).toEqual([]);
    expect(queue.size).toBe(2);

    expect(queue.drain(Number.POSITIVE_INFINITY, out)).toBe(2);
    expect(out).toEqual([1, 2]);
  });

  it('clears pending work on demand', () => {
    const queue = new DirtyUploadQueue();
    const out: SurfaceId[] = [];
    queue.enqueue([1, 2, 3]);
    queue.drain(1, out);
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.drain(6, out)).toBe(0);
  });
});
