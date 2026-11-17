import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Who may talk to the agent. Any website the learner visits can try to reach 127.0.0.1, so every
 * connection must pass all of these before it is accepted:
 *
 *   1. it arrived on 127.0.0.1 (the server never listens anywhere else)
 *   2. Host is 127.0.0.1:<port> or localhost:<port>        → blocks DNS rebinding
 *   3. Origin is the workspace (plus opt-in extras)         → blocks other websites
 *   4. hello carries a paired device key or a one-time install token, then a session token on every message
 */

export const PRODUCTION_ORIGIN = 'https://workspace.reneplane.com';
export const DEV_ORIGINS = ['http://localhost:5175', 'http://127.0.0.1:5175'];
const PREVIEW_ORIGIN = /^https:\/\/[a-z0-9-]+\.reneplane-workspace\.pages\.dev$/;

export interface OriginPolicy {
  dev: boolean;
  allowPreviewOrigins: boolean;
}

export function isAllowedOrigin(origin: string | undefined, policy: OriginPolicy): boolean {
  if (!origin) return false;
  if (origin === PRODUCTION_ORIGIN) return true;
  if (policy.dev && DEV_ORIGINS.includes(origin)) return true;
  if (policy.allowPreviewOrigins && (PREVIEW_ORIGIN.test(origin) || origin === 'https://reneplane-workspace.pages.dev')) return true;
  return false;
}

export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison of two hex digests */
export function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
