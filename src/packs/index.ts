import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { createLogger } from '../log.js';
import { AgentError } from '../protocol.js';
import { ensureRuntime, isAvailable, isInstalled, LABELS, runtimeDir, type RuntimeName } from '../runtimes/index.js';
import { dirSize } from '../util/disk.js';
import { buildEnv, runFile } from '../util/process.js';
import type { WorkspaceFile } from '../mission/workspace.js';

/**
 * Stack packs: what a learner installs once per stack, instead of runtimes appearing on first use.
 * A problem's variant lists the packs it needs (its `requires`), the IDE compares that with what this
 * computer has, and the learner adds what's missing with one click or `reneplane-local add <pack>`.
 *
 * A pack is a few pinned runtimes plus, for some, a step after unpacking (uv installs Python itself).
 * Nothing a pack needs lives in the shared cache, so evicting the cache never makes a pack incomplete.
 * Debug adapters belong to their stack's pack but are optional: without one, the stack still runs.
 */

const log = createLogger('packs');

export const PACK_IDS = ['node22', 'python312-uv', 'jdk21-maven', 'dotnet10', 'postgres16', 'mysql84'] as const;
export type PackId = (typeof PACK_IDS)[number];

interface PackDefinition {
  /** "Java 21": the status bar's name for it */
  label: string;
  runtimes: RuntimeName[];
  /** Installed with the pack when this computer has a build; the pack works without them */
  optional?: RuntimeName[];
  /** After the runtimes are unpacked */
  finish?: (onProgress: (detail: string) => void) => Promise<void>;
  /** The finish step has run */
  finished?: () => boolean;
  /** Folders the finish step creates (deleted with the pack) */
  extraDirs?: () => string[];
}

const PYTHON_VERSION = '3.12';
const pythonMarker = () => join(PATHS.runtimes, 'python', `.reneplane-${PYTHON_VERSION}`);

export const PACKS: Record<PackId, PackDefinition> = {
  node22: { label: 'Node 22', runtimes: ['node'], optional: ['jsdebug'] },
  'python312-uv': {
    label: `Python ${PYTHON_VERSION}`,
    runtimes: ['uv'],
    optional: ['debugpy'],
    // uv downloads its own standalone CPython into runtimes/python (UV_PYTHON_INSTALL_DIR)
    finish: async (onProgress) => {
      const uv = await ensureRuntime('uv');
      onProgress(`Installing Python ${PYTHON_VERSION}`);
      const binary = join(uv.dir, process.platform === 'win32' ? 'uv.exe' : 'uv');
      const result = await runFile(binary, ['python', 'install', PYTHON_VERSION], { env: buildEnv(uv.path, uv.env), timeoutMs: 15 * 60_000 });
      if (result.code !== 0) throw new AgentError('failed', `uv couldn't install Python ${PYTHON_VERSION}: ${(result.stderr || result.stdout).trim().slice(-400)}`);
      writeFileSync(pythonMarker(), new Date().toISOString());
    },
    finished: () => existsSync(pythonMarker()),
    extraDirs: () => [join(PATHS.runtimes, 'python')],
  },
  'jdk21-maven': { label: 'Java 21', runtimes: ['java', 'maven'] },
  dotnet10: { label: '.NET 10', runtimes: ['dotnet'], optional: ['netcoredbg'] },
  postgres16: { label: 'PostgreSQL 16', runtimes: ['postgres'] },
  mysql84: { label: 'MySQL 8.4', runtimes: ['mysql'] },
};

export function isPackId(value: string): value is PackId {
  return (PACK_IDS as readonly string[]).includes(value);
}

export type PackState = 'installed' | 'missing' | 'unavailable';

export interface PackInfo {
  id: PackId;
  label: string;
  state: PackState;
  /** Bytes on disk when installed */
  sizeBytes: number;
  runtimes: { name: RuntimeName; label: string; installed: boolean; optional: boolean }[];
}

export function packState(id: PackId): PackState {
  const pack = PACKS[id];
  if (!pack.runtimes.every(isAvailable)) return 'unavailable';
  const complete = pack.runtimes.every(isInstalled) && (pack.finished?.() ?? true);
  return complete ? 'installed' : 'missing';
}

