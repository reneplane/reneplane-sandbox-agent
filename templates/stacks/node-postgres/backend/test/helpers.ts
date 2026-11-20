import { readFileSync } from 'node:fs';
import pg from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { pool } from '../src/db';

export { app } from '../src/server';
export const db = pool;

const url = process.env.DATABASE_URL;

/** A fresh database before each test: every migration in db/migrations (yours too), then the seed */
export async function resetDatabase() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
  await migrate(url, { log: () => undefined });
  await pool.query(readFileSync(new URL('../../db/seed.sql', import.meta.url), 'utf8'));
}
