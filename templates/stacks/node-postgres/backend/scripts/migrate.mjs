// Applies new files in db/migrations, in order, each in its own transaction.
// Applied files are recorded in schema_migrations, so each runs once.
//
//   npm run migrate            (uses DATABASE_URL)

import { readdirSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);

export async function migrate(connectionString, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map((row) => row.version));
    const files = readdirSync(MIGRATIONS)
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();
    const applied = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(new URL(file, MIGRATIONS), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${error.message}`);
      }
      log(`applied ${file}`);
      applied.push(file);
    }
    if (!applied.length) log('nothing to migrate');
    return applied;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate(process.env.DATABASE_URL).catch((error) => {
    console.error(`migration failed: ${error.message}`);
    process.exit(1);
  });
}