export function describePack(id: PackId): PackInfo {
  const pack = PACKS[id];
  const state = packState(id);
  const members = [...pack.runtimes.map((name) => ({ name, optional: false })), ...(pack.optional ?? []).map((name) => ({ name, optional: true }))];
  return {
    id,
    label: pack.label,
    state,
    sizeBytes: state === 'installed' ? packSize(id) : 0,
    runtimes: members.map(({ name, optional }) => ({ name, label: LABELS[name], installed: isInstalled(name), optional })),
  };
}

export function listPacks(): PackInfo[] {
  return PACK_IDS.map(describePack);
}

/** Download and set up a pack; optional members are added when this computer has a build of them */
export async function addPack(id: PackId, onProgress: (detail: string) => void = () => undefined): Promise<PackInfo> {
  const pack = PACKS[id];
  if (packState(id) === 'unavailable') throw new AgentError('failed', `${pack.label} isn't available for this computer`);
  for (const name of pack.runtimes) await ensureRuntime(name, (detail) => onProgress(`${LABELS[name]}: ${detail}`));
  for (const name of pack.optional ?? []) {
    if (!isAvailable(name)) continue;
    await ensureRuntime(name, (detail) => onProgress(`${LABELS[name]}: ${detail}`)).catch((error: Error) =>
      // A debugger that won't download mustn't stop the stack from working
      log.warn(`Optional ${name} for ${id} failed to install`, error.message),
    );
  }
  if (pack.finish && !pack.finished?.()) await pack.finish(onProgress);
  log.info(`Pack ${id} ready`);
  return describePack(id);
}

/** Delete a pack's runtimes. `inUse` are the packs the open session needs: those are refused. */
export function removePack(id: PackId, inUse: Iterable<PackId> = []): void {
  if ([...inUse].includes(id)) throw new AgentError('failed', `${PACKS[id].label} is in use by the open mission; close it first`);
  const pack = PACKS[id];
  for (const name of [...pack.runtimes, ...(pack.optional ?? [])]) {
    // Never delete a runtime another installed pack also lists
    const shared = PACK_IDS.some((other) => other !== id && packState(other) === 'installed' && [...PACKS[other].runtimes, ...(PACKS[other].optional ?? [])].includes(name));
    if (!shared) rmSync(runtimeDir(name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  for (const dir of pack.extraDirs?.() ?? []) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  log.info(`Pack ${id} removed`);
}

/** Bytes a pack uses, remembered next to each runtime (walking a .NET SDK takes a few seconds) */
function packSize(id: PackId): number {
  const pack = PACKS[id];
  let total = 0;
  for (const name of [...pack.runtimes, ...(pack.optional ?? [])]) {
    if (!isInstalled(name)) continue;
    const file = join(runtimeDir(name), '.size');
    let size = existsSync(file) ? Number(readFileSync(file, 'utf8')) : NaN;
    if (!Number.isFinite(size)) {
      size = dirSize(runtimeDir(name));
      writeFileSync(file, String(size));
    }
    total += size;
  }
  for (const dir of pack.extraDirs?.() ?? []) if (existsSync(dir)) total += dirSize(dir);
  return total;
}

/**
 * The packs a workspace needs, derived from workspace.yaml: the backend's runtime, the frontend's Node
 * and a local database engine. SQL Server needs none: it comes from Reneplane's pool.
 */
export function packsFor(workspace: Pick<WorkspaceFile, 'runtimes' | 'services' | 'database'>): PackId[] {
  const packs: PackId[] = [];
  if (workspace.runtimes.node || workspace.services.frontend) packs.push('node22');
  if (workspace.runtimes.python) packs.push('python312-uv');
  if (workspace.runtimes.java) packs.push('jdk21-maven');
  if (workspace.runtimes.dotnet) packs.push('dotnet10');
  if (workspace.database.engine === 'postgres') packs.push('postgres16');
  if (workspace.database.engine === 'mysql') packs.push('mysql84');
  return packs;
}

/** The runtimes a mission starts with: its packs' required members, plus git */
export function runtimesFor(packs: PackId[]): RuntimeName[] {
  return ['git', ...packs.flatMap((id) => PACKS[id].runtimes)];
}
