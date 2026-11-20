import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  type Codebank,
  type LogEvent,
  type MissionPlan,
  type RunResult,
} from '../protocol.js';
import { ensureRuntime, isInstalled, LABELS, type Runtime, type RuntimeName } from '../runtimes/index.js';
import { packsFor, runtimesFor, type PackId } from '../packs/index.js';
import { randomToken } from '../security.js';
import { resolveInside } from '../util/paths.js';
import { pickPort, releasePort } from '../util/ports.js';
import { buildEnv, runCommand, type Env } from '../util/process.js';
import { Debugger, type DebugCommand } from '../debug/session.js';
import { MissionFiles } from './files.js';
import { Git } from './git.js';
import { Services } from './services.js';
import { publicUrl } from '../cloud.js';
import type { MissionSource } from './source.js';
import { Terminals } from './terminal.js';
import { runTests } from './tests.js';
import { parseWorkspace, render, renderEnv, shellCommand, type Vars, type WorkspaceFile } from './workspace.js';

/**
 * One learner's attempt at one mission, on this computer.
 *
 *   <root>/<attemptId>/           root: ~/.reneplane/missions (or a checker's temp folder)
 *     repo/         the learner's working tree (a real git clone)
 *     bundle/       the starter bundle, unpacked (bundle sources only)
 *     db/           the mission's database server data
 *     out/          test reports from the last run
 *     state.json    what has been set up already, and the database passwords
 */

const log = createLogger('mission');

/** Which attempt this is, whatever its files come from */
export interface MissionIdentity {
  attemptId: string;
  missionId: string;
  variantId: string;
}

interface MissionState {
  /** Agents up to 0.2 also saved `codebank` here */
  open: MissionIdentity & { codebank?: Codebank };
  sourceKey?: string;
  createdAt: string;
  cloned: boolean;
  templateReady: boolean;
  /** The saved diff was put back on the starter (resumed sessions) */
  restored?: boolean;
  secrets: { superPassword: string; password: string };
  setupHashes: Record<string, string>;
}

export interface MissionOptions {
  dev: boolean;
  /** Dev only: clone reneplane/codebank-x from <dir>/codebank-x instead of GitHub */
  codebankDir?: string;
  /** Where mission folders go (default ~/.reneplane/missions) */
  root?: string;
  /** Watch the working tree for changes (the IDE's live file view); the checker turns it off */
  watchFiles?: boolean;
  /** Where SQL Server comes from: the Azure pool (learners) or Docker Express (codebank checks, dev) */
  mssql?: 'pool' | 'docker';
  /** How a learner's browser reaches a port (cloud agents serve previews on public URLs) */
  previewUrl?: string;
  /** What the SQL Server pool is shown: this computer's device token, or (cloud) the session token */
  leaseToken?: () => string | null;
}

export class Mission {
  readonly dir: string;
  readonly repoDir: string;
  private readonly identity: MissionIdentity;
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
  private readonly changeListeners: (() => void)[] = [];
  private readonly bootedListeners: (() => void)[] = [];

  constructor(
    identity: MissionIdentity,
    private readonly source: MissionSource,
    private readonly emit: (event: AgentEvent, data: unknown) => void,
    private readonly options: MissionOptions,
    /** A saved diff to put back on the starter once (a resumed session, or the checker's reference) */
    private readonly startingPatch: string | null = null,
  ) {
    this.identity = { attemptId: identity.attemptId, missionId: identity.missionId, variantId: identity.variantId };
    this.dir = join(options.root ?? PATHS.missions, identity.attemptId);
    this.repoDir = join(this.dir, 'repo');
    mkdirSync(this.dir, { recursive: true });
    this.state = this.loadState();
    this.services = new Services(
      (services) => this.emit('services.change', services),
      (entry) => this.log(entry),
    );
  }

  /** Called whenever a file in the working tree changes (autosave listens) */
  onChange(listener: () => void): void {
    this.changeListeners.push(listener);
  }

  /** Called each time the mission finishes booting */
  onBooted(listener: () => void): void {
    this.bootedListeners.push(listener);
  }

  /** The working tree exists (even when nothing is running) */
  get hasFiles(): boolean {
    return existsSync(join(this.repoDir, '.git'));
  }

  /** Its programs are running (not stopped for idleness) */
  get isRunning(): boolean {
    return this.booted || this.booting !== null;
  }

