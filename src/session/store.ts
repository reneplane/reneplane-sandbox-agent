import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATHS } from '../config.js';
import { createLogger } from '../log.js';
import { agentGit } from '../mission/git.js';
import { START_TAG } from '../mission/source.js';
import { dirSize } from '../util/disk.js';
import { sendSave, type SaveTarget } from './autosave.js';

/**
 * Sessions on disk. A session's folder lives only while it's open: closing it saves the work on
 * Reneplane and deletes everything. When the last save couldn't get through (offline), the folder
 * stays as "unsynced" and the sweeper keeps trying, at start and every few minutes; nothing a learner
 * wrote is deleted before it reached Reneplane or was kept as a patch in legacy/.
 *
 *   sessions/<attemptId>/
 *     session.json   where and how to save (the session token: readable only by this user)
 *     bundle/ repo/ db/ out/ state.json      the mission itself
 */

const log = createLogger('sessions');

export interface SessionMeta extends SaveTarget {
  missionId: string;
  variantId: string;
  /** Last time an IDE was connected (the sweeper leaves recent sessions for their IDE to come back to) */
  activeAt: string;
  /** Set when closing couldn't save: the folder waits for the next try */
  unsyncedSince: string | null;
}

/** How long a session with no IDE stays open (also the agent's idle stop) */
export const SESSION_IDLE_MS = Number(process.env.RENEPLANE_IDLE_MS ?? 10 * 60_000);
const MAX_UNSYNCED = 3;

export function sessionDir(attemptId: string): string {
  return join(PATHS.sessions, attemptId);
}

export function readMeta(attemptId: string): SessionMeta | null {
  const file = join(sessionDir(attemptId), 'session.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as SessionMeta;
  } catch {
    return null;
  }
}

export function writeMeta(meta: SessionMeta): void {
  mkdirSync(sessionDir(meta.attemptId), { recursive: true });
  writeFileSync(join(sessionDir(meta.attemptId), 'session.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
}

export interface SessionOnDisk {
  attemptId: string;
  bytes: number;
  unsynced: boolean;
}

export function sessionsOnDisk(): SessionOnDisk[] {
  if (!existsSync(PATHS.sessions)) return [];
  return readdirSync(PATHS.sessions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ attemptId: entry.name, bytes: dirSize(join(PATHS.sessions, entry.name)), unsynced: Boolean(readMeta(entry.name)?.unsyncedSince) }));
}

/** The learner's changes in a session's repo, against the starter */
async function diffOf(attemptId: string): Promise<string | null> {
  const repo = join(sessionDir(attemptId), 'repo');
  if (!existsSync(join(repo, '.git'))) return null;
  const git = await agentGit(repo);
  return git.diffSince(START_TAG).catch(() => null);
}

/** Keep a session's work as a patch in legacy/ (it couldn't be saved on Reneplane) */
export async function keepAsPatch(attemptId: string, why: string): Promise<string | null> {
  const diff = await diffOf(attemptId);
  if (!diff?.trim()) return null;
  mkdirSync(PATHS.legacy, { recursive: true });
  const file = join(PATHS.legacy, `${attemptId}-${Date.now()}.patch`);
  writeFileSync(file, `# Reneplane: work from attempt ${attemptId} that couldn't be saved (${why}).\n# Apply it in a fresh copy of the attempt with: git apply <this file>\n${diff}`);
  log.warn(`Kept ${attemptId}'s unsaved work in ${file} (${why})`);
  return file;
}

export function removeSession(attemptId: string): boolean {
  try {
    rmSync(sessionDir(attemptId), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    return true;
  } catch (error) {
    log.warn(`Couldn't delete session ${attemptId} yet (files still in use?)`, (error as Error).message);
    return false;
  }
}

/**
 * Sessions not open in this agent: save what can be saved and delete them, keep trying the ones that
 * are offline, and turn the rest into patches. `active` is the attempt the agent has open now.
 */
export async function sweepSessions(active: string | null): Promise<void> {
  if (!existsSync(PATHS.sessions)) return;
  const now = Date.now();
  const unsynced: { attemptId: string; since: number }[] = [];
  for (const entry of readdirSync(PATHS.sessions, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === active) continue;
    const attemptId = entry.name;
    const meta = readMeta(attemptId);
    if (!meta) {
      // A folder from a session that never got going (or a crash mid-open)
      const age = now - statSync(sessionDir(attemptId)).mtimeMs;
      if (age > SESSION_IDLE_MS) {
        await keepAsPatch(attemptId, 'its session details were missing');
        removeSession(attemptId);
      }
      continue;
    }
    // Recently used and not given up on: its IDE may come back (an agent update restarted us)
    if (!meta.unsyncedSince && now - Date.parse(meta.activeAt) < SESSION_IDLE_MS) continue;
    const diff = await diffOf(attemptId);
    if (diff === null) {
      removeSession(attemptId);
      continue;
    }
    const result = await sendSave(meta, diff);
    if (result.outcome === 'saved' || result.outcome === 'unchanged') {
      log.info(`Saved ${attemptId}'s work (revision ${result.revision}) and removed its folder`);
      removeSession(attemptId);
    } else if (result.outcome === 'offline') {
      if (!meta.unsyncedSince) writeMeta({ ...meta, unsyncedSince: new Date().toISOString() });
      unsynced.push({ attemptId, since: Date.parse(meta.unsyncedSince ?? new Date().toISOString()) });
    } else {
      await keepAsPatch(attemptId, result.outcome === 'replaced' ? 'the attempt was opened somewhere else' : result.message ?? result.outcome);
      removeSession(attemptId);
    }
  }
  // Offline for a long time: keep the newest few folders, the rest as patches
  for (const { attemptId } of unsynced.sort((a, b) => b.since - a.since).slice(MAX_UNSYNCED)) {
    await keepAsPatch(attemptId, 'too many sessions were waiting to be saved');
    removeSession(attemptId);
  }
}
