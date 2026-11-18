import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AgentError, type LogEvent } from '../protocol.js';
import type { WorkspaceFile } from '../mission/workspace.js';
import { render, renderEnv, shellCommand, type Vars } from '../mission/workspace.js';
import type { Services } from '../mission/services.js';
import { ensureRuntime, type Runtime } from '../runtimes/index.js';
import { pickPort, waitForHttp } from '../util/ports.js';
import { runCommand, type Env } from '../util/process.js';
import { startDotnetAdapter, startNodeAdapter, startPythonAdapter, handshake, setFileBreakpoints, type BreakpointResult, type FileBreakpoints, type StartedAdapter } from './adapters.js';
import { JavaDebugBridge } from './java.js';

/**
 * Backend debugging for a mission. Starting a session swaps the backend for its debug run
 * (workspace.yaml `debug`), attaches the stack's adapter and relays it to the IDE with repo paths;
 * stopping puts the normal backend back. The IDE only sends the requests listed in DEBUG_COMMANDS.
 */

export const DEBUG_COMMANDS = ['threads', 'stackTrace', 'scopes', 'variables', 'continue', 'next', 'stepIn', 'stepOut', 'pause', 'evaluate'] as const;
export type DebugCommand = (typeof DEBUG_COMMANDS)[number];

export type DebugState = 'starting' | 'running' | 'paused' | 'restarting' | 'stopped' | 'error';

type DebugConfig = NonNullable<WorkspaceFile['debug']>;

export interface DebugHost {
  repoDir: string;
  workspace: WorkspaceFile;
  services: Services;
  backendPort: number;
  runtimes: Map<string, Runtime>;
  env(): Env;
  vars(): Vars;
  /** Start the backend the normal way again */
  startBackend(): Promise<void>;
  log(entry: LogEvent): void;
  emit(event: 'debug.state' | 'debug.event', data: unknown): void;
}

const DEFAULT_PORTS = { node: 9229, python: 5678, java: 5005, dotnet: 0 };

/**
 * .NET frame names as the code reads: netcoredbg reports compiler-generated names
 *   ShopKart.Api.Orders.OrdersService.<CancelOrder>d__4.MoveNext()  →  OrdersService.CancelOrder()
 *   Program.<>c.<<Main>$>b__0_8()                                     →  Program (lambda)
 */
