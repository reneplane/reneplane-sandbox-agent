import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { createLogger } from '../log.js';
import type { QueryResult, TableInfo } from '../protocol.js';
import { ensureRuntime, type Runtime } from '../runtimes/index.js';
import { pickPort } from '../util/ports.js';
import { buildEnv, runFile } from '../util/process.js';
import { commandOf, plainRows, type DatabaseConnection, type DatabaseProvider } from './types.js';

/**
 * A private PostgreSQL 16 server per mission, from the portable binaries, listening only on 127.0.0.1.
 *
 *   <mission>/db/postgres/data     the cluster (initdb on first start)
 *   <name>_template                schema + seed at the mission's start, built once
 *   <name>                         the dev database: a copy of the template; reset = copy again
 *   <name>_test                    for the visible tests, which rebuild it themselves
 */

const log = createLogger('postgres');
const PREFERRED_PORT = 54329;

export interface PostgresSecrets {
  superPassword: string;
  password: string;
}

export class LocalPostgres implements DatabaseProvider {
  readonly engine = 'postgres' as const;
  readonly location = 'local' as const;
  readonly label = 'PostgreSQL 16';

  private runtime: Runtime | null = null;
  private port = PREFERRED_PORT;
  private pool: pg.Pool | null = null;
  private tail: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    /** The app's database and role name, e.g. "shopkart" */
    private readonly name: string,
    private readonly secrets: PostgresSecrets,
  ) {}

  private get dataDir() {
    return join(this.root, 'data');
  }
  private get logFile() {
    return join(this.root, 'postgres.log');
  }

  async start(onLog: (line: string, level: 'info' | 'warn' | 'error') => void, onProgress?: (detail: string) => void): Promise<void> {
    this.runtime = await ensureRuntime('postgres', onProgress);
    mkdirSync(this.root, { recursive: true });
    if (!existsSync(join(this.dataDir, 'PG_VERSION'))) await this.initdb();

    // A server from an earlier session may still be running (the agent restarted); stop it cleanly first
    await this.pgCtl(['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '20']).catch(() => undefined);

    this.port = await pickPort(PREFERRED_PORT);
    const started = await this.pgCtl(['start', '-D', this.dataDir, '-l', this.logFile, '-w', '-t', '60', '-o', `-p ${this.port}`]);
    if (started.code !== 0) {
      throw new Error(`PostgreSQL didn't start: ${(started.stderr || started.stdout).trim().split('\n').slice(-3).join(' ')}`);
    }
    this.followLog(onLog);
    log.info(`PostgreSQL running on 127.0.0.1:${this.port}`);
  }

  private async initdb(): Promise<void> {
    rmSync(this.dataDir, { recursive: true, force: true });
    const pwfile = join(this.root, '.pwfile');
    writeFileSync(pwfile, this.secrets.superPassword, { mode: 0o600 });
    try {
      const result = await runFile(
        this.bin('initdb'),
        ['-D', this.dataDir, '-U', 'postgres', '-A', 'scram-sha-256', `--pwfile=${pwfile}`, '-E', 'UTF8', '--no-locale'],
        { env: this.env(), timeoutMs: 120_000 },
      );
      if (result.code !== 0) throw new Error(`initdb failed: ${(result.stderr || result.stdout).trim()}`);
    } finally {
      rmSync(pwfile, { force: true });
    }
    // Only ever reachable from this computer, over TCP
    appendFileSync(
      join(this.dataDir, 'postgresql.conf'),
      // synchronous_commit=off speeds up tests and can only lose the last moment of writes after a crash, never corrupt
      "\n# Reneplane Local\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\nsynchronous_commit = off\n",
    );
  }

  async prepare(rebuildTemplate: boolean): Promise<{ devExists: boolean }> {
    const admin = await this.client('postgres', 'postgres', this.secrets.superPassword);
    try {
      const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [this.name]);
      if (!role.rowCount) {
        await admin.query(`CREATE ROLE ${ident(this.name)} LOGIN CREATEDB PASSWORD ${literal(this.secrets.password)}`);
      }
      if (rebuildTemplate) await admin.query(`DROP DATABASE IF EXISTS ${ident(`${this.name}_template`)} WITH (FORCE)`);
      const databases = new Set(
        (await admin.query<{ datname: string }>('SELECT datname FROM pg_database')).rows.map((row) => row.datname),
      );
      for (const database of [`${this.name}_template`, `${this.name}_test`]) {
        if (!databases.has(database)) await admin.query(`CREATE DATABASE ${ident(database)} OWNER ${ident(this.name)}`);
      }
      return { devExists: databases.has(this.name) };
    } finally {
      await admin.end();
    }
  }

  connection(): DatabaseConnection {
    return { host: '127.0.0.1', port: this.port, user: this.name, password: this.secrets.password, name: this.name, testName: `${this.name}_test` };
  }

  templateConnection(): DatabaseConnection {
    return { ...this.connection(), name: `${this.name}_template` };
  }

  async runScript(sql: string, database: string): Promise<void> {
    const client = await this.client(database, this.name, this.secrets.password);
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  async sealTemplate(): Promise<void> {
    await this.copyTemplate();
  }

  async reset(): Promise<void> {
    await this.idle();
    await this.copyTemplate();
  }

  /** Drop the dev database (disconnecting the app) and copy it from the template */
  private async copyTemplate(): Promise<void> {
    const admin = await this.client('postgres', 'postgres', this.secrets.superPassword);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(this.name)} WITH (FORCE)`);
      // No one may be connected to the template while it's copied
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [`${this.name}_template`],
      );
      await admin.query(`CREATE DATABASE ${ident(this.name)} TEMPLATE ${ident(`${this.name}_template`)} OWNER ${ident(this.name)}`);
    } finally {
      await admin.end();
    }
  }

  async query(sql: string): Promise<QueryResult> {
    const started = performance.now();
    const raw = (await this.devPool().query(sql)) as unknown as pg.QueryResult | pg.QueryResult[];
    const results = Array.isArray(raw) ? raw : [raw];
    const last = results.at(-1);
    const rows = plainRows((last?.rows ?? []) as Record<string, unknown>[]);
    return {
      command: last?.command ?? commandOf(sql),
      columns: last?.fields?.map((field) => field.name) ?? [],
      rows,
      rowCount: Math.max(rows.length, last?.rowCount ?? 0),
      durationMs: Math.round(performance.now() - started),
    };
  }

  async schema(): Promise<TableInfo[]> {
    const pool = this.devPool();
    const { rows: columns } = await pool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(`
      SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
      FROM information_schema.columns c
      JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'schema_migrations'
      ORDER BY c.table_name, c.ordinal_position`);
    const { rows: keys } = await pool.query<{
      table_name: string;
      column_name: string;
      constraint_type: string;
      foreign_table: string | null;
      foreign_column: string | null;
    }>(`
      SELECT tc.table_name, kcu.column_name, tc.constraint_type,
             ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_type = 'FOREIGN KEY' AND ccu.constraint_name = tc.constraint_name
      WHERE tc.table_schema = 'public' AND tc.constraint_type IN ('PRIMARY KEY', 'FOREIGN KEY')`);
    const tables = [...new Set(columns.map((column) => column.table_name))];
    const counts = await Promise.all(
      tables.map(async (table) => Number((await pool.query(`SELECT count(*)::int AS n FROM ${ident(table)}`)).rows[0]?.n ?? 0)),
    );
    return tables.map((table, index) => ({
      name: table,
      rowCount: counts[index] ?? 0,
      columns: columns
        .filter((column) => column.table_name === table)
        .map((column) => ({
          name: column.column_name,
          type: column.data_type,
          nullable: column.is_nullable === 'YES',
          default: column.column_default,
          isPrimaryKey: keys.some((key) => key.table_name === table && key.column_name === column.column_name && key.constraint_type === 'PRIMARY KEY'),
        })),
      foreignKeys: keys
        .filter((key) => key.table_name === table && key.constraint_type === 'FOREIGN KEY' && key.foreign_table)
        .map((key) => ({ column: key.column_name, references: { table: key.foreign_table!, column: key.foreign_column! } })),
    }));
  }

  async idle(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    await pool?.end().catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.idle();
    if (this.tail) clearInterval(this.tail);
    this.tail = null;
    if (this.runtime && existsSync(join(this.dataDir, 'postmaster.pid'))) {
      await this.pgCtl(['stop', '-D', this.dataDir, '-m', 'fast', '-w', '-t', '30']);
    }
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private devPool(): pg.Pool {
    if (!this.pool) {
      this.pool = new pg.Pool({ ...this.clientConfig(this.name, this.name, this.secrets.password), max: 3, idleTimeoutMillis: 30_000 });
      this.pool.on('error', (error) => log.warn('Idle connection error', error.message));
    }
    return this.pool;
  }

  private clientConfig(database: string, user: string, password: string): pg.ClientConfig {
    return { host: '127.0.0.1', port: this.port, database, user, password, connectionTimeoutMillis: 10_000 };
  }

  private async client(database: string, user: string, password: string): Promise<pg.Client> {
    const client = new pg.Client(this.clientConfig(database, user, password));
    client.on('error', () => undefined);
    await client.connect();
    return client;
  }

  private bin(name: string): string {
    return join(this.runtime!.dir, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  }

  private env() {
    return buildEnv(this.runtime!.path, { LC_ALL: 'C', LANG: 'C' });
  }

  private pgCtl(args: string[]) {
    return runFile(this.bin('pg_ctl'), args, { env: this.env(), timeoutMs: 120_000 });
  }

  /** Forward new lines of the server log as they appear */
  private followLog(onLog: (line: string, level: 'info' | 'warn' | 'error') => void): void {
    let offset = existsSync(this.logFile) ? statSync(this.logFile).size : 0;
    if (this.tail) clearInterval(this.tail);
    this.tail = setInterval(() => {
      try {
        const size = statSync(this.logFile).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const buffer = Buffer.alloc(size - offset);
        const fd = openSync(this.logFile, 'r');
        readSync(fd, buffer, 0, buffer.length, offset);
        closeSync(fd);
        offset = size;
        for (const line of buffer.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const level = /\b(ERROR|FATAL|PANIC)\b/.test(line) ? 'error' : /\bWARNING\b/.test(line) ? 'warn' : 'info';
          onLog(line.replace(/^\S+ \S+ \S+ \[\d+\] /, ''), level);
        }
      } catch {
        // the log may not exist yet
      }
    }, 700);
  }
}

export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
