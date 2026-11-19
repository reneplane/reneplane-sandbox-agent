import { join } from 'node:path';
import { enforceCap, recordUse } from '../cache.js';
import { PATHS } from '../config.js';
import { createLogger } from '../log.js';
import { AgentError, type AgentEvent, type MissionOpen, type MissionPlan, type SessionOpen } from '../protocol.js';
import { Autosaver, type SaveResult } from '../session/autosave.js';
import { keepAsPatch, readMeta, removeSession, SESSION_IDLE_MS, sessionDir, sweepSessions, writeMeta, type SessionMeta } from '../session/store.js';
import { AGENT_VERSION } from '../version.js';
import { Mission, type MissionOptions } from './mission.js';
import { BundleSource, GithubSource } from './source.js';

/**
 * One mission runs at a time.
 *
 * Sessions (protocol 2) come from the engine: a starter bundle, the saved work, a session token. The
 * agent autosaves to Reneplane while one is open; closing it (the IDE closes it, another attempt opens,
 * or no IDE has been connected for 10 minutes of awake time) saves a last time and deletes everything.
 * Missions from public codebanks (protocol 1, Reneplane Local 0.2's way) just stop, as before.
 */

const log = createLogger('missions');
const TICK_MS = 30_000;

/** Hosts starter bundles and autosaves may go to (production agents) */
export const ENGINE_HOSTS = ['reneplane-engine.reneplane.workers.dev', 'engine.reneplane.com', 'reneplane-engine-staging.reneplane.workers.dev'];

export interface MissionClient {
  attemptId: string | null;
  send(event: AgentEvent, data: unknown): void;
}

interface Active {
  mission: Mission;
  /** Present for sessions: the engine's way of saving this attempt's work */
  autosaver: Autosaver | null;
}

export interface ManagerOptions extends MissionOptions {
  /** Cloud mode: sessions lease SQL Server with their own token, and the agent exits after one */
  cloud?: boolean;
  onSessionEnded?: () => void;
}

