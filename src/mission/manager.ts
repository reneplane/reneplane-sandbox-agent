import { createLogger } from '../log.js';
import { AgentError, type AgentEvent, type MissionOpen, type MissionPlan } from '../protocol.js';
import { Mission, type MissionOptions } from './mission.js';

/**
 * One mission runs at a time. Opening another stops the first (its files stay). When no IDE tab has
 * been connected to the running mission for 10 minutes, its programs stop to free memory.
 */

const log = createLogger('missions');
const IDLE_MS = Number(process.env.RENEPLANE_IDLE_MS ?? 10 * 60_000);

export interface MissionClient {
  attemptId: string | null;
  send(event: AgentEvent, data: unknown): void;
}

export class MissionManager {
  private active: Mission | null = null;
  private readonly clients = new Set<MissionClient>();
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: MissionOptions) {}

  attach(client: MissionClient): void {
    this.clients.add(client);
    this.checkIdle();
  }

  detach(client: MissionClient): void {
    this.clients.delete(client);
    this.checkIdle();
  }

  async plan(open: MissionOpen, client: MissionClient): Promise<MissionPlan> {
    if (this.active && this.active.attemptId !== open.attemptId) {
      const previous = this.active;
      this.active = null;
      this.broadcast(previous.attemptId, 'mission.stopped', { reason: 'Another mission was opened on this computer.' });
      for (const other of this.clients) if (other.attemptId === previous.attemptId) other.attemptId = null;
      await previous.suspend();
    }
    if (!this.active) {
      const attemptId = open.attemptId;
      this.active = new Mission(open, (event, data) => this.broadcast(attemptId, event, data), this.options);
    }
    client.attemptId = open.attemptId;
    this.checkIdle();
    return this.active.plan();
  }

  mission(client: MissionClient): Mission {
    if (!this.active || client.attemptId !== this.active.attemptId) {
      throw new AgentError('no_mission', 'Open the mission first');
    }
    return this.active;
  }

  current(): Mission | null {
    return this.active;
  }

  async close(attemptId: string): Promise<void> {
    if (this.active?.attemptId !== attemptId) return;
    const mission = this.active;
    this.active = null;
    await mission.suspend();
  }

  async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.active?.suspend();
    this.active = null;
  }

  private broadcast(attemptId: string, event: AgentEvent, data: unknown): void {
    for (const client of this.clients) if (client.attemptId === attemptId) client.send(event, data);
  }

  private checkIdle(): void {
    const mission = this.active;
    const watched = mission && [...this.clients].some((client) => client.attemptId === mission.attemptId);
    if (mission) mission.watched = Boolean(watched);
    if (watched || !mission) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = null;
      return;
    }
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active !== mission) return;
      log.info(`No IDE connected for ${Math.round(IDLE_MS / 60000)} minutes; stopping ${mission.attemptId} to free memory`);
      void mission.suspend();
    }, IDLE_MS);
  }
}
