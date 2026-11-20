import { createServer } from 'node:net';

/** True if nothing is listening on 127.0.0.1:<port> */
/**
 * Free on both loopbacks. Dev servers bind 127.0.0.1, ::1 or both, and "localhost" resolves to ::1
 * first on Windows and recent macOS: a port taken only on ::1 (another Vite) looked free, and the
 * mission's preview at localhost:<port> showed that other app.
 */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) if ((await freeOn(port, host)) === false) return false;
  return true;
}

/** null: this computer has no such address (no IPv6), so nothing can be using the port there */
function freeOn(port: number, host: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error: NodeJS.ErrnoException) => resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT' ? null : false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/**
 * Ports this process handed out and hasn't released. A port is free to the OS until its program binds
 * it, so two missions (the checker runs several) could otherwise both be given the same one.
 */
const reserved = new Set<number>();

/** The preferred port if it's free, otherwise the next free one above it. It stays reserved until released. */
export async function pickPort(preferred: number, avoid: Set<number> = new Set(), attempts = 50): Promise<number> {
  for (let port = preferred; port < preferred + attempts; port += 1) {
    if (avoid.has(port) || reserved.has(port)) continue;
    if (await isPortFree(port)) {
      reserved.add(port);
      return port;
    }
  }
  throw new Error(`No free port found near ${preferred}`);
}

export function releasePort(port: number): void {
  reserved.delete(port);
}

/** Wait until an HTTP endpoint answers (any status below 500 counts as up) */
export async function waitForHttp(url: string, timeoutMs: number, isCancelled: () => boolean = () => false): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled()) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      await response.body?.cancel();
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}