export function frameName(name: string): string {
  let shown = name.replace(/\.<([\w$]+)>d__\d+\.MoveNext\(\)$/, '.$1()');
  shown = shown.replace(/\.<>c(__DisplayClass[\w]*)?\.<+([\w$]+)>?\$?>b__[\w]+\(\)$/, ' (lambda in $2)').replace(/\(lambda in Main\)$/, '(lambda)');
  const call = shown.match(/^((?:[\w$`]+\.)*)([\w$`]+)\.([\w$]+\(.*\))$/);
  return call ? `${call[2]}.${call[3]}` : shown.replace(/^(?:[\w$`]+\.)+(?=[\w$`]+ \()/, '');
}
const ADAPTER_RUNTIME = { node: 'jsdebug', python: 'debugpy', dotnet: 'netcoredbg', java: null } as const;

export class Debugger {
  private adapter: StartedAdapter | null = null;
  private state: DebugState = 'stopped';
  private readonly breakpoints = new Map<string, number[]>();
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private transition: Promise<unknown> = Promise.resolve();

  constructor(private readonly host: DebugHost) {}

  private get config(): DebugConfig {
    const config = this.host.workspace.debug;
    if (!config) throw new AgentError('failed', "This mission's backend can't be debugged yet");
    return config;
  }

  get active(): boolean {
    return this.adapter !== null || this.state === 'starting' || this.state === 'restarting';
  }

  private setState(state: DebugState, message?: string): void {
    this.state = state;
    this.host.emit('debug.state', { state, adapter: this.host.workspace.debug?.adapter ?? null, message: message ?? null });
  }

  // ---- paths --------------------------------------------------------------------------------------

  private absolute(path: string): string {
    const full = resolve(this.host.repoDir, ...path.split('/'));
    if (!this.inside(full)) throw new AgentError('outside_workspace', `${path} is outside the project`);
    return full;
  }

  private inside(path: string): boolean {
    const inside = relative(this.host.repoDir, path);
    return Boolean(inside) && !inside.startsWith('..') && !isAbsolute(inside);
  }

  /** An adapter's path → the repo path the IDE uses, or null for code outside the project */
  private repoPath(path: string): string | null {
    let candidate = path;
    // js-debug reports c:\…, the repo may be C:\…
    if (process.platform === 'win32' && /^[a-z]:/.test(candidate)) candidate = candidate[0]!.toUpperCase() + candidate.slice(1);
    if (!isAbsolute(candidate)) return null;
    const inside = relative(this.host.repoDir, candidate);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) return null;
    if (inside.split(sep).some((part) => part === 'node_modules' || part === '.venv' || part === 'target' || part === 'bin' || part === 'obj')) return null;
    return inside.split(sep).join('/');
  }

  /** Every `source` in a DAP body gets a repo path, or none (external code) */
  private mapSources(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.mapSources(item));
    if (!value || typeof value !== 'object') return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === 'source' && item && typeof item === 'object') {
        const source = item as { path?: string; name?: string; sourceReference?: number };
        const path = source.path ? this.repoPath(source.path) : null;
        result[key] = { name: source.name ?? (source.path ? source.path.split(/[\\/]/).pop() : undefined), path, external: !path };
      } else {
        result[key] = this.mapSources(item);
      }
    }
    return result;
  }

  // ---- lifecycle ----------------------------------------------------------------------------------

  /** Serialise start/stop/restart: the IDE can press buttons faster than a JVM starts */
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.transition.then(work, work);
    this.transition = next.catch(() => undefined);
    return next;
  }

  start(breakpoints: { path: string; lines: number[] }[]): Promise<{ adapter: string; breakpoints: Record<string, BreakpointResult[]> }> {
    for (const file of breakpoints) this.breakpoints.set(file.path, [...new Set(file.lines)].sort((a, b) => a - b));
    return this.queue(async () => {
      if (this.adapter) return { adapter: this.config.adapter, breakpoints: this.currentBreakpoints() };
      return this.launch('starting');
    });
  }

  private currentBreakpoints(): Record<string, BreakpointResult[]> {
    return Object.fromEntries([...this.breakpoints].map(([path, lines]) => [path, lines.map((line) => ({ line, verified: true }))]));
  }

  private async launch(state: 'starting' | 'restarting') {
    const config = this.config;
    this.stopping = false;
    this.setState(state, 'Starting the backend with the debugger');
    try {
      const runtimeName = ADAPTER_RUNTIME[config.adapter];
      let adapterRuntime: Runtime | null = null;
      if (runtimeName) {
        adapterRuntime = await ensureRuntime(runtimeName, (detail) => this.setState(state, `Downloading the debugger (${detail})`));
        this.host.runtimes.set(runtimeName, adapterRuntime);
      }
      const port = config.adapter === 'dotnet' ? 0 : await pickPort(DEFAULT_PORTS[config.adapter], new Set([this.host.backendPort]));
      const vars: Vars = { ...this.host.vars(), 'ports.debug': port };
      const backend = this.host.workspace.services.backend!;
      const cwd = join(this.host.repoDir, config.cwd ?? backend.cwd);
      const env: Env = { ...this.host.env(), ...renderEnv(backend.env, vars), ...renderEnv(config.env, vars) };
      if (config.adapter === 'python') env.PYTHONPATH = [adapterRuntime!.dir, env.PYTHONPATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':');
      const files: FileBreakpoints[] = [...this.breakpoints].map(([path, lines]) => ({ path: this.absolute(path), lines }));
      const readyUrl = `http://127.0.0.1:${this.host.backendPort}${backend.ready}`;

      await this.host.services.stop('backend');
      if (config.adapter === 'dotnet') {
        this.setState(state, 'Building the backend for debugging');
        const build = await runCommand(shellCommand(render(config.build!, vars)), { cwd, env, timeoutMs: 10 * 60_000 });
        if (build.code !== 0) throw new AgentError('failed', `The build failed:\n${build.output.slice(-15).join('\n')}`);
        const program = render(config.program!, vars);
        if (!existsSync(program)) throw new AgentError('failed', `The build didn't produce ${program}`);
        this.host.services.declare('backend', backend.label, `localhost:${this.host.backendPort}`, 'starting');
        const dotnet = this.host.runtimes.get('dotnet')!;
        this.adapter = await startDotnetAdapter({
          netcoredbgDir: adapterRuntime!.dir,
          program,
          cwd,
          env,
          path: dotnet.path,
          breakpoints: files,
          onLog: (message) => message && this.host.log({ source: 'backend', level: 'info', message }),
        });
        this.adapter.dap.onEvent((event, body) => {
          if (event === 'output') {
            const text = String((body as { output?: string }).output ?? '').trimEnd();
            if (text) this.host.log({ source: 'backend', level: (body as { category?: string }).category === 'stderr' ? 'warn' : 'info', message: text });
          }
        });
        if (!(await waitForHttp(readyUrl, 180_000, () => this.stopping))) throw new AgentError('failed', "The backend didn't start under the debugger");
        this.host.services.setState('backend', 'running');
      } else {
        await this.host.services.start('backend', shellCommand(render(config.run!, vars)), cwd, env, readyUrl, 240_000);
        this.setState(state, 'Attaching the debugger');
        if (config.adapter === 'node') {
          const node = this.host.runtimes.get('node')!;
          this.adapter = await startNodeAdapter({
            jsDebugDir: adapterRuntime!.dir,
            nodeBinary: join(node.path[0]!, process.platform === 'win32' ? 'node.exe' : 'node'),
            inspectPort: port,
            repoDir: this.host.repoDir,
            breakpoints: files,
            onLog: (message) => message && this.host.log({ source: 'backend', level: 'info', message: `[debugger] ${message}` }),
          });
        } else if (config.adapter === 'python') {
          this.adapter = await startPythonAdapter({ port, repoDir: this.host.repoDir, breakpoints: files });
        } else {
          const bridge = await JavaDebugBridge.attach({ port, sourceRoots: config.sourceRoots.map((root) => this.absolute(root)) });
          const result = await handshake(bridge, 'java', 'attach', {}, files);
          this.adapter = { dap: bridge, ...result, dispose: async () => void (await bridge.request('disconnect', {}).catch(() => undefined)) };
        }
      }

      const adapter = this.adapter;
      adapter.dap.onEvent((event, body) => {
        if (event === 'output' || event === 'initialized' || event === 'process' || event === 'loadedSource' || event === 'module') return;
        if (event === 'stopped') this.setState('paused');
        if (event === 'continued' && this.state === 'paused') this.setState('running');
        this.host.emit('debug.event', { event, body: this.mapSources(body) });
      });
      adapter.dap.onClose(() => {
        if (this.adapter !== adapter) return;
        this.adapter = null;
        if (!this.stopping) void this.queue(() => this.teardown('The debugger disconnected'));
      });
      this.setState('running');
      const results: Record<string, BreakpointResult[]> = {};
      for (const [path, list] of adapter.breakpoints) {
        const repoPath = this.repoPath(path);
        if (repoPath) results[repoPath] = list;
      }
      return { adapter: config.adapter, breakpoints: results };
    } catch (error) {
      await this.teardown((error as Error).message);
      throw error instanceof AgentError ? error : new AgentError('failed', (error as Error).message);
    }
  }

  /** End the session and put the normal backend back */
  private async teardown(message?: string): Promise<void> {
    this.stopping = true;
    const adapter = this.adapter;
    this.adapter = null;
    await adapter?.dispose().catch(() => undefined);
    await this.host.services.stop('backend');
    if (message) this.setState('error', message);
    try {
      await this.host.startBackend();
    } catch (error) {
      this.host.log({ source: 'backend', level: 'error', message: (error as Error).message });
    }
    if (!message) this.setState('stopped');
  }

  stop(): Promise<void> {
    return this.queue(async () => {
      if (this.restartTimer) clearTimeout(this.restartTimer);
      if (!this.adapter && this.state === 'stopped') return;
      await this.teardown();
    });
  }

  restart(): Promise<unknown> {
    return this.queue(async () => {
      this.stopping = true;
      const adapter = this.adapter;
      this.adapter = null;
      await adapter?.dispose().catch(() => undefined);
      return this.launch('restarting');
    });
  }

  /** Debug runs have no file watcher: restart when the backend's sources change */
  onFileChanged(path: string): void {
    if (!this.adapter || !this.host.workspace.debug?.restartOn.some((prefix) => path.startsWith(prefix))) return;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.host.log({ source: 'backend', level: 'info', message: `${path} changed; restarting the debug session` });
      void this.restart().catch(() => undefined);
    }, 800);
  }

  // ---- what the IDE sends -------------------------------------------------------------------------

  async setBreakpoints(path: string, lines: number[]): Promise<BreakpointResult[]> {
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    if (sorted.length) this.breakpoints.set(path, sorted);
    else this.breakpoints.delete(path);
    if (!this.adapter) return sorted.map((line) => ({ line, verified: false }));
    return setFileBreakpoints(this.adapter.dap, { path: this.absolute(path), lines: sorted });
  }

  async request(command: DebugCommand, args: Record<string, unknown>): Promise<unknown> {
    if (!this.adapter) throw new AgentError('failed', 'No debug session is running');
    const body = await this.adapter.dap.request(command, args, command === 'evaluate' ? 15_000 : 30_000);
    if (command === 'continue' && this.state === 'paused') this.setState('running');
    if ((command === 'next' || command === 'stepIn' || command === 'stepOut') && this.state === 'paused') this.setState('running');
    const mapped = this.mapSources(body) as { stackFrames?: { name: string }[] };
    if (command === 'stackTrace' && this.host.workspace.debug?.adapter === 'dotnet') {
      for (const frame of mapped.stackFrames ?? []) frame.name = frameName(frame.name);
    }
    return mapped;
  }

  /** The mission is closing: end the session without restarting anything */
  async dispose(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const adapter = this.adapter;
    this.adapter = null;
    await adapter?.dispose().catch(() => undefined);
  }
}
