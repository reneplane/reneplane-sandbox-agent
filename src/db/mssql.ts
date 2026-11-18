import sql from 'mssql';
import { createLogger } from '../log.js';
import { AgentError, type QueryResult, type TableInfo } from '../protocol.js';
import { randomToken } from '../security.js';
import { pickPort } from '../util/ports.js';
import { runFile } from '../util/process.js';
import { commandOf, plainRows, type DatabaseConnection, type DatabaseProvider } from './types.js';

/**
 * SQL Server. Learners always get a database leased from Reneplane's pool of Azure SQL databases
 * (RemoteMssql); there is one database per lease, so the tests share it with the app (they reset its
 * rows, not its schema). The pool loads the template (migrations as SQL + seed) itself.
 *
 * DockerMssql is for developing codebanks only (agent started with --dev and RENEPLANE_MSSQL=docker).
 */

const log = createLogger('mssql');
const MIGRATION_TABLES = ['__EFMigrationsHistory', 'flyway_schema_history', 'schema_migrations', 'alembic_version'];

export interface SqlServerTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Only for the development container's self-signed certificate; never for Azure */
  trustServerCertificate: boolean;
}

/** Split a script on GO lines (sqlcmd batches, as `dotnet ef migrations script` writes them) */
export function splitBatches(script: string): string[] {
  return script
    .split(/^\s*GO\s*;?\s*$/im)
    .map((batch) => batch.trim())
    .filter(Boolean);
}

abstract class SqlServerBase {
  readonly engine = 'sqlserver' as const;
  /** The template comes ready-made (the pool loads it); the mission doesn't run migrations into it */
  readonly managesTemplate = true;
  protected target: SqlServerTarget | null = null;
  private pool: sql.ConnectionPool | null = null;

  connection(): DatabaseConnection {
    const target = this.requireTarget();
    return { host: target.host, port: target.port, user: target.user, password: target.password, name: target.database, testName: target.database };
  }

  templateConnection(): DatabaseConnection {
    return this.connection();
  }

  /** Extra connection-string options for the app: TLS always on, full certificate checks on Azure */
  tlsOptions(): string {
    return this.requireTarget().trustServerCertificate ? 'Encrypt=True;TrustServerCertificate=True' : 'Encrypt=True';
  }

  async runScript(script: string): Promise<void> {
    const pool = await this.open();
    for (const batch of splitBatches(script)) await pool.request().batch(batch);
  }

  async sealTemplate(): Promise<void> {
    // The template is already in the database (loaded by the pool, or by prepare() in development)
  }

  async query(text: string): Promise<QueryResult> {
    const started = performance.now();
    const pool = await this.open();
    const result = await pool.request().query(text);
    const recordsets = (result.recordsets as unknown as sql.IRecordSet<Record<string, unknown>>[]) ?? [];
    const last = recordsets.at(-1);
    const rows = plainRows((last ?? []) as Record<string, unknown>[]);
    const columns = last?.columns ? Object.values(last.columns).sort((a, b) => a.index - b.index).map((column) => column.name) : Object.keys(rows[0] ?? {});
    return {
      command: commandOf(text),
      columns,
      rows,
      rowCount: last ? rows.length : (result.rowsAffected.at(-1) ?? 0),
      durationMs: Math.round(performance.now() - started),
    };
  }

  async schema(): Promise<TableInfo[]> {
    const pool = await this.open();
    const columns = (
      await pool.request().query(`
        SELECT c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name, c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable, c.COLUMN_DEFAULT AS column_default
        FROM INFORMATION_SCHEMA.COLUMNS c
        JOIN INFORMATION_SCHEMA.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE t.TABLE_TYPE = 'BASE TABLE' AND c.TABLE_SCHEMA = 'dbo'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`)
    ).recordset.filter((column: { table_name: string }) => !MIGRATION_TABLES.includes(column.table_name));
    const primary = (
      await pool.request().query(`
        SELECT ku.TABLE_NAME AS table_name, ku.COLUMN_NAME AS column_name
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku ON ku.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'`)
    ).recordset as { table_name: string; column_name: string }[];
    const foreign = (
      await pool.request().query(`
        SELECT OBJECT_NAME(fk.parent_object_id) AS table_name, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name,
               OBJECT_NAME(fk.referenced_object_id) AS foreign_table, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS foreign_column
        FROM sys.foreign_keys fk JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id`)
    ).recordset as { table_name: string; column_name: string; foreign_table: string; foreign_column: string }[];
    const tables = [...new Set(columns.map((column: { table_name: string }) => column.table_name))] as string[];
    const counts = await Promise.all(
      tables.map(async (table) => Number((await pool.request().query(`SELECT COUNT(*) AS n FROM [${table.replace(/]/g, ']]')}]`)).recordset[0]?.n ?? 0)),
    );
    return tables.map((table, index) => ({
      name: table,
      rowCount: counts[index] ?? 0,
      columns: columns
        .filter((column: { table_name: string }) => column.table_name === table)
        .map((column: { column_name: string; data_type: string; is_nullable: string; column_default: string | null }) => ({
          name: column.column_name,
          type: column.data_type,
          nullable: column.is_nullable === 'YES',
          default: column.column_default,
          isPrimaryKey: primary.some((key) => key.table_name === table && key.column_name === column.column_name),
        })),
      foreignKeys: foreign
        .filter((key) => key.table_name === table)
        .map((key) => ({ column: key.column_name, references: { table: key.foreign_table, column: key.foreign_column } })),
    }));
  }

