import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PATHS } from '../config.js';
import { DockerMssql, RemoteMssql } from '../db/mssql.js';
import { LocalMysql } from '../db/mysql.js';
import { LocalPostgres } from '../db/postgres.js';
import type { DatabaseConnection, DatabaseProvider } from '../db/types.js';
import { createLogger } from '../log.js';
import {
  AgentError,
  type AgentEvent,
  type BootStep,
  type LogEvent,
  type MissionOpen,
  type MissionPlan,
  type RunResult,
} from '../protocol.js';
import { ensureRuntime, isInstalled, LABELS, type Runtime, type RuntimeName } from '../runtimes/index.js';
import { randomToken } from '../security.js';
import { resolveInside } from '../util/paths.js';
import { pickPort } from '../util/ports.js';
import { buildEnv, runCommand, type Env } from '../util/process.js';
import { Debugger, type DebugCommand } from '../debug/session.js';
import { MissionFiles } from './files.js';
import { Git } from './git.js';
import { Services } from './services.js';
import { Terminals } from './terminal.js';
import { runTests } from './tests.js';
import { parseWorkspace, render, renderEnv, shellCommand, type Vars, type WorkspaceFile } from './workspace.js';

/**
 * One learner's attempt at one mission, on this computer.
 *
 *   ~/.reneplane/missions/<attemptId>/
 *     repo/         the learner's working tree (a real git clone)
 *     db/           the mission's database server data
 *     out/          test reports from the last run
 *     state.json    what has been set up already, and the database passwords
 */

const log = createLogger('mission');

interface MissionState {
  open: MissionOpen;
  createdAt: string;
  cloned: boolean;
  templateReady: boolean;
  secrets: { superPassword: string; password: string };
  setupHashes: Record<string, string>;
}

export interface MissionOptions {
  dev: boolean;
  /** Dev only: clone reneplane/codebank-x from <dir>/codebank-x instead of GitHub */
  codebankDir?: string;
}

export class Mission {
  readonly dir: string;
  readonly repoDir: string;
  private state: MissionState;
  private workspace: WorkspaceFile | null = null;
  private git: Git | null = null;
  private files: MissionFiles | null = null;
  private db: DatabaseProvider | null = null;
  private readonly services: Services;
  private readonly terminals = new Terminals();
  private readonly runtimes = new Map<RuntimeName, Runtime>();
  private ports: { frontend?: number; backend?: number } = {};
  private steps: BootStep[] = [];
  private booted = false;
  private booting: Promise<void> | null = null;
  private runQueue: Promise<unknown> = Promise.resolve();
  private debuggerInstance: Debugger | null = null;
  /** An IDE tab is connected to this mission (kept up to date by the manager; sent with lease heartbeats) */
  watched = true;

  constructor(
    open: MissionOpen,
    private readonly emit: (event: AgentEvent, data: unknown) => void,
    private readonly options: MissionOptions,
  ) {
    this.dir = join(PATHS.missions, open.attemptId);
    this.repoDir = join(this.dir, 'repo');
    mkdirSync(this.dir, { recursive: true });
    this.state = this.loadState(open);
    this.services = new Services(
      (services) => this.emit('services.change', services),
      (entry) => this.log(entry),
    );
  }

  /** Its programs are running (not stopped for idleness) */
  get isRunning(): boolean {
    return this.booted || this.booting !== null;
  }

  get attemptId(): string {
    return this.state.open.attemptId;
  }

  // ---- planning and booting -----------------------------------------------------------------------

