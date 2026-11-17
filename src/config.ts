import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where everything lives, and the agent's own settings.
 *
 *   ~/.reneplane/
 *     bin/          the agent itself (node, agent.mjs, node-pty, git)
 *     runtimes/     Node, Postgres, … downloaded on first use
 *     cache/        npm / uv / Maven / NuGet caches shared by every mission
 *     missions/     one folder per attempt: repo/ (the learner's files), db/, state.json
 *     logs/
 *     config.json   this file: pairing, devices, settings (readable only by this user)
 *
 * RENEPLANE_HOME overrides the root (tests and side-by-side dev copies).
 */

export const HOME = process.env.RENEPLANE_HOME ?? join(homedir(), '.reneplane');

export const PATHS = {
  home: HOME,
  bin: join(HOME, 'bin'),
  runtimes: join(HOME, 'runtimes'),
  downloads: join(HOME, 'runtimes', '.downloads'),
  cache: join(HOME, 'cache'),
  missions: join(HOME, 'missions'),
  logs: join(HOME, 'logs'),
  config: join(HOME, 'config.json'),
};

export const DEFAULT_PORTS = [47811, 47812, 47813];

export interface PairedDevice {
  /** sha256 of the device key the browser holds */
  keyHash: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface PendingPairing {
  /** sha256 of the install token */
  tokenHash: string;
  expiresAt: string;
}

export interface AgentConfig {
  /** Lets the CLI talk to the running agent; never sent to a browser */
  controlToken: string;
  devices: PairedDevice[];
  pendingPairings: PendingPairing[];
  /** Testers only: also accept https://*.reneplane-workspace.pages.dev */
  allowPreviewOrigins: boolean;
  /** Signed by get.reneplane.com when the install token was redeemed; sent to the pool and grader */
  deviceToken: string | null;
  /** Install token still to be redeemed for a device token (the install couldn't reach get.reneplane.com) */
  pendingRedeem: { token: string; getUrl: string } | null;
  /** Start at login (default) or only when asked */
  startAtLogin: boolean;
}

function defaults(): AgentConfig {
  return {
    controlToken: randomBytes(32).toString('base64url'),
    devices: [],
    pendingPairings: [],
    allowPreviewOrigins: false,
    deviceToken: null,
    pendingRedeem: null,
    startAtLogin: true,
  };
}

export function ensureDirs(): void {
  for (const dir of [PATHS.home, PATHS.bin, PATHS.runtimes, PATHS.downloads, PATHS.cache, PATHS.missions, PATHS.logs]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig(): AgentConfig {
  ensureDirs();
  if (!existsSync(PATHS.config)) {
    const fresh = defaults();
    saveConfig(fresh);
    return fresh;
  }
  const parsed = JSON.parse(readFileSync(PATHS.config, 'utf8')) as Partial<AgentConfig>;
  return { ...defaults(), ...parsed };
}

/** Atomic write, readable only by the current user on macOS and Linux */
export function saveConfig(config: AgentConfig): void {
  ensureDirs();
  const temp = `${PATHS.config}.tmp`;
  writeFileSync(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temp, PATHS.config);
}

export function updateConfig(change: (config: AgentConfig) => void): AgentConfig {
  const config = loadConfig();
  change(config);
  saveConfig(config);
  return config;
}