export class MissionManager {
  private active: Active | null = null;
  private readonly clients = new Set<MissionClient>();
  private idleFor = 0;
  private lastTick = Date.now();
  private readonly ticker: NodeJS.Timeout;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly options: ManagerOptions) {
    // Idle time counts only while the computer is awake: after a sleep the IDE needs a moment to reconnect
    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.ticker.unref();
    this.sweeper = setInterval(() => void this.sweep(), 5 * 60_000);
    this.sweeper.unref();
    void this.sweep();
  }

  attach(client: MissionClient): void {
    this.clients.add(client);
    this.watchState();
  }

  detach(client: MissionClient): void {
    this.clients.delete(client);
    this.watchState();
  }

  async plan(open: MissionOpen | SessionOpen, client: MissionClient): Promise<MissionPlan> {
    if (this.active && this.active.mission.attemptId !== open.attemptId) {
      const previous = this.active;
      this.active = null;
      this.broadcast(previous.mission.attemptId, 'mission.stopped', { reason: 'Another mission was opened on this computer.' });
      for (const other of this.clients) if (other.attemptId === previous.mission.attemptId) other.attemptId = null;
      await this.end(previous);
    }
    if ('session' in open) this.refreshSession(open);
    if (!this.active) this.active = 'session' in open ? this.openSession(open) : this.openLegacy(open);
    client.attemptId = open.attemptId;
    this.watchState();
    return this.active.mission.plan();
  }

  private openLegacy(open: MissionOpen): Active {
    const attemptId = open.attemptId;
    const source = new GithubSource(open.codebank, this.options.dev ? this.options.codebankDir : undefined);
    return { mission: new Mission(open, source, (event, data) => this.broadcast(attemptId, event, data), this.options), autosaver: null };
  }

  private openSession(open: SessionOpen): Active {
    const { attemptId, session } = open;
    if (!versionAtLeast(AGENT_VERSION, session.minAgentVersion)) {
      throw new AgentError('outdated', `This problem needs Reneplane Local ${session.minAgentVersion} or newer (this is ${AGENT_VERSION}). Run: reneplane-local update`);
    }
    const allowedHosts = this.options.dev ? [...ENGINE_HOSTS, 'localhost', '127.0.0.1'] : ENGINE_HOSTS;
    for (const url of [session.autosaveUrl]) {
      const host = new URL(url).hostname;
      if (!allowedHosts.includes(host)) throw new AgentError('bad_request', `Work is only saved to Reneplane (refused ${host})`);
    }
    const source = new BundleSource(session.bundle, { dir: join(sessionDir(attemptId), 'bundle'), dev: this.options.dev, allowedHosts: ENGINE_HOSTS, templateRef: session.templateRef ?? undefined });
    const options = { ...this.options, root: PATHS.sessions, ...(this.options.cloud ? { leaseToken: () => readMeta(attemptId)?.token ?? null } : {}) };
    const mission = new Mission(open, source, (event, data) => this.broadcast(attemptId, event, data), options, session.saved.diff);
    const meta = readMeta(attemptId)!;
    const autosaver = new Autosaver(meta, session.saved.diff, () => mission.gitDiff(), (result, target) => this.saved(attemptId, result, target));
    mission.onChange(() => autosaver.touch());
    mission.onBooted(() => {
      autosaver.start(session.autosaveSeconds);
      recordUse(mission.packs());
    });
    return { mission, autosaver };
  }

  /** The IDE opened the session again (a new session token from the engine): remember where to save */
  private refreshSession(open: SessionOpen): void {
    const meta: SessionMeta = {
      attemptId: open.attemptId,
      missionId: open.missionId,
      variantId: open.variantId,
      autosaveUrl: open.session.autosaveUrl,
      token: open.session.token,
      revision: Math.max(open.session.saved.revision, readMeta(open.attemptId)?.revision ?? 0),
      activeAt: new Date().toISOString(),
      unsyncedSince: null,
    };
    writeMeta(meta);
    const autosaver = this.active?.mission.attemptId === open.attemptId ? this.active.autosaver : null;
    autosaver?.retarget(meta.token, meta.revision);
  }

  private saved(attemptId: string, result: SaveResult, target: { revision: number }): void {
    const meta = readMeta(attemptId);
    if (meta && result.revision !== undefined) writeMeta({ ...meta, revision: target.revision, activeAt: new Date().toISOString() });
    if (result.outcome === 'saved' || result.outcome === 'unchanged') {
      this.broadcast(attemptId, 'session.saved', { attemptId, revision: result.revision, savedAt: result.savedAt ?? null });
    } else {
      this.broadcast(attemptId, 'session.saved', { attemptId, error: result.outcome, message: result.message ?? null });
      if (result.outcome === 'replaced') this.broadcast(attemptId, 'mission.stopped', { reason: 'This attempt was opened somewhere else; this copy no longer saves.' });
    }
  }

  mission(client: MissionClient): Mission {
    if (!this.active || client.attemptId !== this.active.mission.attemptId) {
      throw new AgentError('no_mission', 'Open the mission first');
    }
    return this.active.mission;
  }

  current(): Mission | null {
    return this.active?.mission ?? null;
  }

  async close(attemptId: string): Promise<void> {
    if (this.active?.mission.attemptId !== attemptId) return;
    const active = this.active;
    this.active = null;
    await this.end(active);
  }

  /**
   * The end of a mission. Sessions: one last save, then delete everything; if the save can't get
   * through, stop everything but keep the files, and let the sweeper keep trying.
   */
  private async end(active: Active): Promise<void> {
    const { mission, autosaver } = active;
    if (!autosaver) {
      await mission.suspend();
      return;
    }
    autosaver.stop();
    const result = mission.isRunning || mission.hasFiles ? await autosaver.save() : { outcome: 'unchanged' as const };
    const meta = readMeta(mission.attemptId);
    if (result.outcome === 'saved' || result.outcome === 'unchanged') {
      await mission.dispose();
      removeSession(mission.attemptId);
      log.info(`Session ${mission.attemptId} closed: work saved (revision ${autosaver.revision}), files deleted`);
    } else if (result.outcome === 'offline') {
      await mission.suspend();
      await mission.destroyDatabase();
      if (meta) writeMeta({ ...meta, unsyncedSince: new Date().toISOString() });
      log.warn(`Session ${mission.attemptId} closed offline: its files stay until the work reaches Reneplane`);
    } else {
      await mission.suspend();
      await keepAsPatch(mission.attemptId, result.outcome === 'replaced' ? 'the attempt was opened somewhere else' : result.message ?? result.outcome);
      await mission.dispose();
      removeSession(mission.attemptId);
    }
    enforceCap(this.active !== null);
    this.options.onSessionEnded?.();
  }

  async shutdown(): Promise<void> {
    clearInterval(this.ticker);
    clearInterval(this.sweeper);
    // Stopping the agent (an update, a restart) isn't closing the session: save, stop, keep the files
    const active = this.active;
    this.active = null;
    if (active?.autosaver) {
      active.autosaver.stop();
      await active.autosaver.save().catch(() => undefined);
    }
    await active?.mission.suspend();
  }

  private broadcast(attemptId: string, event: AgentEvent, data: unknown): void {
    for (const client of this.clients) if (client.attemptId === attemptId) client.send(event, data);
  }

  /** Events every connected IDE hears (packs being added) */
  broadcastAll(event: AgentEvent, data: unknown): void {
    for (const client of this.clients) client.send(event, data);
  }

  private watched(): boolean {
    const mission = this.active?.mission;
    return Boolean(mission && [...this.clients].some((client) => client.attemptId === mission.attemptId));
  }

  private watchState(): void {
    if (this.active) this.active.mission.watched = this.watched();
    if (this.watched()) {
      this.idleFor = 0;
      const meta = this.active?.autosaver ? readMeta(this.active.mission.attemptId) : null;
      if (meta) writeMeta({ ...meta, activeAt: new Date().toISOString() });
    }
  }

  private tick(): void {
    const now = Date.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    const active = this.active;
    if (!active || this.watched()) {
      this.idleFor = 0;
      return;
    }
    // A long gap between ticks is the computer sleeping: it doesn't count as idle
    if (elapsed < TICK_MS * 3) this.idleFor += elapsed;
    if (this.idleFor < SESSION_IDLE_MS) return;
    this.idleFor = 0;
    if (active.autosaver) {
      log.info(`No IDE connected for ${Math.round(SESSION_IDLE_MS / 60000)} minutes; closing session ${active.mission.attemptId}`);
      this.active = null;
      void this.end(active);
    } else if (active.mission.isRunning) {
      log.info(`No IDE connected for ${Math.round(SESSION_IDLE_MS / 60000)} minutes; stopping ${active.mission.attemptId} to free memory`);
      void active.mission.suspend();
    }
  }

  private async sweep(): Promise<void> {
    try {
      await sweepSessions(this.active?.mission.attemptId ?? null);
      enforceCap(this.active !== null);
    } catch (error) {
      log.warn('Session sweep failed', (error as Error).message);
    }
  }

  /** Packs the open session needs (removing one under it is refused) */
  packsInUse(): string[] {
    return this.active?.mission.isRunning ? this.active.mission.packs() : [];
  }
}

/** a ≥ b for x.y.z versions; dev builds (0.0.0-dev) satisfy anything */
export function versionAtLeast(a: string, b: string): boolean {
  if (a.startsWith('0.0.0')) return true;
  const parse = (value: string) => value.split('-')[0]!.split('.').map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index += 1) {
    if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0);
  }
  return true;
}
