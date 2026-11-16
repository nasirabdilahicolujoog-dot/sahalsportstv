import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(738419206)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version=1');
    if (rows.length) return;
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    // Bootstrap DDL above is outside the atomic versioned migration.
    const ddl = schema.slice(schema.indexOf('-- Canonical schema'));
    await client.query('BEGIN');
    await client.query(ddl);
    await client.query('INSERT INTO schema_migrations(version) VALUES(1)');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.query('SELECT pg_advisory_unlock(738419206)');
    client.release();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool(loadConfig());
  try { await migrate(pool); console.log('Database migration complete.'); }
  catch (err) { console.error('Migration failed:', err.code || err.name); process.exitCode = 1; }
  finally { await pool.end(); }
}
