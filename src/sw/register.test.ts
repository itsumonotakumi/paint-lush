import { describe, expect, it, vi } from 'vitest';
import { registerServiceWorker } from './register';

function navWith(register: ServiceWorkerContainer['register']): Pick<Navigator, 'serviceWorker'> {
  return { serviceWorker: { register } as ServiceWorkerContainer };
}

describe('registerServiceWorker', () => {
  it('registers the given url and resolves true', async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);

    await expect(registerServiceWorker(navWith(register), './sw.js')).resolves.toBe(true);
    expect(register).toHaveBeenCalledWith('./sw.js');
  });

  it('resolves false when registration rejects', async () => {
    const register = vi.fn(async () => {
      throw new Error('denied');
    });

    await expect(registerServiceWorker(navWith(register), './sw.js')).resolves.toBe(false);
  });

  it('resolves false when registration throws synchronously', async () => {
    const register = (() => {
      throw new Error('blocked');
    }) as ServiceWorkerContainer['register'];

    await expect(registerServiceWorker(navWith(register), './sw.js')).resolves.toBe(false);
  });

  it('resolves false when the browser has no service worker container', async () => {
    const nav = {} as Pick<Navigator, 'serviceWorker'>;

    await expect(registerServiceWorker(nav, './sw.js')).resolves.toBe(false);
  });
});