  /** What the boot screen will show, and where the preview will be. Doesn't start anything. */
  async plan(): Promise<MissionPlan> {
    this.workspace = await this.readWorkspace();
    const workspace = this.workspace;
    if (!this.booted) {
      const taken = new Set<number>(Object.values(this.ports).filter((port): port is number => port !== undefined));
      for (const name of ['backend', 'frontend'] as const) {
        const service = workspace.services[name];
        // Ports are picked once per mission: the IDE may plan twice (a reconnect, React's dev double
        // render), and a second pick after the previous mission freed its ports would leave the IDE's
        // preview pointing at a port nothing listens on
        if (service && this.ports[name] === undefined) {
          this.ports[name] = await pickPort(service.port, taken);
          taken.add(this.ports[name]!);
        }
      }
    }
    const steps: BootStep[] = [];
    for (const name of this.neededRuntimes()) {
      if (!isInstalled(name)) steps.push({ id: `runtime:${name}`, label: `Setting up ${LABELS[name]} (first time only)` });
    }
    steps.push(
      this.state.cloned
        ? { id: 'clone', label: 'Opening your files', detail: workspace.branch }
        : { id: 'clone', label: `Cloning ${workspace.name}`, detail: workspace.branch },
    );
    workspace.setup.forEach((step, index) => steps.push({ id: `setup:${index}`, label: step.name }));
    steps.push({ id: 'database', label: `Starting ${this.databaseLabel()}` });
    steps.push({ id: 'template', label: this.state.templateReady ? 'Restoring your database' : 'Loading the template database' });
    for (const name of ['backend', 'frontend'] as const) {
      const service = workspace.services[name];
      if (service) steps.push({ id: `service:${name}`, label: `Starting the ${name}`, detail: `${service.label} on localhost:${this.ports[name]}` });
    }
    this.steps = steps;

    const preview = workspace.preview;
    return {
      repo: { name: workspace.name, branch: workspace.branch },
      bootSteps: steps,
      preview: preview && this.ports[preview.service] ? { url: `http://localhost:${this.ports[preview.service]}${preview.path}` } : null,
      database: { engine: workspace.database.engine, location: workspace.database.engine === 'sqlserver' ? 'remote' : 'local', label: this.databaseLabel() },
      debug: workspace.debug && workspace.services.backend ? { adapter: workspace.debug.adapter } : null,
    };
  }

  /** Start everything. Safe to call again: a running mission just reports every step as done. */
  boot(): Promise<void> {
    if (this.booted) {
      for (const step of this.steps) this.emit('boot.step', { id: step.id, status: 'done' });
      return Promise.resolve();
    }
    this.booting ??= this.runBoot().finally(() => {
      this.booting = null;
    });
    return this.booting;
  }

