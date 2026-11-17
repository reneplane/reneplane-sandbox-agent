import { loadConfig, updateConfig, type AgentConfig } from './config.js';
import { AgentError } from './protocol.js';
import { randomToken, sameHash, sha256 } from './security.js';

/**
 * Pairing a browser with this agent.
 *
 *   1. The IDE gets a one-time install token and shows it inside the install command.
 *   2. The install script (or `reneplane-local pair <token>`) stores only the token's hash, valid 30 minutes.
 *   3. The IDE's first `hello` sends the token. It is used up, and the agent returns a device key.
 *   4. Every later `hello` from that browser sends the device key.
 */

const PAIRING_TTL_MS = 30 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Remember an install token so the browser that holds it can pair */
export function addPendingPairing(token: string, now = Date.now()): void {
  if (!isWellFormedToken(token)) throw new Error('That pairing token is not valid');
  const tokenHash = sha256(token);
  updateConfig((config) => {
    config.pendingPairings = config.pendingPairings
      .filter((pending) => Date.parse(pending.expiresAt) > now && pending.tokenHash !== tokenHash)
      .concat({ tokenHash, expiresAt: new Date(now + PAIRING_TTL_MS).toISOString() });
  });
}

export interface HelloAuth {
  deviceKey?: string;
  pairToken?: string;
}

/**
 * Check a hello. Returns the device key the browser should keep: the same one it sent, or a new one
 * when it just paired with an install token.
 */
export function authenticate(auth: HelloAuth, now = Date.now()): { deviceKey: string; newlyPaired: boolean } {
  const config = loadConfig();

  if (auth.deviceKey) {
    const hash = sha256(auth.deviceKey);
    const device = config.devices.find((candidate) => sameHash(candidate.keyHash, hash));
    if (device) {
      updateConfig((draft) => touch(draft, hash, now));
      return { deviceKey: auth.deviceKey, newlyPaired: false };
    }
  }

  if (auth.pairToken && isWellFormedToken(auth.pairToken)) {
    const hash = sha256(auth.pairToken);
    const pending = config.pendingPairings.find(
      (candidate) => sameHash(candidate.tokenHash, hash) && Date.parse(candidate.expiresAt) > now,
    );
    if (pending) {
      const deviceKey = randomToken(32);
      const stamp = new Date(now).toISOString();
      updateConfig((draft) => {
        // Single use: the token can never pair a second browser
        draft.pendingPairings = draft.pendingPairings.filter((candidate) => candidate.tokenHash !== pending.tokenHash);
        draft.devices.push({ keyHash: sha256(deviceKey), createdAt: stamp, lastSeenAt: stamp });
      });
      return { deviceKey, newlyPaired: true };
    }
  }

  throw new AgentError('not_paired', 'This browser is not paired with Reneplane Local yet. Run the install command shown in the workspace.');
}

function touch(config: AgentConfig, keyHash: string, now: number): void {
  const device = config.devices.find((candidate) => candidate.keyHash === keyHash);
  if (device) device.lastSeenAt = new Date(now).toISOString();
}

export function forgetAllDevices(): void {
  updateConfig((config) => {
    config.devices = [];
    config.pendingPairings = [];
  });
}
