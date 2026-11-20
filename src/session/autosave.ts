import { createHash } from 'node:crypto';
import { createLogger } from '../log.js';
import { AGENT_VERSION } from '../version.js';

/**
 * Saving the learner's work on Reneplane: the agent is the only writer (it works with the tab closed,
 * and the same way in a cloud agent). Every few seconds, if files changed, the diff against the
 * starter goes to the engine with the session token. The engine keeps revisions: a save from a session
 * the learner has since reopened elsewhere is refused (`replaced`), never merged.
 */

const log = createLogger('autosave');

export const MAX_SAVED_DIFF = 200_000;

export type SaveOutcome = 'saved' | 'unchanged' | 'offline' | 'replaced' | 'expired' | 'too_large' | 'rejected';

export interface SaveTarget {
  attemptId: string;
  autosaveUrl: string;
  token: string;
  revision: number;
}

export interface SaveResult {
  outcome: SaveOutcome;
  revision?: number;
  savedAt?: string;
  message?: string;
}

export function hashDiff(diff: string): string {
  return createHash('sha256').update(diff).digest('hex');
}

/** One PUT to the engine, with what each answer means for the session */
export async function sendSave(target: SaveTarget, diff: string): Promise<SaveResult> {
  if (diff.length > MAX_SAVED_DIFF) return { outcome: 'too_large', message: `Your changes are over ${MAX_SAVED_DIFF / 1000} KB; generated files may be included` };
  let response: Response;
  try {
    response = await fetch(target.autosaveUrl, {
      method: 'PUT',
      headers: { authorization: `Bearer ${target.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ baseRevision: target.revision, diff, agentVersion: AGENT_VERSION }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { outcome: 'offline', message: (error as Error).message };
  }
  const body = (await response.json().catch(() => ({}))) as { revision?: number; savedAt?: string; error?: string; message?: string };
  if (response.ok) return { outcome: body.revision === target.revision ? 'unchanged' : 'saved', revision: body.revision, savedAt: body.savedAt };
  if (body.error === 'session_replaced' || body.error === 'stale_revision') return { outcome: 'replaced', message: body.message };
  if (response.status === 401) return { outcome: 'expired', message: body.message };
  if (response.status === 413 || response.status === 400) return { outcome: 'too_large', message: body.message };
  if (response.status >= 500 || response.status === 429) return { outcome: 'offline', message: body.message ?? `HTTP ${response.status}` };
  return { outcome: 'rejected', message: body.message ?? `HTTP ${response.status}` };
}

export class Autosaver {
  private timer: NodeJS.Timeout | null = null;
  private saving: Promise<SaveResult> | null = null;
  private dirty = true;
  private lastHash: string;
  stopped = false;

  constructor(
    private readonly target: SaveTarget,
    savedDiff: string | null,
    private readonly diff: () => Promise<string>,
    private readonly onResult: (result: SaveResult, target: SaveTarget) => void,
  ) {
    this.lastHash = hashDiff(savedDiff ?? '');
  }

  get revision(): number {
    return this.target.revision;
  }

  /** The IDE reopened the session: a newer token (and the engine's latest revision) */
  retarget(token: string, revision: number): void {
    this.target.token = token;
    this.target.revision = Math.max(this.target.revision, revision);
    this.stopped = false;
  }

  /** Something in the working tree changed */
  touch(): void {
    this.dirty = true;
  }

  start(seconds: number): void {
    this.timer ??= setInterval(() => {
      if (this.dirty && !this.saving && !this.stopped) void this.save();
    }, seconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Save now (also what closing a session does last) */
  save(): Promise<SaveResult> {
    this.saving ??= this.run().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async run(): Promise<SaveResult> {
    if (this.stopped) return { outcome: 'replaced' };
    this.dirty = false;
    let diff: string;
    try {
      diff = await this.diff();
    } catch (error) {
      this.dirty = true;
      return { outcome: 'rejected', message: `Couldn't read your changes: ${(error as Error).message}` };
    }
    const hash = hashDiff(diff);
    if (hash === this.lastHash) return { outcome: 'unchanged', revision: this.target.revision };
    const result = await sendSave(this.target, diff);
    if (result.outcome === 'saved' || result.outcome === 'unchanged') {
      this.lastHash = hash;
      if (result.revision !== undefined) this.target.revision = result.revision;
    } else {
      // Try again on the next tick (unless the session is over)
      this.dirty = true;
      if (result.outcome === 'replaced' || result.outcome === 'expired') {
        this.stopped = true;
        this.stop();
      }
      log.warn(`Autosave for ${this.target.attemptId}: ${result.outcome}${result.message ? ` (${result.message})` : ''}`);
    }
    this.onResult(result, this.target);
    return result;
  }
}
