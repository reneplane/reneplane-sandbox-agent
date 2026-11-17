import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { createLogger } from '../log.js';
import type { Env } from '../util/process.js';
import { downloadVerified, unpack, type ArchiveFormat } from './download.js';
import manifest from './manifest.json' with { type: 'json' };

/**
 * Portable runtimes, downloaded on first use into ~/.reneplane/runtimes/<name>-<version>/ and kept.
 * Nothing is installed system-wide and nothing needs admin rights.
 */

const log = createLogger('runtimes');

export type RuntimeName = keyof typeof manifest;

interface PlatformEntry {
  url: string;
  sha256: string;
  format: ArchiveFormat;
  strip?: string;
}

export interface Runtime {
  name: RuntimeName;
  version: string;
  dir: string;
  /** Put these first on PATH */
  path: string[];
  /** Extra variables this runtime needs */
  env: Env;
}

export const LABELS: Record<RuntimeName, string> = {
  node: 'Node.js',
  postgres: 'PostgreSQL',
  git: 'Git',
};

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function runtimeVersion(name: RuntimeName): string {
  return manifest[name].version;
}

function entry(name: RuntimeName): PlatformEntry {
  const platforms = manifest[name].platforms as Record<string, PlatformEntry>;
  const found = platforms[platformKey()];
  if (!found) throw new Error(`${LABELS[name]} isn't available for ${platformKey()} yet`);
  return found;
}

function dirOf(name: RuntimeName): string {
  return join(PATHS.runtimes, `${name}-${runtimeVersion(name)}`);
}

export function isInstalled(name: RuntimeName): boolean {
  return existsSync(join(dirOf(name), '.complete'));
}

const installing = new Map<RuntimeName, Promise<Runtime>>();

/** The runtime, downloading and unpacking it the first time */
export function ensureRuntime(name: RuntimeName, onProgress?: (detail: string) => void): Promise<Runtime> {
  if (isInstalled(name)) return Promise.resolve(describe(name));
  const pending = installing.get(name);
  if (pending) return pending;
  const work = install(name, onProgress).finally(() => installing.delete(name));
  installing.set(name, work);
  return work;
}

async function install(name: RuntimeName, onProgress?: (detail: string) => void): Promise<Runtime> {
  const platform = entry(name);
  const dir = dirOf(name);
  const archive = join(PATHS.downloads, platform.url.split('/').pop()!);
  log.info(`Installing ${name} ${runtimeVersion(name)} from ${platform.url}`);
  await downloadVerified(platform.url, platform.sha256, archive, onProgress);
  onProgress?.('Unpacking');
  await unpack(archive, dir, platform.format, platform.strip);
  writeFileSync(join(dir, '.complete'), new Date().toISOString());
  log.info(`Installed ${name} into ${dir}`);
  return describe(name);
}

function describe(name: RuntimeName): Runtime {
  const dir = dirOf(name);
  const version = runtimeVersion(name);
  const windows = process.platform === 'win32';
  switch (name) {
    case 'node':
      return { name, version, dir, path: [windows ? dir : join(dir, 'bin')], env: {} };
    case 'postgres':
      return { name, version, dir, path: [join(dir, 'bin')], env: {} };
    case 'git':
      return gitRuntime(dir, version);
  }
}

/** The same environment GitHub Desktop's dugite sets up for its bundled Git */
function gitRuntime(dir: string, version: string): Runtime {
  if (process.platform === 'win32') {
    return {
      name: 'git',
      version,
      dir,
      path: [join(dir, 'cmd'), join(dir, 'mingw64', 'bin'), join(dir, 'usr', 'bin')],
      env: { GIT_EXEC_PATH: join(dir, 'mingw64', 'libexec', 'git-core') },
    };
  }
  const env: Env = { GIT_EXEC_PATH: join(dir, 'libexec', 'git-core'), PREFIX: dir };
  if (process.platform === 'linux') {
    env.GIT_SSL_CAINFO = join(dir, 'ssl', 'cacert.pem');
    env.GIT_TEMPLATE_DIR = join(dir, 'share', 'git-core', 'templates');
  }
  return { name: 'git', version, dir, path: [join(dir, 'bin')], env };
}

/** The git executable inside the bundled runtime */
export function gitBinary(runtime: Runtime): string {
  return process.platform === 'win32' ? join(runtime.dir, 'cmd', 'git.exe') : join(runtime.dir, 'bin', 'git');
}

export function installedRuntimes(): { name: RuntimeName; version: string; installed: boolean }[] {
  return (Object.keys(manifest) as RuntimeName[]).map((name) => ({ name, version: runtimeVersion(name), installed: isInstalled(name) }));
}
