import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { HttpError } from '../src/errors.js';
import { createPaymentService } from '../src/payments.js';
import { loadAdapters } from '../src/providers.js';

// One bounded-I/O pass. Run periodically; verify looks up initiating payments by the
// existing paymentId, NEVER calls initiate again. Uncertain refunds reuse that same ID.
let pool;
try {
  const config = loadConfig();
  const adapters = await loadAdapters(config);
  pool = createPool(config);
  const service = createPaymentService({ pool, config, adapters });
  const cutoff = (await pool.query('SELECT now()::text AS cutoff')).rows[0].cutoff;
  let cursor = null;
  const counts = { checked: 0, succeeded: 0, refunded: 0, pending: 0, failed: 0, errors: 0 };
  for (;;) {
    const { rows } = await pool.query(`SELECT p.id,p.status,
      (SELECT a.actor_id FROM audit_logs a WHERE a.target_type='payment' AND a.target_id=p.id::text
        AND a.action='payment.refund_requested' ORDER BY a.id LIMIT 1) AS refund_actor
      FROM payments p WHERE ($1::uuid IS NULL OR p.id>$1::uuid) AND p.created_at<=$2::timestamptz
      AND (p.status IN ('initiating','pending') OR (p.status='succeeded' AND EXISTS (
        SELECT 1 FROM audit_logs a WHERE a.target_type='payment' AND a.target_id=p.id::text
        AND a.action='payment.refund_requested')))
      ORDER BY p.id LIMIT 100`, [cursor, cutoff]);
    if (!rows.length) break;
    for (const row of rows) {
      counts.checked++;
      try {
        const payment = row.status === 'succeeded'
          ? await service.refund(row.id, row.refund_actor)
          : await service.verify(row.id);
        const bucket = payment.status === 'initiating' ? 'pending' : payment.status;
        counts[bucket]++;
      } catch (err) {
        counts.errors++;
        // Never print upstream errors, credentials, references, phone numbers or SQL.
        console.error(JSON.stringify({ event: 'payment_reconciliation_failed', paymentId: row.id,
          code: err instanceof HttpError ? err.code : 'internal_error' }));
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  console.log(JSON.stringify({ event: 'payment_reconciliation_complete', ...counts }));
  if (counts.errors) process.exitCode = 1;
} catch (err) {
  console.error(JSON.stringify({ event: 'payment_reconciliation_failed',
    code: err instanceof HttpError ? err.code : 'configuration_or_database_error' }));
  process.exitCode = 1;
} finally {
  if (pool) await pool.end();
}
