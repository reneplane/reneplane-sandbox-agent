import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import { createLogger } from '../log.js';
import type { QueryResult, TableInfo } from '../protocol.js';
import { ensureRuntime, type Runtime } from '../runtimes/index.js';
import { pickPort } from '../util/ports.js';
import { buildEnv, runFile, startCommand, type Spawned } from '../util/process.js';
import { commandOf, plainRows, type DatabaseConnection, type DatabaseProvider } from './types.js';

/**
 * A private MySQL 8.4 server per mission, from the portable binaries, listening only on 127.0.0.1.
 * Tuned to stay small (no performance schema, no binary log, a 64 MB buffer pool).
 *
 *   <mission>/db/mysql/data        the server's data (initialised on first start)
 *   <name>_template                schema + seed at the mission's start
 *   template.sql                   a dump of it: MySQL has no CREATE DATABASE … TEMPLATE, so reset reloads this
 *   <name>                         the dev database
 *   <name>_test                    for the visible tests, which rebuild it themselves
 */

const log = createLogger('mysql');
const PREFERRED_PORT = 33069;

export interface MysqlSecrets {
  superPassword: string;
  password: string;
}

export class LocalMysql implements DatabaseProvider {
  readonly engine = 'mysql' as const;
  readonly location = 'local' as const;
  readonly label = 'MySQL 8.4';