  get attemptId(): string {
    return this.identity.attemptId;
  }

  /** The commit the learner started from */
  get baseRef(): string {
    return this.source.baseRef;
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
    if (this.needsRestore()) steps.push({ id: 'restore', label: 'Restoring your saved work' });
    for (const name of ['backend', 'frontend'] as const) {
      const service = workspace.services[name];
      if (service) steps.push({ id: `service:${name}`, label: `Starting the ${name}`, detail: `${service.label} on ${this.address(this.ports[name]!)}` });
    }
    this.steps = steps;

    const preview = workspace.preview;
    return {
      repo: { name: workspace.name, branch: workspace.branch },
      bootSteps: steps,
      preview: preview && this.ports[preview.service] ? { url: `${this.urlOf(this.ports[preview.service]!)}${preview.path}` } : null,
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
      if (this.options.watchFiles !== false) {
        this.files.watch((path, content) => {
          this.emit('fs.change', { path, content });
          this.onFileChanged(path);
        });
      }

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
      // The template always comes from the starter's own migrations and seed, never the saved work
      await step('template', () => this.prepareDatabase());
      if (this.needsRestore()) await step('restore', () => this.restoreSavedWork());
      for (const name of ['backend', 'frontend'] as const) {
        if (workspace.services[name]) await step(`service:${name}`, () => this.startService(name));
      }
      this.booted = true;
      log.info(`Mission ${this.attemptId} is running`);
      for (const listener of this.bootedListeners) listener();
    } catch (error) {
      log.error(`Mission ${this.attemptId} failed to start`, error);
      await this.suspend().catch(() => undefined);
      throw error instanceof AgentError ? error : new AgentError('failed', (error as Error).message);
    }
  }

  /** The packs this workspace needs (what the IDE shows as the variant's requirements) */
  packs(): PackId[] {
    return this.workspace ? packsFor(this.workspace) : [];
  }

  private neededRuntimes(): RuntimeName[] {
    return runtimesFor(packsFor(this.workspace!));
  }

  private async ensureClone(): Promise<void> {
    const git = await ensureRuntime('git');
    this.runtimes.set('git', git);
    this.git = new Git(git, this.repoDir);
    if (this.state.cloned && existsSync(join(this.repoDir, '.git'))) return;
    // A half-finished clone from an interrupted boot would make the next one fail
    rmSync(this.repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await this.source.materialise(this.git, this.workspace!.branch);
    this.updateState({ cloned: true });
  }

  private needsRestore(): boolean {
    return Boolean(this.startingPatch?.trim()) && !this.state.restored;
  }

  /**
   * Put the saved diff back, then apply the learner's migrations to the freshly built database. A
   * migration that fails doesn't stop the boot: the learner sees why in the Database panel and fixes it.
   */
  private async restoreSavedWork(): Promise<void> {
    await this.requireGit().restore(this.source.baseRef, this.startingPatch!);
    this.updateState({ restored: true });
    this.log({ source: 'runner', level: 'info', message: 'restored your saved work' });
    try {
      const applied = await this.migrate();
      if (applied.length) this.log({ source: 'database', level: 'warn', message: 'database rebuilt from the starter; your migrations were applied again' });
    } catch (error) {
      this.log({ source: 'database', level: 'error', message: `your migrations didn't apply to the rebuilt database: ${(error as Error).message}` });
    }
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
        await db.runScript(await this.git!.show(this.source.baseRef, workspace.database.schema), template.name);
      }
      if (workspace.database.seed) {
        await db.runScript(await this.git!.show(this.source.baseRef, workspace.database.seed), template.name);
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
    this.services.declare(name, service.label, this.address(port), 'starting');
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
      const templatePath = this.workspace!.database.template ?? 'db/template.sqlserver.sql';
      if (this.mssqlMode() === 'docker') {
        return new DockerMssql(this.attemptId, name, () => this.sqlServerTemplate(templatePath), this.state.secrets);
      }
      return new RemoteMssql(
        process.env.RENEPLANE_POOL_URL ?? 'https://reneplane-mssql-pool.reneplane.workers.dev',
        this.options.leaseToken ?? (() => loadConfig().deviceToken),
        // How the pool finds the template it loads: a codebank path (0.2) or the engine's signed reference
        { ...this.identity, ...this.source.leaseTemplate(templatePath) },
        () => this.watched,
      );
    }
    throw new AgentError('database_unavailable', `${engine} isn't supported by this version of Reneplane Local yet`);
  }

