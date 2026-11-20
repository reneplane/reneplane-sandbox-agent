import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from './config.js';
import { createLogger } from './log.js';
import { agentGit } from './mission/git.js';

/**
 * Reneplane Local 0.2 kept one folder per attempt in missions/, forever (200–300 MB each). 0.3 keeps
 * only open sessions. On its first start it exports each old mission's work (its git diff against the
 * codebank tag) to legacy/<attemptId>.patch and deletes the folder; afterwards, old-style missions an
 * old web page may still open are cleaned up once untouched for 14 days.
 */

const log = createLogger('legacy');
const STALE_MS = 14 * 86_400_000;

export async function exportLegacyMissions(options: { all: boolean; active: string | null }): Promise<string[]> {
  if (!existsSync(PATHS.missions)) return [];
  const exported: string[] = [];
  for (const entry of readdirSync(PATHS.missions, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === options.active) continue;
    const dir = join(PATHS.missions, entry.name);
    const stateFile = join(dir, 'state.json');
    const touched = existsSync(stateFile) ? statSync(stateFile).mtimeMs : statSync(dir).mtimeMs;
    if (!options.all && Date.now() - touched < STALE_MS) continue;
    try {
      const state = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as { open?: { codebank?: { repo: string; ref: string } } }) : {};
      const ref = state.open?.codebank?.ref;
      const repo = join(dir, 'repo');
      if (ref && existsSync(join(repo, '.git'))) {
        const diff = await (await agentGit(repo)).diffSince(ref).catch(() => '');
        if (diff.trim()) {
          mkdirSync(PATHS.legacy, { recursive: true });
          writeFileSync(join(PATHS.legacy, `${entry.name}.patch`), `# Reneplane Local 0.2 mission ${entry.name} (${state.open?.codebank?.repo}@${ref})\n${diff}`);
        }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      exported.push(entry.name);
    } catch (error) {
      log.warn(`Couldn't clean up the old mission ${entry.name} yet`, (error as Error).message);
    }
  }
  if (exported.length) log.info(`Removed ${exported.length} old mission folders (their changes are in ${PATHS.legacy})`);
  return exported;
}
