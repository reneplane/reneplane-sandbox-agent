import type { LogEvent, ServiceInfo, ServiceState } from '../protocol.js';
import { waitForHttp } from '../util/ports.js';
import { startCommand, type Env, type Spawned } from '../util/process.js';

/**
 * Runs the mission's backend and frontend (and shows the database's state alongside them).
 * Dev servers restart themselves on file changes (tsx watch, uvicorn --reload, Vite HMR, …), so the
 * supervisor only starts them, waits until they answer, and reports when they exit.
 */

type Name = ServiceInfo['name'];

interface Running {
  spawned: Spawned;
  stopping: boolean;
}

export class Services {
  private readonly info = new Map<Name, ServiceInfo>();
  private readonly running = new Map<Name, Running>();

  constructor(
    private readonly onChange: (services: ServiceInfo[]) => void,
    private readonly onLog: (entry: LogEvent) => void,
  ) {}

  declare(name: Name, label: string, address: string, state: ServiceState = 'stopped'): void {
    this.info.set(name, { name, label, address, state });
    this.emit();
  }

  setState(name: Name, state: ServiceState, address?: string): void {
    const current = this.info.get(name);
    if (!current) return;
    this.info.set(name, { ...current, state, address: address ?? current.address });
    this.emit();
  }

  list(): ServiceInfo[] {
    const order: Name[] = ['frontend', 'backend', 'database'];
    return order.map((name) => this.info.get(name)).filter((service): service is ServiceInfo => Boolean(service));
  }

  /** Start a service and wait until `readyUrl` answers. Rejects with the last log lines if it doesn't. */
  async start(name: 'frontend' | 'backend', command: string, cwd: string, env: Env, readyUrl: string, timeoutMs = 180_000): Promise<void> {
    await this.stop(name);
    const recent: string[] = [];
    this.setState(name, 'starting');
    const spawned = startCommand(command, {
      cwd,
      env,
      onLine: (line, stream) => {
        if (!line.trim()) return;
        recent.push(line);
        if (recent.length > 30) recent.shift();
        const level = stream === 'stderr' && /error|exception|fail/i.test(line) ? 'error' : stream === 'stderr' ? 'warn' : /\berror\b/i.test(line) ? 'error' : 'info';
        this.onLog({ source: name, level, message: line });
      },
    });
    const entry: Running = { spawned, stopping: false };
    this.running.set(name, entry);
    let exited = false;
    void spawned.exited.then((code) => {
      exited = true;
      if (entry.stopping || this.running.get(name) !== entry) return;
      this.running.delete(name);
      this.setState(name, 'error');
      this.onLog({ source: name, level: 'error', message: `${name} stopped (exit code ${code ?? 'unknown'})` });
    });

    const ready = await waitForHttp(readyUrl, timeoutMs, () => exited || entry.stopping);
    if (entry.stopping) return;
    if (!ready) {
      await this.stop(name);
      this.setState(name, 'error');
      throw new Error(`The ${name} didn't start.\n${recent.slice(-12).join('\n')}`);
    }
    this.setState(name, 'running');
  }

  async stop(name: 'frontend' | 'backend'): Promise<void> {
    const entry = this.running.get(name);
    if (!entry) return;
    entry.stopping = true;
    this.running.delete(name);
    await entry.spawned.kill();
    this.setState(name, 'stopped');
  }

  async stopAll(): Promise<void> {
    await Promise.all([this.stop('frontend'), this.stop('backend')]);
  }

  isRunning(name: 'frontend' | 'backend'): boolean {
    return this.running.has(name) && this.info.get(name)?.state === 'running';
  }

  private emit(): void {
    this.onChange(this.list());
  }
}
