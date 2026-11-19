import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Cloud mode: the same agent, in a container Reneplane runs, instead of on the learner's computer.
 * Switching is configuration (the engine's agent provider setting, and these variables); the IDE speaks
 * the same protocol and the sessions, bundles and autosave are identical. The differences:
 *
 *   RENEPLANE_MODE=cloud             (or `serve --cloud`)
 *   RENEPLANE_LISTEN=0.0.0.0:8080    where the WebSocket listens (the platform routes to it)
 *   RENEPLANE_PUBLIC_HOST=…          the Host header browsers send (DNS-rebinding check, as locally)
 *   RENEPLANE_PREVIEW_URL=https://{port}-s123.preview.example   how a service's port is reached
 *   SESSION_SECRET=…                 the engine's session-token secret: `hello` carries the session
 *                                    token instead of pairing, and only that attempt can be opened
 *
 * The container exits when its session ends.
 */

export interface CloudConfig {
  host: string;
  port: number;
  publicHost: string | null;
  sessionSecret: string;
  previewUrl: string;
}

export function cloudConfig(forced = false): CloudConfig | null {
  if (!forced && process.env.RENEPLANE_MODE !== 'cloud') return null;
  const [host = '0.0.0.0', port = '8080'] = (process.env.RENEPLANE_LISTEN ?? '0.0.0.0:8080').split(':');
  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (sessionSecret.length < 32) throw new Error('Cloud mode needs SESSION_SECRET (the engine’s session-token secret)');
  return {
    host,
    port: Number(port),
    publicHost: process.env.RENEPLANE_PUBLIC_HOST ?? null,
    sessionSecret,
    previewUrl: process.env.RENEPLANE_PREVIEW_URL ?? 'http://localhost:{port}',
  };
}

/** s1.<attemptId>.<gen>.<exp>.<sig>, signed by the engine (src/lib/tokens.ts there: HMAC of "session:<payload>") */
export function verifySessionToken(token: string | undefined, secret: string, now = Date.now()): { attemptId: string; gen: number } | null {
  const match = token?.match(/^s1\.(att_[a-z0-9]{10,40})\.(\d{1,6})\.(\d{10})\.([\w-]{20,})$/);
  if (!match) return null;
  const [, attemptId, gen, exp, signature] = match as unknown as [string, string, string, string, string];
  const expected = createHmac('sha256', secret).update(`session:${attemptId}.${gen}.${exp}`).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) * 1000 < now) return null;
  return { attemptId, gen: Number(gen) };
}

/** Where a learner's browser reaches a service's port: localhost on their computer, a public URL in the cloud */
export function publicUrl(template: string, port: number): string {
  return template.replace('{port}', String(port)).replace(/\/$/, '');
}
