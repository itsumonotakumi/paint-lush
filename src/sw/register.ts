/**
 * Registers the generated service worker. Registration is best effort: any
 * failure (unsupported browser, insecure context, blocked storage) resolves to
 * false so the game can keep running without offline support.
 */
export async function registerServiceWorker(
  nav: Pick<Navigator, 'serviceWorker'>,
  url: string,
): Promise<boolean> {
  try {
    if (!nav || !nav.serviceWorker) return false;
    const container = nav.serviceWorker;
    if (typeof container.register !== 'function') return false;
    await container.register(url);
    return true;
  } catch {
    return false;
  }
}
