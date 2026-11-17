import { createServer } from 'node:net';

/** True if nothing is listening on 127.0.0.1:<port> */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

/** The preferred port if it's free, otherwise the next free one above it */
export async function pickPort(preferred: number, avoid: Set<number> = new Set(), attempts = 50): Promise<number> {
  for (let port = preferred; port < preferred + attempts; port += 1) {
    if (avoid.has(port)) continue;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found near ${preferred}`);
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