  /** Close connections after ~30 seconds idle, so a serverless Azure database can pause */
  async idle(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    await pool?.close().catch(() => undefined);
  }

  protected async open(): Promise<sql.ConnectionPool> {
    if (this.pool?.connected) return this.pool;
    const target = this.requireTarget();
    const pool = new sql.ConnectionPool({
      server: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.database,
      options: { encrypt: true, trustServerCertificate: target.trustServerCertificate, enableArithAbort: true },
      // A paused serverless database takes up to a minute to wake
      connectionTimeout: 90_000,
      requestTimeout: 60_000,
      pool: { min: 0, max: 3, idleTimeoutMillis: 30_000 },
    });
    pool.on('error', (error) => log.warn('SQL Server connection error', (error as Error).message));
    try {
      this.pool = await pool.connect();
    } catch (error) {
      throw new AgentError('database_unavailable', describeConnectError(error as Error));
    }
    return this.pool;
  }

  protected requireTarget(): SqlServerTarget {
    if (!this.target) throw new AgentError('database_unavailable', 'The SQL Server database is still being prepared');
    return this.target;
  }
}

function describeConnectError(error: Error): string {
  const message = error.message ?? '';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEOUT|ESOCKET|getaddrinfo/i.test(message)) {
    return 'SQL Server needs internet, and this computer can’t reach it right now (port 1433 may be blocked on this network). Reconnecting…';
  }
  return `SQL Server refused the connection: ${message}`;
}

/** The learner's database: leased from Reneplane's SQL Server pool (Azure SQL free offer) */
export class RemoteMssql extends SqlServerBase implements DatabaseProvider {
  readonly location = 'remote' as const;
  readonly label = 'SQL Server';
  private leaseId: string | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly poolUrl: string,
    private readonly deviceToken: () => string | null,
    private readonly lease: { attemptId: string; missionId: string; variantId: string; codebank: { repo: string; ref: string; template: string } },
    private readonly ideConnected: () => boolean,
  ) {
    super();
  }

  async start(onLog: (line: string, level: 'info' | 'warn' | 'error') => void, onProgress?: (detail: string) => void): Promise<void> {
    const token = this.deviceToken();
    if (!token) {
      throw new AgentError('database_unavailable', 'This computer isn’t registered with Reneplane yet, so it can’t lease a SQL Server database. Run the install command from the workspace again.');
    }
    onProgress?.('Leasing a database');
    const created = await this.call<{ leaseId: string; state: string }>('POST', '/db-leases', this.lease);
    this.leaseId = created.leaseId;
    const ready = await this.waitUntilReady(onProgress);
    this.target = { host: ready.host, port: ready.port, user: ready.user, password: ready.password, database: ready.database, trustServerCertificate: false };
    onLog(`leased ${ready.database} on ${ready.host} until ${new Date(ready.expiresAt).toLocaleTimeString()}`, 'info');
    this.heartbeat = setInterval(() => void this.call('POST', `/db-leases/${this.leaseId}/heartbeat`, { ideConnected: this.ideConnected() }).catch(() => undefined), 150_000);
  }

  private async waitUntilReady(onProgress?: (detail: string) => void) {
    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      const lease = await this.call<{ state: string; host: string; port: number; database: string; user: string; password: string; expiresAt: string; message?: string }>('GET', `/db-leases/${this.leaseId}`);
      if (lease.state === 'ready') return lease;
      if (lease.state === 'failed') throw new AgentError('database_unavailable', lease.message ?? 'The SQL Server database couldn’t be prepared');
      onProgress?.(lease.state === 'waking' ? 'Waking SQL Server… (up to a minute after a pause)' : 'Loading the template database');
      if (Date.now() > deadline) throw new AgentError('database_unavailable', 'SQL Server took too long to get ready. Try again in a minute.');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async prepare(): Promise<{ devExists: boolean }> {
    return { devExists: true };
  }

  async reset(): Promise<void> {
    await this.idle();
    await this.call('POST', `/db-leases/${this.leaseId}/reset`, {});
    await this.waitUntilReady();
  }

  async stop(): Promise<void> {
    await this.idle();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.leaseId) await this.call('DELETE', `/db-leases/${this.leaseId}`).catch(() => undefined);
    this.leaseId = null;
    this.target = null;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.poolUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.deviceToken()}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AgentError('database_unavailable', 'SQL Server needs internet, and Reneplane’s database pool can’t be reached right now. Reconnecting…');
    }
    const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (response.status === 409) throw new AgentError('database_unavailable', 'SQL Server is busy, try again in a few minutes.');
    if (!response.ok) throw new AgentError('database_unavailable', payload.error ?? `The database pool answered ${response.status}`);
    return payload;
  }
}