  private async runBoot(): Promise<void> {
    const workspace = this.workspace ?? (await this.readWorkspace());
    const step = async (id: string, work: (progress: (detail: string) => void) => Promise<void>) => {
      if (!this.steps.some((candidate) => candidate.id === id)) return work(() => undefined);
      this.emit('boot.step', { id, status: 'active' });
      await work((detail) => this.emit('boot.step', { id, status: 'active', detail }));
      this.emit('boot.step', { id, status: 'done' });
    };

    try {
      for (const name of this.neededRuntimes()) {
        await step(`runtime:${name}`, async (progress) => {
          this.runtimes.set(name, await ensureRuntime(name, progress));
        });
      }
      await step('clone', async () => {
        await this.ensureClone();
        // From now on the pinned commit's copy is the one that counts
        this.workspace = await this.workspaceAtRef();
      });
      this.files = new MissionFiles(this.repoDir, this.git!);
      this.files.watch((path, content) => {
        this.emit('fs.change', { path, content });
        this.onFileChanged(path);
      });

      for (const [index, setup] of workspace.setup.entries()) {
        await step(`setup:${index}`, () => this.runSetup(setup));
      }
      await step('database', async (progress) => {
        this.db = this.createDatabase();
        this.services.declare('database', this.databaseShortLabel(), 'starting', 'starting');
        await this.db.start((line, level) => this.log({ source: 'database', level, message: line }), progress);
        const { port, host } = this.db.connection();
        this.services.setState('database', 'running', `${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
      });
      await step('template', () => this.prepareDatabase());
      for (const name of ['backend', 'frontend'] as const) {
        if (workspace.services[name]) await step(`service:${name}`, () => this.startService(name));
      }
      this.booted = true;
      log.info(`Mission ${this.attemptId} is running`);
    } catch (error) {
      log.error(`Mission ${this.attemptId} failed to start`, error);
      await this.suspend().catch(() => undefined);
      throw error instanceof AgentError ? error : new AgentError('failed', (error as Error).message);
    }
  }

  private neededRuntimes(): RuntimeName[] {
    const workspace = this.workspace!;
    const names: RuntimeName[] = ['git'];
    if (workspace.runtimes.node || workspace.services.frontend) names.push('node');
    if (workspace.runtimes.python) names.push('uv');
    if (workspace.runtimes.java) names.push('java');
    if (workspace.runtimes.dotnet) names.push('dotnet');
    if (workspace.database.engine === 'postgres') names.push('postgres');
    if (workspace.database.engine === 'mysql') names.push('mysql');
    return names;
  }

  private async ensureClone(): Promise<void> {
    const git = await ensureRuntime('git');
    this.runtimes.set('git', git);
    this.git = new Git(git, this.repoDir);
    if (this.state.cloned && existsSync(join(this.repoDir, '.git'))) return;
    const { repo, ref } = this.state.open.codebank;
    const source = this.options.dev && this.options.codebankDir ? join(this.options.codebankDir, repo.split('/')[1]!) : `https://github.com/${repo}.git`;
    await this.git.clone(source, ref, this.workspace!.branch);
    this.updateState({ cloned: true });
  }

  /** Install dependencies, unless the lockfiles are unchanged since the last successful install */
  private async runSetup(setup: WorkspaceFile['setup'][number]): Promise<void> {
    const hash = createHash('sha256');
    for (const input of setup.inputs) {
      const file = join(this.repoDir, input);
      hash.update(existsSync(file) ? readFileSync(file) : Buffer.from('missing'));
    }
    const digest = hash.digest('hex');
    if (setup.inputs.length && this.state.setupHashes[setup.name] === digest) return;
    const result = await runCommand(shellCommand(render(setup.run, this.vars())), {
      cwd: join(this.repoDir, setup.cwd),
      env: this.env(),
      onLine: (line) => this.log({ source: 'runner', level: 'info', message: line }),
      timeoutMs: 20 * 60_000,
    });
    if (result.code !== 0) throw new Error(`${setup.name} failed:\n${result.output.slice(-15).join('\n')}`);
    this.updateState({ setupHashes: { ...this.state.setupHashes, [setup.name]: digest } });
  }

  /** First time: migrations + seed into the template. Every time: the dev database exists. */
  private async prepareDatabase(): Promise<void> {
    const db = this.db!;
    const workspace = this.workspace!;
    const rebuild = !this.state.templateReady;
    if (db.managesTemplate) {
      // The template arrived with the database (SQL Server pool): nothing to migrate or seed here
      await db.prepare(rebuild);
      if (rebuild) this.updateState({ templateReady: true });
      return;
    }
    const { devExists } = await db.prepare(rebuild);
    if (rebuild) {
      const template = db.templateConnection();
      if (workspace.migrate) {
        const result = await runCommand(shellCommand(render(workspace.migrate.run, this.vars(template))), {
          cwd: join(this.repoDir, workspace.migrate.cwd),
          env: this.env(template),
          onLine: (line) => this.log({ source: 'database', level: 'info', message: line }),
          timeoutMs: 10 * 60_000,
        });
        if (result.code !== 0) throw new Error(`The starting migrations failed:\n${result.output.slice(-15).join('\n')}`);
      } else if (workspace.database.schema) {
        // SQL practice problems: a plain schema file instead of a migration tool
        await db.runScript(await this.git!.show(this.state.open.codebank.ref, workspace.database.schema), template.name);
      }
      if (workspace.database.seed) {
        await db.runScript(await this.git!.show(this.state.open.codebank.ref, workspace.database.seed), template.name);
      }
      this.updateState({ templateReady: true });
      this.log({ source: 'database', level: 'info', message: 'template database built (schema + seed)' });
    }
    if (rebuild || !devExists) await db.sealTemplate();
    else this.log({ source: 'database', level: 'info', message: 'restored your database from the last session' });
  }

  private async startService(name: 'frontend' | 'backend'): Promise<void> {
    const service = this.workspace!.services[name]!;
    const port = this.ports[name]!;
    this.services.declare(name, service.label, `localhost:${port}`, 'starting');
    const vars = this.vars();
    await this.services.start(
      name,
      shellCommand(render(service.run, vars)),
      join(this.repoDir, service.cwd),
      { ...this.env(), ...renderEnv(service.env, vars) },
      `http://127.0.0.1:${port}${service.ready}`,
    );
  }

  private createDatabase(): DatabaseProvider {
    const { engine, name } = this.workspace!.database;
    if (engine === 'postgres') return new LocalPostgres(join(this.dir, 'db', 'postgres'), name, this.state.secrets);
    if (engine === 'mysql') return new LocalMysql(join(this.dir, 'db', 'mysql'), name, this.state.secrets);
    if (engine === 'sqlserver') {
      const template = this.workspace!.database.template;
      if (!template) throw new AgentError('database_unavailable', 'This codebank has no SQL Server template script');
      if (this.options.dev && process.env.RENEPLANE_MSSQL === 'docker') {
        return new DockerMssql(this.attemptId, name, () => this.git!.show(this.state.open.codebank.ref, template), this.state.secrets);
      }
      const { attemptId, missionId, variantId, codebank } = this.state.open;
      return new RemoteMssql(
        process.env.RENEPLANE_POOL_URL ?? 'https://reneplane-mssql-pool.reneplane.workers.dev',
        () => loadConfig().deviceToken,
        // The template script the pool loads, from workspace.yaml (SHOP-163 keeps it per engine)
        { attemptId, missionId, variantId, codebank: { ...codebank, template: this.workspace!.database.template ?? 'db/template.sqlserver.sql' } },
        () => this.watched,
      );
    }
    throw new AgentError('database_unavailable', `${engine} isn't supported by this version of Reneplane Local yet`);
  }

  private databaseLabel(): string {
    return { postgres: 'PostgreSQL 16', mysql: 'MySQL 8.4', sqlserver: 'SQL Server' }[this.workspace!.database.engine];
  }

  private databaseShortLabel(): string {
    return { postgres: 'Postgres', mysql: 'MySQL', sqlserver: 'SQL Server' }[this.workspace!.database.engine];
  }

  // ---- environment --------------------------------------------------------------------------------

  private vars(connection?: DatabaseConnection): Vars {
    const db = connection ?? this.db?.connection();
    // {{repo}}: the working tree's absolute path, with forward slashes on every OS
    const vars: Vars = { repo: this.repoDir.split('\\').join('/') };
    if (this.ports.frontend) vars['ports.frontend'] = this.ports.frontend;
    if (this.ports.backend) {
      vars['ports.backend'] = this.ports.backend;
      vars['url.backend'] = `http://127.0.0.1:${this.ports.backend}`;
    }
    if (db) {
      Object.assign(vars, {
        'db.host': db.host,
        'db.port': db.port,
        'db.user': db.user,
        'db.password': db.password,
        'db.name': db.name,
        'db.testName': db.testName,
        'db.tls': this.db?.tlsOptions?.() ?? '',
      });
    }
    return vars;
  }

  /** What every command, service and terminal of this mission runs with */
  private env(connection?: DatabaseConnection): Env {
    const paths: string[] = [];
    const extra: Env = {};
    for (const runtime of this.runtimes.values()) {
      paths.push(...runtime.path);
      Object.assign(extra, runtime.env);
    }
    const db = connection ?? this.db?.connection();
    let workspaceEnv: Env = {};
    try {
      workspaceEnv = renderEnv(this.workspace!.env, this.vars(connection));
    } catch {
      // Variables that need the database aren't available before it starts
    }
    return buildEnv(paths, {
      ...extra,
      ...(db && this.workspace?.database.engine === 'postgres'
        ? { PGHOST: db.host, PGPORT: String(db.port), PGUSER: db.user, PGPASSWORD: db.password, PGDATABASE: db.name }
        : {}),
      ...workspaceEnv,
      npm_config_cache: join(PATHS.cache, 'npm'),
      // Otherwise npm.cmd hands over to a globally installed npm (whatever version the learner has)
      npm_config_prefix: join(PATHS.cache, 'npm-global'),
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      BROWSER: 'none',
      FORCE_COLOR: '1',
    });
  }

  // ---- what the IDE calls -------------------------------------------------------------------------

  requireBooted(): void {
    if (!this.booted) throw new AgentError('no_mission', 'The mission is still starting');
  }

  async snapshot(): Promise<Record<string, string>> {
    return this.requireFiles().snapshot();
  }

  async original(): Promise<Record<string, string>> {
    return this.requireFiles().original(this.state.open.codebank.ref);
  }

  writeFile(path: string, content: string): void {
    this.requireFiles().write(path, content);
    this.onFileChanged(path);
  }

  removeFile(path: string): void {
    this.requireFiles().remove(path);
    this.onFileChanged(path);
  }

  private restartTimers = new Map<'frontend' | 'backend', NodeJS.Timeout>();

  /** Restart a service whose sources changed, if it can't reload by itself (restartOn in workspace.yaml) */
  private onFileChanged(path: string): void {
    if (!this.booted || !this.workspace) return;
    // While debugging, the debugger owns the backend (and restarts its debug run itself)
    const debugging = this.debuggerInstance?.active ?? false;
    if (debugging) this.debuggerInstance!.onFileChanged(path);
    for (const name of ['backend', 'frontend'] as const) {
      if (name === 'backend' && debugging) continue;
      const service = this.workspace.services[name];
      if (!service?.restartOn.some((prefix) => path.startsWith(prefix))) continue;
      clearTimeout(this.restartTimers.get(name));
      this.restartTimers.set(
        name,
        setTimeout(() => {
          this.restartTimers.delete(name);
          this.log({ source: name, level: 'info', message: `${path} changed; restarting the ${name}` });
          void this.startService(name).catch((error: Error) => this.log({ source: name, level: 'error', message: error.message }));
        }, 800),
      );
    }
  }

  private requireFiles(): MissionFiles {
    if (!this.files) throw new AgentError('no_mission', 'The mission is still starting');
    return this.files;
  }

  openTerminal(cols: number, rows: number): number {
    this.requireBooted();
    return this.terminals.open(
      { cols, rows },
      this.repoDir,
      this.env(),
      (termId, data) => this.emit('term.output', { termId, data }),
      (termId, code) => this.emit('term.exit', { termId, code }),
    );
  }

  get terminal() {
    return this.terminals;
  }

  async query(sql: string) {
    return this.requireDb().query(sql);
  }

  async schema() {
    return this.requireDb().schema();
  }

  async reset(): Promise<void> {
    await this.requireDb().reset();
    this.log({ source: 'database', level: 'warn', message: 'database reset to the template (your migrations were removed; apply them again)' });
  }

  async migrate(): Promise<string[]> {
    const migrate = this.workspace!.migrate;
    // SQL practice problems have no migrations: the answer is a query
    if (!migrate) return [];
    const result = await runCommand(shellCommand(render(migrate.run, this.vars())), {
      cwd: join(this.repoDir, migrate.cwd),
      env: this.env(),
      onLine: (line) => this.log({ source: 'database', level: 'info', message: line }),
      timeoutMs: 10 * 60_000,
    });
    if (result.code !== 0) throw new AgentError('failed', `The migration failed:\n${result.output.slice(-12).join('\n')}`);
    const pattern = new RegExp(migrate.applied, 'gm');
    // Some tools print a migration's name more than once (EF Core)
    const applied = [...new Set([...result.output.join('\n').matchAll(pattern)].map((match) => match[1] ?? match[0]))];
    applied.forEach((name) => this.log({ source: 'database', level: 'info', message: `migration applied: ${name}` }));
    return applied;
  }

  private requireDb(): DatabaseProvider {
    if (!this.db) throw new AgentError('database_unavailable', 'The database is still starting');
    return this.db;
  }

  /** Visible tests, one run at a time */
  run(): Promise<RunResult> {
    this.requireBooted();
    const next = this.runQueue.then(async () => {
      this.log({ source: 'runner', level: 'info', message: 'running the visible tests' });
      const result = await runTests({
        steps: this.workspace!.test,
        repo: this.repoDir,
        outRoot: join(this.dir, 'out'),
        vars: this.vars(),
        env: this.env(),
        onLine: (line) => this.emit('run.line', { line }),
        query: (sql) => this.requireDb().query(sql),
      });
      this.log({
        source: 'runner',
        level: result.failed || !result.build.ok ? 'warn' : 'info',
        message: result.build.ok ? `tests: ${result.passed} passed, ${result.failed} failed` : 'build failed; tests not run',
      });
      return result;
    });
    this.runQueue = next.catch(() => undefined);
    return next;
  }

  services_list() {
    return this.services.list();
  }

  /** Call the learner's backend, as the IDE's API client or curl would */
  async http(request: { method: string; path: string; body?: unknown }) {
    this.requireBooted();
    if (!this.ports.backend) throw new AgentError('failed', 'This mission has no backend');
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${this.ports.backend}${request.path}`, {
      method: request.method,
      headers: request.body === undefined ? {} : { 'content-type': 'application/json' },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, body, durationMs: Math.round(performance.now() - started) };
  }

  async gitLog() {
    return this.requireGit().log();
  }
  async gitStatus() {
    return this.requireGit().status();
  }
  async gitCommit(message: string) {
    const commit = await this.requireGit().commit(message);
    if (commit) this.emit('git.change', {});
    return commit;
  }
  async gitDiff() {
    return this.requireGit().diffSince(this.state.open.codebank.ref);
  }
  private requireGit(): Git {
    if (!this.git) throw new AgentError('no_mission', 'The mission is still starting');
    return this.git;
  }

  // ---- debugging ----------------------------------------------------------------------------------

  private debug(): Debugger {
    this.requireBooted();
    if (!this.workspace?.debug || !this.ports.backend) throw new AgentError('failed', "This mission's backend can't be debugged yet");
    this.debuggerInstance ??= new Debugger({
      repoDir: this.repoDir,
      workspace: this.workspace,
      services: this.services,
      backendPort: this.ports.backend,
      runtimes: this.runtimes as Map<string, Runtime>,
      env: () => this.env(),
      vars: () => this.vars(),
      startBackend: () => this.startService('backend'),
      log: (entry) => this.log(entry),
      emit: (event, data) => this.emit(event, data),
    });
    return this.debuggerInstance;
  }

  debugStart(breakpoints: { path: string; lines: number[] }[]) {
    for (const file of breakpoints) resolveInside(this.repoDir, file.path);
    return this.debug().start(breakpoints);
  }

  debugStop() {
    return this.debuggerInstance?.stop() ?? Promise.resolve();
  }

  debugRestart() {
    return this.debug().restart();
  }

  debugSetBreakpoints(path: string, lines: number[]) {
    resolveInside(this.repoDir, path);
    return this.debug().setBreakpoints(path, lines);
  }

  debugRequest(command: DebugCommand, args: Record<string, unknown>) {
    return this.debug().request(command, args);
  }

  /** Stop everything this mission runs; files and the database stay on disk */
  async suspend(): Promise<void> {
    await this.debuggerInstance?.dispose();
    this.debuggerInstance = null;
    this.booted = false;
    this.terminals.closeAll();
    this.files?.unwatch();
    await this.services.stopAll();
    await this.db?.stop().catch((error) => log.warn('Database stop failed', error));
    this.services.setState('database', 'stopped');
  }

  // ---- state --------------------------------------------------------------------------------------

  private loadState(open: MissionOpen): MissionState {
    const file = join(this.dir, 'state.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as MissionState;
      if (saved.open.codebank.repo !== open.codebank.repo || saved.open.codebank.ref !== open.codebank.ref) {
        throw new AgentError('mission_busy', 'This attempt already uses a different codebank on this computer');
      }
      return saved;
    }
    const fresh: MissionState = {
      open,
      createdAt: new Date().toISOString(),
      cloned: false,
      templateReady: false,
      secrets: { superPassword: randomToken(18), password: randomToken(18) },
      setupHashes: {},
    };
    writeFileSync(file, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    return fresh;
  }

  private updateState(change: Partial<MissionState>): void {
    this.state = { ...this.state, ...change };
    writeFileSync(join(this.dir, 'state.json'), JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  /** A repo with several variants (SQL practice: one per engine) has .reneplane/<variantId>.yaml */
  private workspaceCandidates(): string[] {
    return [`.reneplane/${this.state.open.variantId}.yaml`, '.reneplane/workspace.yaml'];
  }

  /** The workspace file from the pinned commit (never the working tree) */
  private async workspaceAtRef(): Promise<WorkspaceFile> {
    const ref = this.state.open.codebank.ref;
    for (const path of this.workspaceCandidates()) {
      const text = await this.git!.show(ref, path).catch(() => null);
      if (text !== null) return parseWorkspace(text);
    }
    throw new AgentError('failed', 'This codebank has no workspace file for this mission');
  }

  private async readWorkspace(): Promise<WorkspaceFile> {
    const { repo, ref } = this.state.open.codebank;
    if (this.state.cloned && existsSync(join(this.repoDir, '.git'))) {
      if (!this.git) {
        const git = await ensureRuntime('git');
        this.runtimes.set('git', git);
        this.git = new Git(git, this.repoDir);
      }
      return this.workspaceAtRef();
    }
    for (const path of this.workspaceCandidates()) {
      if (this.options.dev && this.options.codebankDir) {
        const file = join(this.options.codebankDir, repo.split('/')[1]!, ...path.split('/'));
        if (existsSync(file)) return parseWorkspace(readFileSync(file, 'utf8'));
        continue;
      }
      const response = await fetch(`https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${path}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return parseWorkspace(await response.text());
      if (response.status !== 404) throw new AgentError('failed', `Couldn't read ${repo}@${ref} (${response.status}). Check your internet connection.`);
    }
    throw new AgentError('failed', `${repo}@${ref} has no workspace file for this mission`);
  }

  private log(entry: LogEvent): void {
    this.emit('log', entry);
  }
}
