import pg from 'pg';
export function createPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 15, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 15000, application_name: 'sahal-sports-tv' });
}
export async function transaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
export async function audit(db, actorId, action, targetType, targetId = null, details = {}) {
  await db.query('INSERT INTO audit_logs(actor_id,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5)',
    [actorId, action, targetType, targetId, JSON.stringify(details)]);
}
