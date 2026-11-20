import pg from 'pg';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// A dropped connection (e.g. the database was reset) shouldn't crash the server
pool.on('error', (error) => console.error('[db] idle connection error:', error.message));

/** For a single query that doesn't need a transaction */
export const db = {
  query: (text: string, params?: unknown[]) => pool.query(text, params),
};

/**
 * Run several queries as one unit: they all commit together, or none of them do.
 *
 *   await withTransaction(async (tx) => {
 *     await tx.query('UPDATE ...', [id]);
 *     await tx.query('UPDATE ...', [id]);
 *   });
 */
export async function withTransaction<T>(work: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
