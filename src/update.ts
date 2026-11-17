import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config.js';
import { createLogger } from './log.js';
import { unpack } from './runtimes/download.js';
import { AGENT_VERSION } from './version.js';

/**
 * Self-update: a few minutes after start and every 6 hours, look at the latest GitHub release. If it's
 * newer, install it beside the running version (bin/app-<version>), point current.json at it, and ask
 * to restart once no mission is running. The supervisor (or launchd/systemd) starts the new version.
 */

const log = createLogger('update');
const REPO = 'reneplane/reneplane-sandbox-agent';
export const RESTART_EXIT_CODE = 75;

export function isNewer(candidate: string, current: string): boolean {
  const parse = (version: string) => version.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(candidate), parse(current)];
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) > (b[index] ?? 0);
  }
  return false;
}

function assetName(): string {
  return `reneplane-local-${process.platform}-${process.arch}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

/** Installed and ready to switch to, or null when already current (or running from source) */
export async function downloadUpdate(): Promise<string | null> {
  if (AGENT_VERSION.endsWith('-dev') || !existsSync(join(PATHS.bin, 'launch.mjs'))) return null;
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'reneplane-local' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) return null;
  const release = (await response.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
  const version = release.tag_name.replace(/^v/, '');
  if (!isNewer(version, AGENT_VERSION)) return null;
  const target = join(PATHS.bin, `app-${version}`);
  if (existsSync(join(target, 'agent.mjs'))) return version;

  const asset = release.assets.find((candidate) => candidate.name === assetName());
  const sums = release.assets.find((candidate) => candidate.name === 'SHA256SUMS');
  if (!asset || !sums) return null;
  const expected = (await (await fetch(sums.browser_download_url)).text())
    .split('\n')
    .find((line) => line.trim().endsWith(` ${asset.name}`))
    ?.split(/\s+/)[0];
  const archive = join(PATHS.downloads, asset.name);
  mkdirSync(PATHS.downloads, { recursive: true });
  const data = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer());
  if (!expected || createHash('sha256').update(data).digest('hex') !== expected) {
    log.warn(`Update ${version} failed its checksum; skipped`);
    return null;
  }
  writeFileSync(archive, data);
  const staging = join(PATHS.downloads, `release-${version}`);
  await unpack(archive, staging, process.platform === 'win32' ? 'zip' : 'tar');
  cpSync(join(staging, 'app'), target, { recursive: true });
  cpSync(join(staging, 'launch.mjs'), join(PATHS.bin, 'launch.mjs'));
  rmSync(staging, { recursive: true, force: true });
  rmSync(archive, { force: true });
  log.info(`Downloaded Reneplane Local ${version}`);
  return version;
}

export function switchTo(version: string): void {
  writeFileSync(join(PATHS.bin, 'current.json'), JSON.stringify({ version }));
}

/** Remove installed versions other than the running one (the previous one stays until next start) */
export function pruneOldVersions(): void {
  const keep = `app-${AGENT_VERSION}`;
  for (const name of existsSync(PATHS.bin) ? readdirSync(PATHS.bin) : []) {
    if (!name.startsWith('app-') || name === keep) continue;
    try {
      rmSync(join(PATHS.bin, name), { recursive: true, force: true });
    } catch {
      // still in use; next time
    }
  }
}
