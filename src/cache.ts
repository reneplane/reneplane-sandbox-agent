import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PATHS } from './config.js';
import { createLogger } from './log.js';
import type { PackId } from './packs/index.js';
import { dirSize } from './util/disk.js';

/**
 * The shared cache of public packages (npm, uv, the Maven repository, NuGet) and starter bundles.
 * Sessions install from it, so reopening a problem doesn't download the world again; it holds no
 * problem data. It's capped (3 GB by default, `config cacheCapGB`): when over, whole ecosystems go,
 * least recently used first, and only while no session is open (a session's installs point into it).
 */

const log = createLogger('cache');

export const ECOSYSTEMS = { npm: 'npm', uv: 'uv', maven: 'm2', nuget: 'nuget' } as const;
export type Ecosystem = keyof typeof ECOSYSTEMS;

const ECOSYSTEM_OF: Partial<Record<PackId, Ecosystem>> = { node22: 'npm', 'python312-uv': 'uv', 'jdk21-maven': 'maven', dotnet10: 'nuget' };
const usageFile = () => join(PATHS.cache, 'usage.json');

function readUsage(): Partial<Record<Ecosystem, string>> {
  try {
    return JSON.parse(readFileSync(usageFile(), 'utf8')) as Partial<Record<Ecosystem, string>>;
  } catch {
    return {};
  }
}

/** A session with these packs started: their ecosystems were just used */
export function recordUse(packs: PackId[]): void {
  const usage = readUsage();
  const now = new Date().toISOString();
  for (const pack of packs) {
    const ecosystem = ECOSYSTEM_OF[pack];
    if (ecosystem) usage[ecosystem] = now;
  }
  mkdirSync(PATHS.cache, { recursive: true });
  writeFileSync(usageFile(), JSON.stringify(usage, null, 2));
}

export interface CacheUsage {
  bytes: number;
  capBytes: number;
  ecosystems: { name: Ecosystem | 'bundles'; bytes: number; lastUsed: string | null }[];
}

export function cacheUsage(): CacheUsage {
  const usage = readUsage();
  const ecosystems = (Object.keys(ECOSYSTEMS) as Ecosystem[]).map((name) => ({ name, bytes: dirSize(join(PATHS.cache, ECOSYSTEMS[name])), lastUsed: usage[name] ?? null }));
  const bundles = { name: 'bundles' as const, bytes: dirSize(PATHS.bundles), lastUsed: null };
  const all = [...ecosystems, bundles];
  return { bytes: all.reduce((sum, item) => sum + item.bytes, 0), capBytes: loadConfig().cacheCapGB * 1024 ** 3, ecosystems: all };
}

/** Starter bundles not used for 30 days: a reopened attempt just downloads its own again */
function pruneBundles(): void {
  if (!existsSync(PATHS.bundles)) return;
  const cutoff = Date.now() - 30 * 86_400_000;
  for (const name of readdirSync(PATHS.bundles)) {
    const file = join(PATHS.bundles, name);
    if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
  }
}

/** Bring the cache under its cap. `sessionOpen`: do nothing while a session may be installing from it. */
export function enforceCap(sessionOpen: boolean): string[] {
  if (sessionOpen) return [];
  pruneBundles();
  const current = cacheUsage();
  const removed: string[] = [];
  let total = current.bytes;
  const candidates = current.ecosystems
    .filter((item): item is (typeof current.ecosystems)[number] & { name: Ecosystem } => item.name !== 'bundles' && item.bytes > 0)
    .sort((a, b) => (a.lastUsed ?? '').localeCompare(b.lastUsed ?? ''));
  for (const item of candidates) {
    if (total <= current.capBytes) break;
    try {
      rmSync(join(PATHS.cache, ECOSYSTEMS[item.name]), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      total -= item.bytes;
      removed.push(item.name);
    } catch (error) {
      log.warn(`Couldn't clear the ${item.name} cache`, (error as Error).message);
    }
  }
  if (removed.length) log.info(`Cache over ${Math.round(current.capBytes / 1024 ** 3)} GB: cleared ${removed.join(', ')} (least recently used)`);
  return removed;
}

/** `reneplane-local clean`: every cache and every bundle */
export function clearCache(): void {
  for (const dir of [...Object.values(ECOSYSTEMS), 'bundles']) rmSync(join(PATHS.cache, dir), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  rmSync(usageFile(), { force: true });
}
