import { z } from 'zod';
import type { DatabaseEngine } from '../protocol.js';

/**
 * One seed for every stack: shared/seed/seed.json, turned into each engine's SQL when a learner tree
 * is built. Tables load in the order listed (parents before children).
 *
 *   { "tables": [
 *       { "name": "customers", "identity": true, "columns": ["id", "name"], "rows": [[1, "Asha"]] },
 *       { "name": "orders", "columns": ["id", "created_at"], "rows": [[1042, { "$ago": "3 hours" }]] } ] }
 *
 * Values: numbers, strings, true/false, null, and { "$ago": "<n> minutes|hours|days" } for a time
 * relative to when the seed runs (so "placed 3 hours ago" stays true). `identity` marks a table whose
 * id column is generated: Postgres moves its sequence past the seeded ids, SQL Server allows explicit
 * ids while loading. A table can also carry raw SQL for one engine: { "sql": { "mysql": "…" } }.
 */

const Ago = z.object({ $ago: z.string().regex(/^\d+ (minute|hour|day)s?$/) });
const Value = z.union([z.number(), z.string(), z.boolean(), z.null(), Ago]);
const Table = z.object({
  name: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  identity: z.boolean().default(false),
  columns: z.array(z.string().regex(/^[a-z_][a-z0-9_]*$/)).min(1),
  rows: z.array(z.array(Value)),
  sql: z.partialRecord(z.enum(['postgres', 'mysql', 'sqlserver']), z.string()).default({}),
});
export const SeedFile = z.object({ comment: z.string().optional(), tables: z.array(Table) });
export type SeedFile = z.infer<typeof SeedFile>;

type Value = z.infer<typeof Value>;

function literal(value: Value, engine: DatabaseEngine): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`seed value ${value} isn't a finite number`);
    return String(value);
  }
  if (typeof value === 'boolean') return engine === 'postgres' ? String(value) : value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  const [amount, rawUnit] = value.$ago.split(' ') as [string, string];
  const unit = rawUnit.replace(/s$/, '');
  if (engine === 'postgres') return `now() - interval '${amount} ${unit}${amount === '1' ? '' : 's'}'`;
  if (engine === 'mysql') return `NOW(6) - INTERVAL ${amount} ${unit.toUpperCase()}`;
  return `DATEADD(${unit}, -${amount}, SYSDATETIMEOFFSET())`;
}

/** The seed as SQL for one engine. `header` becomes the first comment line. */
export function seedSql(seed: SeedFile, engine: DatabaseEngine, header = 'Development data, generated from shared/seed/seed.json. Edit that file, not this one.'): string {
  const out: string[] = [`-- ${header}`, ''];
  for (const table of seed.tables) {
    if (table.sql[engine]) {
      out.push(table.sql[engine].trim(), '');
      continue;
    }
    if (!table.rows.length) continue;
    for (const [index, row] of table.rows.entries()) {
      if (row.length !== table.columns.length) throw new Error(`seed table ${table.name}, row ${index + 1}: ${row.length} values for ${table.columns.length} columns`);
    }
    const identity = table.identity && engine === 'sqlserver';
    if (identity) out.push(`SET IDENTITY_INSERT ${table.name} ON;`);
    out.push(`INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES`);
    out.push(`${table.rows.map((row) => `  (${row.map((value) => literal(value, engine)).join(', ')})`).join(',\n')};`);
    if (identity) out.push(`SET IDENTITY_INSERT ${table.name} OFF;`);
    if (table.identity && engine === 'postgres') {
      // Explicit ids don't move a serial's sequence: without this the app's first insert collides
      out.push(`SELECT setval(pg_get_serial_sequence('${table.name}', 'id'), (SELECT MAX(id) FROM ${table.name}));`);
    }
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

export function parseSeed(text: string, file: string): SeedFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: not valid JSON (${(error as Error).message})`);
  }
  const result = SeedFile.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    throw new Error(`${file}: ${issue.path.join('.')}: ${issue.message}`);
  }
  return result.data;
}