  /** http://localhost:5173 here; a public URL from a cloud agent */
  private urlOf(port: number): string {
    return publicUrl(this.options.previewUrl ?? 'http://localhost:{port}', port);
  }

  private address(port: number): string {
    return new URL(this.urlOf(port)).host;
  }

  private mssqlMode(): 'pool' | 'docker' {
    return this.options.mssql ?? (this.options.dev && process.env.RENEPLANE_MSSQL === 'docker' ? 'docker' : 'pool');
  }

  /** The SQL Server template: a compiled bundle carries it next to the repo; older codebanks commit it */
  private async sqlServerTemplate(path: string): Promise<string> {
    const fromSource = await this.source.template?.();
    if (fromSource) return fromSource;
    return this.git!.show(this.source.baseRef, path).catch(() => {
      throw new AgentError('database_unavailable', `This codebank has no SQL Server template (${path})`);
    });
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
      npm_config_prefix: join(PATHS.state, 'npm-global'),
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
    return this.requireFiles().original(this.source.baseRef);
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
    for (const listener of this.changeListeners) listener();
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

  /**
   * Put a diff on the running mission's tree and apply its migrations: how the codebank checker tries
   * the reference on a starter, the way a learner's finished work would land.
   */
  async applyWork(patch: string): Promise<string[]> {
    this.requireBooted();
    await this.requireGit().restore(this.source.baseRef, patch);
    return this.migrate();
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
  /** The learner's changes against the starter: what's submitted and autosaved (works before booting) */
  async gitDiff() {
    if (!this.git && this.hasFiles) {
      const git = await ensureRuntime('git');
      this.runtimes.set('git', git);
      this.git = new Git(git, this.repoDir);
    }
    return this.requireGit().diffSince(this.source.baseRef);
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

  /** Delete the database only (a session that closed offline keeps its files, not its data) */
  async destroyDatabase(): Promise<void> {
    await this.db?.destroy().catch((error) => log.warn('Database cleanup failed', error));
    this.db = null;
  }

  /**
   * Stop everything and delete it: the database (local data, the Docker container, or the SQL Server
   * lease), the ports and the whole mission folder. Deleting retries for a few seconds because Windows
   * keeps files locked briefly after a process exits.
   */
  async dispose(): Promise<void> {
    await this.suspend();
    await this.db?.destroy().catch((error) => log.warn('Database cleanup failed', error));
    this.db = null;
    for (const port of Object.values(this.ports)) if (port !== undefined) releasePort(port);
    this.ports = {};
    rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  // ---- state --------------------------------------------------------------------------------------

  private loadState(): MissionState {
    const file = join(this.dir, 'state.json');
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as MissionState;
      const savedKey = saved.sourceKey ?? (saved.open.codebank ? `github:${saved.open.codebank.repo}@${saved.open.codebank.ref}` : null);
      if (savedKey !== this.source.key) {
        throw new AgentError('mission_busy', 'This attempt already uses a different codebank on this computer');
      }
      return saved;
    }
    const fresh: MissionState = {
      open: this.identity,
      sourceKey: this.source.key,
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
    return [`.reneplane/${this.identity.variantId}.yaml`, '.reneplane/workspace.yaml'];
  }

  /** The workspace file from the starting commit (never the working tree, which the learner can edit) */
  private async workspaceAtRef(): Promise<WorkspaceFile> {
    for (const path of this.workspaceCandidates()) {
      const text = await this.git!.show(this.source.baseRef, path).catch(() => null);
      if (text !== null) return parseWorkspace(text);
    }
    throw new AgentError('failed', 'This codebank has no workspace file for this mission');
  }

  private async readWorkspace(): Promise<WorkspaceFile> {
    if (this.state.cloned && existsSync(join(this.repoDir, '.git'))) {
      if (!this.git) {
        const git = await ensureRuntime('git');
        this.runtimes.set('git', git);
        this.git = new Git(git, this.repoDir);
      }
      return this.workspaceAtRef();
    }
    return parseWorkspace(await this.source.workspaceText(this.workspaceCandidates()));
  }

  private log(entry: LogEvent): void {
    this.emit('log', entry);
  }
}
