import type { DatabaseEngine, QueryResult, TableInfo } from '../protocol.js';

/** How the learner's app, tests and the IDE reach the mission's database */
export interface DatabaseConnection {
  host: string;
  port: number;
  user: string;
  password: string;
  /** The dev database the app and the IDE use */
  name: string;
  /** A separate database the visible tests reset freely (same as `name` when the engine has only one) */
  testName: string;
}

/**
 * One mission's database, whatever the engine and wherever it runs. The mission calls these in order:
 *
 *   start()                    → server up (local) or lease ready (remote)
 *   prepare(rebuildTemplate)   → users and databases exist (an empty template if rebuilding)
 *   [migrate + seed into templateConnection()]   when the template is being (re)built
 *   sealTemplate()             → the dev database becomes a copy of the template
 *   query/schema/reset         → while the learner works
 *   stop()                     → everything shut down (data kept)
 *   destroy()                  → stopped and deleted
 */
export interface DatabaseProvider {
  readonly engine: DatabaseEngine;
  readonly location: 'local' | 'remote';
  /** e.g. "PostgreSQL 16" */
  readonly label: string;
  start(onLog: (line: string, level: 'info' | 'warn' | 'error') => void, onProgress?: (detail: string) => void): Promise<void>;
  /** Create users and databases if missing; with rebuildTemplate, start the template over empty */
  prepare(rebuildTemplate: boolean): Promise<{ devExists: boolean }>;
  connection(): DatabaseConnection;
  /** Where the template build runs migrations and the seed */
  templateConnection(): DatabaseConnection;
  /** Run a SQL script (the seed) against a database of this connection */
  runScript(sql: string, database: string): Promise<void>;
  /** Template finished: make the dev database a copy of it */
  sealTemplate(): Promise<void>;
  /** Dev database back to the template: schema + seed, without the learner's migrations */
  reset(): Promise<void>;
  query(sql: string): Promise<QueryResult>;
  schema(): Promise<TableInfo[]>;
  /** Release idle connections (lets serverless databases pause) */
  idle(): Promise<void>;
  /** True when the template arrives ready-made (the SQL Server pool); the mission then skips migrate + seed */
  readonly managesTemplate?: boolean;
  /** Extra connection-string options for the app (SQL Server's TLS settings) */
  tlsOptions?(): string;
  stop(): Promise<void>;
  /** Stop and delete everything: local data, a container, or the lease (the session is over) */
  destroy(): Promise<void>;
}

/** Make driver values JSON-safe: dates as ISO strings, binary as hex, big numbers as strings */
export function plainValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(plainValue);
  return value;
}

export function plainRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, plainValue(value)])));
}

/** The first keyword of the last statement, for the console's "UPDATE 3" style summary */
export function commandOf(sql: string): string {
  const statements = sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
  return statements.at(-1)?.split(/\s+/)[0]?.toUpperCase() ?? '';
}
