import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  sha256?: string;
  sha512?: string;
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
  uv: 'Python (uv)',
  java: 'Java (Temurin JDK)',
  maven: 'Maven',
  mysql: 'MySQL',
  dotnet: '.NET SDK',
  jsdebug: 'JavaScript debugger',
  debugpy: 'Python debugger (debugpy)',
  netcoredbg: '.NET debugger (netcoredbg)',
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
  if (!found) throw new Error(`${LABELS[name]} isn't available for ${describePlatform()} yet, so this mission can't run on this computer.`);
  return found;
}

/** Where a runtime is (or would be) unpacked */
export function runtimeDir(name: RuntimeName): string {
  return dirOf(name);
}

function dirOf(name: RuntimeName): string {
  return join(PATHS.runtimes, `${name}-${runtimeVersion(name)}`);
}

export function isInstalled(name: RuntimeName): boolean {
  return existsSync(join(dirOf(name), '.complete'));
}

/** Available for this computer at all (some runtimes have no build for Intel Macs) */
export function isAvailable(name: RuntimeName): boolean {
  return Boolean((manifest[name].platforms as Record<string, PlatformEntry>)[platformKey()]);
}

const installing = new Map<RuntimeName, Promise<Runtime>>();

/** The runtime, downloading and unpacking it the first time */
export function ensureRuntime(name: RuntimeName, onProgress?: (detail: string) => void): Promise<Runtime> {
  if (isInstalled(name)) return Promise.resolve(describe(name));
  const pending = installing.get(name);
  if (pending) return pending;
  const work = withInstallLock(name, () => install(name, onProgress), onProgress).finally(() => installing.delete(name));
  installing.set(name, work);
  return work;
}

async function install(name: RuntimeName, onProgress?: (detail: string) => void): Promise<Runtime> {
  // Another process may have finished it while this one waited for the lock
  if (isInstalled(name)) return describe(name);
  const platform = entry(name);
  const dir = dirOf(name);
  const archive = join(PATHS.downloads, platform.url.split('/').pop()!);
  log.info(`Installing ${name} ${runtimeVersion(name)} from ${platform.url}`);
  const checksum = platform.sha512 ? { algorithm: 'sha512' as const, value: platform.sha512 } : { algorithm: 'sha256' as const, value: platform.sha256! };
  await downloadVerified(platform.url, checksum, archive, onProgress);
  onProgress?.('Unpacking');
  await unpack(archive, dir, platform.format, platform.strip);
  writeFileSync(join(dir, '.complete'), new Date().toISOString());
  // The archive has done its job: keeping it would double the runtime's size on disk
  rmSync(archive, { force: true });
  log.info(`Installed ${name} into ${dir}`);
  return describe(name);
}

/**
 * One install of a runtime at a time across processes (the agent and a `reneplane-local add` in a
 * terminal): unpacking replaces a staging folder the other would be using. The lock is a folder,
 * created atomically; one older than 20 minutes belongs to a process that died, and is taken over.
 */
async function withInstallLock<T>(name: RuntimeName, work: () => Promise<T>, onProgress?: (detail: string) => void): Promise<T> {
  const lock = `${dirOf(name)}.lock`;
  mkdirSync(PATHS.runtimes, { recursive: true });
  for (let waited = 0; ; waited += 1) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 20 * 60_000) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (waited === 0) onProgress?.('Waiting for another download of the same runtime');
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Delete what an update left behind: runtime versions the manifest no longer lists, leftover archives
 * and half-unpacked folders. Runs at agent start, before any mission uses a runtime. `python` is uv's
 * interpreter folder (the Python pack), not a manifest runtime, so it stays.
 */
export function pruneRuntimes(): string[] {
  const names = Object.keys(manifest) as RuntimeName[];
  const keep = new Set(names.map((name) => `${name}-${runtimeVersion(name)}`));
  const removed: string[] = [];
  for (const item of existsSync(PATHS.runtimes) ? readdirSync(PATHS.runtimes) : []) {
    if (item === 'python' || item === '.downloads' || keep.has(item) || item.endsWith('.lock')) continue;
    const stale = item.endsWith('.unpacking') || names.some((name) => item.startsWith(`${name}-`));
    if (!stale) continue;
    try {
      rmSync(join(PATHS.runtimes, item), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed.push(item);
    } catch (error) {
      log.warn(`Could not remove the old runtime ${item}; is it still in use?`, error);
    }
  }
  for (const file of existsSync(PATHS.downloads) ? readdirSync(PATHS.downloads) : []) {
    rmSync(join(PATHS.downloads, file), { recursive: true, force: true });
    removed.push(`.downloads/${file}`);
  }
  if (removed.length) log.info(`Removed ${removed.length} leftover runtime files: ${removed.join(', ')}`);
  return removed;
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
    case 'uv':
      return {
        name,
        version,
        dir,
        path: [dir],
        env: {
          UV_CACHE_DIR: join(PATHS.cache, 'uv'),
          UV_PYTHON_INSTALL_DIR: join(PATHS.runtimes, 'python'),
          // Never pick up a Python the learner installed; the mission's version comes from uv
          UV_PYTHON_PREFERENCE: 'only-managed',
          UV_LINK_MODE: 'copy',
          UV_NO_PROGRESS: '1',
        },
      };
    case 'java': {
      const home = process.platform === 'darwin' ? join(dir, 'Contents', 'Home') : dir;
      return {
        name,
        version,
        dir,
        path: [join(home, 'bin')],
        env: {
          JAVA_HOME: home,
          // Maven's own files (a codebank's mvnw keeps its download here) are tool state, never evicted;
          // the repository of downloaded libraries is the shared, capped cache
          MAVEN_USER_HOME: join(PATHS.state, 'maven'),
          MAVEN_OPTS: `-Dmaven.repo.local=${join(PATHS.cache, 'm2')}`,
        },
      };
    }
    case 'maven':
      return { name, version, dir, path: [join(dir, 'bin')], env: { MAVEN_HOME: dir } };
    case 'mysql':
      return { name, version, dir, path: [join(dir, 'bin')], env: {} };
    case 'dotnet':
      return {
        name,
        version,
        dir,
        path: [dir],
        env: {
          DOTNET_ROOT: dir,
          DOTNET_CLI_HOME: join(PATHS.state, 'dotnet-home'),
          NUGET_PACKAGES: join(PATHS.cache, 'nuget'),
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
          DOTNET_NOLOGO: '1',
          DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
          DOTNET_MULTILEVEL_LOOKUP: '0',
          // No build servers left running after a command: they keep bin/ and obj/ locked, and a
          // session folder must be deletable the moment the session ends
          MSBUILDDISABLENODEREUSE: '1',
          DOTNET_CLI_USE_MSBUILD_SERVER: '0',
          UseSharedCompilation: 'false',
        },
      };
    // Debug adapters: started by the agent itself, nothing goes on the mission's PATH
    case 'jsdebug':
    case 'debugpy':
    case 'netcoredbg':
      return { name, version, dir, path: [], env: {} };
  }
}

function describePlatform(): string {
  const os = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform as string] ?? process.platform;
  const arch = process.platform === 'darwin' ? (process.arch === 'arm64' ? ' (Apple Silicon)' : ' (Intel)') : process.arch === 'arm64' ? ' on Arm' : '';
  return `${os}${arch}`;
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