  private runtime: Runtime | null = null;
  private port = PREFERRED_PORT;
  private server: Spawned | null = null;
  private pool: mysql.Pool | null = null;
  private tail: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly name: string,
    private readonly secrets: MysqlSecrets,
  ) {}

  private get dataDir() {
    return join(this.root, 'data');
  }
  private get configFile() {
    return join(this.root, 'my.cnf');
  }
  private get errorLog() {
    return join(this.root, 'mysqld.log');
  }
  private get dumpFile() {
    return join(this.root, 'template.sql');
  }

  async start(onLog: (line: string, level: 'info' | 'warn' | 'error') => void, onProgress?: (detail: string) => void): Promise<void> {
    this.runtime = await ensureRuntime('mysql', onProgress);
    mkdirSync(this.root, { recursive: true });
    this.port = await pickPort(PREFERRED_PORT);
    this.writeConfig();
    const fresh = !existsSync(join(this.dataDir, 'mysql'));
    if (fresh) await this.initialise();

    this.server = startCommand(`"${this.bin('mysqld')}" --defaults-file="${this.configFile}"`, { cwd: this.root, env: this.env() });
    this.followLog(onLog);
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const connection = await this.connectAdmin(fresh ? '' : this.secrets.superPassword);
        if (fresh) await connection.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${literal(this.secrets.superPassword)}`);
        await connection.end();
        break;
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`MySQL didn't start: ${(error as Error).message}. See ${this.errorLog}`);
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
    log.info(`MySQL running on 127.0.0.1:${this.port}`);
  }

  private writeConfig(): void {
    const slash = (path: string) => path.replace(/\\/g, '/');
    writeFileSync(
      this.configFile,
      `[mysqld]
basedir=${slash(this.runtime!.dir)}
datadir=${slash(this.dataDir)}
port=${this.port}
bind-address=127.0.0.1
mysqlx=OFF
${process.platform === 'win32' ? '' : `socket=${slash(join(this.root, 'mysql.sock'))}\n`}log-error=${slash(this.errorLog)}
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
default-time-zone=+00:00
skip-log-bin
performance_schema=OFF
innodb_buffer_pool_size=64M
innodb_log_buffer_size=8M
max_connections=50
table_open_cache=200
`,
    );
  }

  private async initialise(): Promise<void> {
    rmSync(this.dataDir, { recursive: true, force: true });
    const result = await runFile(this.bin('mysqld'), [`--defaults-file=${this.configFile}`, '--initialize-insecure', '--user=mysql'], {
      cwd: this.root,
      env: this.env(),
      timeoutMs: 180_000,
    });
    if (result.code !== 0) {
      const detail = existsSync(this.errorLog) ? readFileSync(this.errorLog, 'utf8').split('\n').slice(-5).join(' ') : result.stderr;
      throw new Error(`MySQL couldn't initialise its data folder: ${detail.trim()}`);
    }
  }

  async prepare(rebuildTemplate: boolean): Promise<{ devExists: boolean }> {
    const admin = await this.connectAdmin(this.secrets.superPassword);
    try {
      await admin.query(`CREATE USER IF NOT EXISTS ${literal(this.name)}@'%' IDENTIFIED BY ${literal(this.secrets.password)}`);
      if (rebuildTemplate) await admin.query(`DROP DATABASE IF EXISTS ${ident(`${this.name}_template`)}`);
      const [rows] = await admin.query<mysql.RowDataPacket[]>('SHOW DATABASES');
      const databases = new Set(rows.map((row) => String(Object.values(row)[0])));
      for (const database of [`${this.name}_template`, `${this.name}_test`, this.name]) {
        if (!databases.has(database) && database !== this.name) await admin.query(`CREATE DATABASE ${ident(database)}`);
        await admin.query(`GRANT ALL PRIVILEGES ON ${ident(database)}.* TO ${literal(this.name)}@'%'`);
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
    const connection = await mysql.createConnection({ ...this.clientConfig(this.name, this.secrets.password), database, multipleStatements: true });
    try {
      await connection.query(sql);
    } finally {
      await connection.end();
    }
  }

  async sealTemplate(): Promise<void> {
    // Dump the finished template once; every reset reloads this file
    const dump = await runFile(
      this.bin('mysqldump'),
      ['-h', '127.0.0.1', '-P', String(this.port), '-u', 'root', '--single-transaction', '--no-tablespaces', '--skip-comments', `${this.name}_template`],
      { env: { ...this.env(), MYSQL_PWD: this.secrets.superPassword }, timeoutMs: 120_000 },
    );
    if (dump.code !== 0) throw new Error(`Couldn't snapshot the template database: ${dump.stderr.trim()}`);
    writeFileSync(this.dumpFile, dump.stdout);
    await this.copyTemplate();
  }

  async reset(): Promise<void> {
    await this.idle();
    if (!existsSync(this.dumpFile)) throw new Error('The template snapshot is missing; restart the mission to rebuild it');
    await this.copyTemplate();
  }

  private async copyTemplate(): Promise<void> {
    const admin = await this.connectAdmin(this.secrets.superPassword);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${ident(this.name)}`);
      await admin.query(`CREATE DATABASE ${ident(this.name)}`);
      await admin.query(`GRANT ALL PRIVILEGES ON ${ident(this.name)}.* TO ${literal(this.name)}@'%'`);
    } finally {
      await admin.end();
    }
    const load = await runFile(this.bin('mysql'), ['-h', '127.0.0.1', '-P', String(this.port), '-u', 'root', this.name], {
      env: { ...this.env(), MYSQL_PWD: this.secrets.superPassword },
      input: readFileSync(this.dumpFile, 'utf8'),
      timeoutMs: 120_000,
    });
    if (load.code !== 0) throw new Error(`Couldn't load the template: ${load.stderr.trim()}`);
  }

  async query(sql: string): Promise<QueryResult> {
    const started = performance.now();
    const connection = await this.devPool().getConnection();
    try {
      const [raw, fields] = await connection.query({ sql, rowsAsArray: false });
      // Several statements give one result per statement (fields becomes a list of lists); show the last
      const perStatement = fields as unknown as unknown[] | undefined;
      const multi = Array.isArray(perStatement) && perStatement.length > 0 && (Array.isArray(perStatement[0]) || perStatement[0] === undefined);
      const lastResult = multi ? (raw as unknown[]).at(-1) : raw;
      const lastFields = multi ? (perStatement!.at(-1) as mysql.FieldPacket[] | undefined) : (fields as mysql.FieldPacket[] | undefined);
      if (Array.isArray(lastResult)) {
        const rows = plainRows(lastResult as Record<string, unknown>[]);
        return { command: commandOf(sql), columns: lastFields?.map((field) => field.name) ?? Object.keys(rows[0] ?? {}), rows, rowCount: rows.length, durationMs: Math.round(performance.now() - started) };
      }
      const ok = lastResult as mysql.ResultSetHeader;
      return { command: commandOf(sql), columns: [], rows: [], rowCount: ok?.affectedRows ?? 0, durationMs: Math.round(performance.now() - started) };
    } finally {
      connection.release();
    }
  }

  async schema(): Promise<TableInfo[]> {
    const pool = this.devPool();
    const [columns] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.COLUMN_TYPE AS data_type, c.IS_NULLABLE AS is_nullable,
              c.COLUMN_DEFAULT AS column_default, c.COLUMN_KEY AS column_key
       FROM information_schema.COLUMNS c
       JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
       WHERE c.TABLE_SCHEMA = DATABASE() AND t.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_NAME NOT IN ('flyway_schema_history', 'schema_migrations', 'alembic_version', '__EFMigrationsHistory')
       ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
    );
    const [keys] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS foreign_table, REFERENCED_COLUMN_NAME AS foreign_column
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
    );
    const tables = [...new Set(columns.map((column) => String(column.table_name)))];
    const counts = await Promise.all(
      tables.map(async (table) => {
        const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${ident(table)}`);
        return Number(rows[0]?.n ?? 0);
      }),
    );
    return tables.map((table, index) => ({
      name: table,
      rowCount: counts[index] ?? 0,
      columns: columns
        .filter((column) => column.table_name === table)
        .map((column) => ({
          name: String(column.column_name),
          type: String(column.data_type),
          nullable: column.is_nullable === 'YES',
          default: column.column_default === null ? null : String(column.column_default),
          isPrimaryKey: column.column_key === 'PRI',
        })),
      foreignKeys: keys
        .filter((key) => key.table_name === table)
        .map((key) => ({ column: String(key.column_name), references: { table: String(key.foreign_table), column: String(key.foreign_column) } })),
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
    if (!this.server) return;
    try {
      const admin = await this.connectAdmin(this.secrets.superPassword);
      await admin.query('SHUTDOWN');
      await admin.end().catch(() => undefined);
      await Promise.race([this.server.exited, new Promise((resolve) => setTimeout(resolve, 20_000))]);
    } catch {
      // not reachable: stop it the hard way
    }
    await this.server.kill();
    this.server = null;
  }

  // ---- helpers ------------------------------------------------------------------------------------

  private devPool(): mysql.Pool {
    this.pool ??= mysql.createPool({ ...this.clientConfig(this.name, this.secrets.password), database: this.name, connectionLimit: 3, idleTimeout: 30_000, multipleStatements: true, dateStrings: true });
    return this.pool;
  }

  private clientConfig(user: string, password: string): mysql.ConnectionOptions {
    return { host: '127.0.0.1', port: this.port, user, password, connectTimeout: 10_000, supportBigNumbers: true, bigNumberStrings: true };
  }

  private connectAdmin(password: string): Promise<mysql.Connection> {
    return mysql.createConnection({ ...this.clientConfig('root', password), multipleStatements: true });
  }

  private bin(name: string): string {
    return join(this.runtime!.dir, 'bin', process.platform === 'win32' ? `${name}.exe` : name);
  }

  private env() {
    return buildEnv(this.runtime!.path);
  }

  private followLog(onLog: (line: string, level: 'info' | 'warn' | 'error') => void): void {
    let offset = existsSync(this.errorLog) ? statSync(this.errorLog).size : 0;
    if (this.tail) clearInterval(this.tail);
    this.tail = setInterval(() => {
      try {
        const size = statSync(this.errorLog).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const buffer = Buffer.alloc(size - offset);
        const fd = openSync(this.errorLog, 'r');
        readSync(fd, buffer, 0, buffer.length, offset);
        closeSync(fd);
        offset = size;
        for (const line of buffer.toString('utf8').split(/\r?\n/)) {
          if (!line.trim()) continue;
          const level = /\[ERROR\]/.test(line) ? 'error' : /\[Warning\]/.test(line) ? 'warn' : 'info';
          onLog(line.replace(/^\S+ \d+ /, ''), level);
        }
      } catch {
        // the log may not exist yet
      }
    }, 700);
  }
}


export function ident(name: string): string {
  return '`' + name.replace(/`/g, '``') + '`';
}

function literal(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}
