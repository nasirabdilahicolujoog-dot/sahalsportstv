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
    const apply = async (version, sql) => {
      const { rows } = await client.query('SELECT version FROM schema_migrations WHERE version=$1', [version]);
      if (rows.length) return;
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    };
    // Version 1 is the canonical schema for a new database.
    const schema = await readFile(new URL('../schema.sql', import.meta.url), 'utf8');
    await apply(1, schema.slice(schema.indexOf('-- Canonical schema')));
    // Later versions upgrade databases that already recorded version 1.
    const upgrades = [{ version: 2, file: '../migrations/002-settings-ads.sql' }];
    for (const upgrade of upgrades) {
      await apply(upgrade.version, await readFile(new URL(upgrade.file, import.meta.url), 'utf8'));
    }
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