/**
 * Development only: SQL Server in Docker, shaped like a lease (one database, the template loaded from
 * the codebank's template script). Never offered to learners.
 */
export class DockerMssql extends SqlServerBase implements DatabaseProvider {
  readonly location = 'remote' as const;
  readonly label = 'SQL Server (dev container)';
  private container: string;

  constructor(
    attemptId: string,
    private readonly name: string,
    private readonly loadTemplate: () => Promise<string>,
    private readonly secrets: { superPassword: string; password: string },
  ) {
    super();
    this.container = `reneplane-mssql-${attemptId.toLowerCase()}`;
  }

  async start(onLog: (line: string, level: 'info' | 'warn' | 'error') => void, onProgress?: (detail: string) => void): Promise<void> {
    const saPassword = `Rp1!${this.secrets.superPassword}`;
    const existing = await runFile('docker', ['inspect', '-f', '{{(index (index .NetworkSettings.Ports "1433/tcp") 0).HostPort}}', this.container]);
    let port = Number(existing.stdout.trim());
    if (existing.code !== 0) {
      port = await pickPort(14339);
      onProgress?.('Starting the SQL Server container (downloads 1.5 GB the first time)');
      const created = await runFile('docker', ['run', '-d', '--name', this.container, '-e', 'ACCEPT_EULA=Y', '-e', 'MSSQL_PID=Express', '-e', `MSSQL_SA_PASSWORD=${saPassword}`, '-p', `127.0.0.1:${port}:1433`, 'mcr.microsoft.com/mssql/server:2022-latest'], { timeoutMs: 30 * 60_000 });
      if (created.code !== 0) throw new AgentError('database_unavailable', `Docker couldn't start SQL Server: ${created.stderr.trim()}`);
    } else {
      await runFile('docker', ['start', this.container]);
    }
    this.target = { host: '127.0.0.1', port, user: 'sa', password: saPassword, database: 'master', trustServerCertificate: true };
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        await this.query('SELECT 1');
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await this.idle();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
    onLog(`SQL Server container ${this.container} on 127.0.0.1:${port}`, 'info');
  }

  async prepare(rebuildTemplate: boolean): Promise<{ devExists: boolean }> {
    const exists = (await this.query(`SELECT 1 AS found FROM sys.databases WHERE name = '${this.name}'`)).rows.length > 0;
    if (!exists || rebuildTemplate) await this.recreate();
    await this.idle();
    this.target = { ...this.target!, user: this.name, password: this.secrets.password, database: this.name };
    return { devExists: true };
  }

  private async recreate(): Promise<void> {
    await this.idle();
    this.target = { ...this.target!, user: 'sa', password: `Rp1!${this.secrets.superPassword}`, database: 'master' };
    const login = this.secrets.password.replace(/'/g, "''");
    await this.runScript(`
      IF DB_ID('${this.name}') IS NOT NULL BEGIN ALTER DATABASE [${this.name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${this.name}]; END
      CREATE DATABASE [${this.name}];
      IF SUSER_ID('${this.name}') IS NULL CREATE LOGIN [${this.name}] WITH PASSWORD = '${login}', CHECK_POLICY = OFF;`);
    await this.idle();
    this.target = { ...this.target!, database: this.name };
    // The same restricted rights a pool lease gets
    await this.runScript(`
      CREATE USER [${this.name}] FOR LOGIN [${this.name}];
      ALTER ROLE db_ddladmin ADD MEMBER [${this.name}];
      ALTER ROLE db_datareader ADD MEMBER [${this.name}];
      ALTER ROLE db_datawriter ADD MEMBER [${this.name}];
      GRANT EXECUTE, VIEW DEFINITION, SHOWPLAN, REFERENCES TO [${this.name}];`);
    await this.runScript(await this.loadTemplate());
    await this.idle();
  }

  async reset(): Promise<void> {
    await this.recreate();
    this.target = { ...this.target!, user: this.name, password: this.secrets.password, database: this.name };
  }

  async stop(): Promise<void> {
    await this.idle();
    await runFile('docker', ['stop', this.container], { timeoutMs: 60_000 });
  }
}

export function newLeasePassword(): string {
  return `Rp1!${randomToken(24)}`;
}
