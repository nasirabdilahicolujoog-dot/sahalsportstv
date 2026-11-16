import { z } from 'zod';
import { audit, transaction } from './db.js';
import { fail, HttpError, validate } from './errors.js';
import { decrypt, phoneSchema, sha256, uuidSchema } from './security.js';

const providerSchema = z.enum(['zaad', 'edahab']);
const initiateSchema = z.object({ provider: providerSchema, phone: phoneSchema }).strict();
const externalId = z.string().min(1).max(255).refine(value => value.trim() === value);
const initiationResult = z.object({ reference: externalId, instructions: z.string().max(2000).optional() }).strict();
const evidenceFields = {
  source: z.literal('server_api'), provider: providerSchema, paymentId: uuidSchema,
  reference: externalId, amountMinor: z.literal(50), currency: z.literal('USD'),
};
const verificationResult = z.discriminatedUnion('status', [
  z.object({ ...evidenceFields, status: z.literal('pending') }).strict(),
  z.object({ ...evidenceFields, status: z.literal('failed') }).strict(),
  z.object({ ...evidenceFields, status: z.literal('settled'), transactionId: externalId, eventId: externalId }).strict(),
]);
const refundResult = z.object({
  ...evidenceFields, status: z.literal('refunded'), transactionId: externalId, eventId: externalId,
}).strict();
const terminal = new Set(['succeeded', 'failed', 'refunded']);

export function paymentView(row) {
  return {
    id: row.id, userId: row.user_id, provider: row.provider, amount: 0.5, amountMinor: 50,
    currency: row.currency, status: row.status, reference: row.provider_reference,
    createdAt: row.created_at,
  };
}

/**
 * Fixed-price payment domain. Only trusted server-side adapter verification grants time.
 * User locks serialize grants; unique references, transactions and events prevent replay.
 * Short transactions persist intent before external I/O; no DB connection is held while
 * waiting on a provider. An uncertain initiation stays initiating and is recovered by
 * verify(paymentId), never by creating another charge. Refund retries require the adapter's
 * provider-side idempotency guarantee. Audit entries are the existing schema's durable
 * grant snapshots/refund intents: only the unchanged latest grant can be refunded.
 * Earlier/edited/expired grants require manual reconciliation, not guessed subtraction.
 */
export function createPaymentService({ pool, config, adapters = {} }) {
  async function protect(work) {
    try { return await work(); } catch (err) {
      if (err?.code === '23505') fail(409, 'provider_replay', 'This provider reference, transaction or event is already assigned.');
      throw err;
    }
  }

  async function readPayment(id, db = pool) {
    const { rows } = await db.query('SELECT * FROM payments WHERE id=$1', [id]);
    if (!rows[0]) fail(404, 'payment_not_found', 'Payment not found.');
    return rows[0];
  }

  async function locked(db, payment) {
    // Always user before payment; separate payments for one subscription share this lock.
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [payment.user_id]);
    const { rows } = await db.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [payment.id]);
    if (!rows[0]) fail(404, 'payment_not_found', 'Payment not found.');
    return rows[0];
  }

  async function authorize(db, payment, actorId, adminOnly = false) {
    if (actorId === null && !adminOnly) return; // Internal reconciliation only; not request data.
    if (actorId === null) fail(403, 'forbidden', 'An active administrator is required.');
    const { rows } = await db.query('SELECT role,status FROM users WHERE id=$1', [actorId]);
    if (!rows[0] || rows[0].status !== 'active' ||
        (rows[0].role !== 'admin' && (adminOnly || actorId !== payment.user_id))) {
      fail(403, 'forbidden', 'You cannot perform this payment operation.');
    }
  }

  async function activeUser(db, userId) {
    const { rows } = await db.query('SELECT status FROM users WHERE id=$1', [userId]);
    if (!rows[0] || rows[0].status !== 'active') fail(409, 'inactive_user', 'The payment account must be active.');
  }

  function fingerprint(row) {
    return sha256(JSON.stringify([row.provider, row.environment, row.merchant_id, row.api_url,
      row.api_key_encrypted, row.secret_key_encrypted]));
  }

  async function integration(provider) {
    const adapter = adapters?.[provider];
    if (!adapter || ['initiate', 'verify', 'refund', 'test'].some(method => typeof adapter[method] !== 'function')) {
      fail(503, 'integration_not_configured', 'A merchant-approved payment adapter is not configured.');
    }
    const { rows } = await pool.query('SELECT * FROM providers WHERE provider=$1', [provider]);
    const row = rows[0];
    if (!row || !row.merchant_id.trim() || !row.api_url || !row.api_key_encrypted || !row.secret_key_encrypted) {
      fail(503, 'integration_not_configured', 'Provider endpoint, merchant and encrypted credentials are required.');
    }
    if (row.environment !== 'production') fail(503, 'sandbox_not_supported', 'Sandbox payments cannot activate live subscriptions.');
    try {
      const endpoint = new URL(row.api_url);
      if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
          (endpoint.port && endpoint.port !== '443') || !config.providerHosts?.has(endpoint.hostname.toLowerCase())) {
        throw new Error('Invalid endpoint');
      }
      const credentials = {
        merchantId: row.merchant_id, apiUrl: row.api_url, environment: row.environment,
        apiKey: decrypt(row.api_key_encrypted, config.encryptionKey, `provider:${provider}:apiKey`),
        secretKey: decrypt(row.secret_key_encrypted, config.encryptionKey, `provider:${provider}:secretKey`),
      };
      if (!credentials.apiKey.trim() || !credentials.secretKey.trim()) throw new Error('Missing credentials');
      return { adapter, credentials, fingerprint: fingerprint(row) };
    } catch {
      fail(503, 'integration_not_configured', 'Provider credentials or the allowed HTTPS endpoint are not configured correctly.');
    }
  }

  async function assertIntegration(db, payment, configured, requireIntent = true) {
    const { rows } = await db.query('SELECT * FROM providers WHERE provider=$1 FOR SHARE', [payment.provider]);
    if (!rows[0] || rows[0].environment !== 'production' || fingerprint(rows[0]) !== configured.fingerprint) {
      fail(409, 'integration_changed', 'Provider configuration changed; reconcile with the original merchant configuration.');
    }
    if (requireIntent) {
      const intent = await db.query(
        "SELECT details FROM audit_logs WHERE action='payment.initiated' AND target_type='payment' AND target_id=$1 ORDER BY id LIMIT 1", [payment.id]);
      if (intent.rows[0]?.details?.integration !== configured.fingerprint) {
        fail(409, 'integration_changed', 'The original production integration must be restored before reconciliation.');
      }
    }
  }

  async function noOutstandingRefund(db, userId) {
    const { rows } = await db.query(`SELECT p.id FROM payments p
      WHERE p.user_id=$1 AND p.status='succeeded' AND EXISTS (
        SELECT 1 FROM audit_logs a WHERE a.target_type='payment' AND a.target_id=p.id::text
        AND a.action='payment.refund_requested') LIMIT 1`, [userId]);
    if (rows.length) fail(409, 'refund_in_progress', 'Reconcile the outstanding refund before changing this subscription.');
  }

  async function invoke(adapter, method, input) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => adapter[method](input)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Provider timeout')), 15000); }),
      ]);
    } catch {
      const uncertain = method === 'initiate' || method === 'refund';
      throw new HttpError(502, uncertain ? `${method}_uncertain` : 'provider_unavailable', uncertain
        ? 'The provider outcome is uncertain. Reconcile this payment ID; do not create another charge.'
        : 'The provider could not verify this payment. Try reconciliation again later.');
    } finally { clearTimeout(timer); }
  }

  function parseResult(schema, value) {
    const result = schema.safeParse(value);
    if (!result.success) fail(502, 'invalid_provider_evidence', 'The provider returned invalid or non-authoritative evidence.');
    return result.data;
  }

  function bind(payment, evidence) {
    if (evidence.provider !== payment.provider || evidence.paymentId !== payment.id ||
        (payment.provider_reference !== null && payment.provider_reference !== evidence.reference) ||
        (payment.provider_transaction_id !== null && evidence.transactionId !== undefined &&
          payment.provider_transaction_id !== evidence.transactionId)) {
      fail(502, 'invalid_provider_evidence', 'Provider evidence does not belong to this payment.');
    }
  }

  async function initiate(userId, input) {
    userId = validate(uuidSchema, userId);
    const { provider, phone } = validate(initiateSchema, input);
    // Configuration is checked BEFORE creating a transaction that a UI could mistake for a charge.
    const configured = await integration(provider);
    return protect(async () => {
      const intent = await transaction(pool, async db => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
        await activeUser(db, userId);
        await noOutstandingRefund(db, userId);
        await assertIntegration(db, { provider }, configured, false);
        const existing = await db.query("SELECT * FROM payments WHERE user_id=$1 AND status IN ('initiating','pending')", [userId]);
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if (row.provider !== provider || row.phone !== phone) {
            fail(409, 'payment_in_progress', 'Reconcile the existing payment before starting another.');
          }
          return { row, created: false };
        }
        const { rows } = await db.query('INSERT INTO payments(user_id,provider,phone) VALUES($1,$2,$3) RETURNING *', [userId, provider, phone]);
        await audit(db, userId, 'payment.initiated', 'payment', rows[0].id, { integration: configured.fingerprint, environment: 'production' });
        return { row: rows[0], created: true };
      });
      if (!intent.created) return paymentView(intent.row);
      const result = parseResult(initiationResult, await invoke(configured.adapter, 'initiate', {
        paymentId: intent.row.id, amountMinor: 50, currency: 'USD', phone, credentials: configured.credentials,
      }));
      return transaction(pool, async db => {
        const row = await locked(db, intent.row);
        await assertIntegration(db, row, configured);
        if (row.provider_reference !== null && row.provider_reference !== result.reference) {
          fail(502, 'invalid_provider_evidence', 'The provider returned a different invoice for this payment.');
        }
        if (row.status !== 'initiating') return paymentView(row);
        const updated = await db.query(`UPDATE payments SET provider_reference=$2,instructions=$3,
          status='pending',updated_at=now() WHERE id=$1 RETURNING *`, [row.id, result.reference, result.instructions ?? null]);
        return paymentView(updated.rows[0]);
      });
    });
  }

  async function get(userId, id) {
    userId = validate(uuidSchema, userId);
    id = validate(uuidSchema, id);
    const { rows } = await pool.query('SELECT * FROM payments WHERE id=$1 AND user_id=$2', [id, userId]);
    if (!rows[0]) fail(404, 'payment_not_found', 'Payment not found.');
    return paymentView(rows[0]);
  }

  async function verify(id, actorId = null) {
    id = validate(uuidSchema, id);
    if (actorId !== null) actorId = validate(uuidSchema, actorId);
    const payment = await readPayment(id);
    await authorize(pool, payment, actorId);
    if (terminal.has(payment.status)) return paymentView(payment);
    const configured = await integration(payment.provider);
    await assertIntegration(pool, payment, configured);
    const evidence = parseResult(verificationResult, await invoke(configured.adapter, 'verify', {
      paymentId: id, reference: payment.provider_reference, credentials: configured.credentials,
    }));
    bind(payment, evidence);
    return protect(() => transaction(pool, async db => {
      await db.query("SET LOCAL TIME ZONE 'UTC'");
      const row = await locked(db, payment);
      await authorize(db, row, actorId);
      bind(row, evidence);
      if (terminal.has(row.status)) return paymentView(row);
      await assertIntegration(db, row, configured);
      if (evidence.status !== 'settled') {
        const updated = await db.query(`UPDATE payments SET provider_reference=$2,status=$3,
          failure_code=$4,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, evidence.reference, evidence.status, evidence.status === 'failed' ? 'provider_declined' : null]);
        return paymentView(updated.rows[0]);
      }
      await activeUser(db, row.user_id);
      await noOutstandingRefund(db, row.user_id);
      await db.query("INSERT INTO payment_events(provider,external_id,kind,payment_id) VALUES($1,$2,'payment',$3)",
        [row.provider, evidence.eventId, id]);
      const previous = await db.query(`SELECT id,expires_at::text AS expires,started_at::text AS started,
        cancelled_at::text AS cancelled FROM subscriptions WHERE user_id=$1 FOR UPDATE`, [row.user_id]);
      const grantStart = await db.query('SELECT GREATEST($1::timestamptz,now())::text AS start', [previous.rows[0]?.expires ?? null]);
      const subscription = await db.query(`INSERT INTO subscriptions(user_id,expires_at)
        VALUES($1,now() + interval '1 month') ON CONFLICT(user_id) DO UPDATE SET
        expires_at=GREATEST(subscriptions.expires_at,now()) + interval '1 month',
        cancelled_at=NULL,updated_at=now()
        RETURNING id,expires_at::text AS expires,updated_at::text AS updated`, [row.user_id]);
      const granted = subscription.rows[0];
      await audit(db, actorId, 'payment.succeeded', 'payment', id, {
        subscriptionId: granted.id, grantStart: grantStart.rows[0].start, grantEnd: granted.expires,
        subscriptionUpdatedAt: granted.updated, previousExpiresAt: previous.rows[0]?.expires ?? null,
        previousCancelledAt: previous.rows[0]?.cancelled ?? null,
      });
      const updated = await db.query(`UPDATE payments SET status='succeeded',provider_reference=$2,
        provider_transaction_id=$3,paid_at=now(),updated_at=now(),failure_code=NULL WHERE id=$1 RETURNING *`,
      [id, evidence.reference, evidence.transactionId]);
      return paymentView(updated.rows[0]);
    }));
  }

  async function refundGrant(db, payment, allowExpired) {
    const { rows } = await db.query(`SELECT details FROM audit_logs
      WHERE action='payment.succeeded' AND target_type='payment' AND target_id=$1 ORDER BY id LIMIT 1`, [payment.id]);
    const grant = rows[0]?.details;
    if (!grant?.subscriptionId || !grant.grantStart || !grant.grantEnd || !grant.subscriptionUpdatedAt) {
      fail(409, 'refund_requires_manual_review', 'This payment has no safely reversible subscription grant.');
    }
    const subscription = await db.query(`SELECT id,
      (expires_at=$2::timestamptz AND updated_at=$3::timestamptz AND cancelled_at IS NULL) AS unchanged,
      (expires_at>now()) AS remaining FROM subscriptions WHERE user_id=$1 FOR UPDATE`,
    [payment.user_id, grant.grantEnd, grant.subscriptionUpdatedAt]);
    const row = subscription.rows[0];
    if (!row || row.id !== grant.subscriptionId || !row.unchanged || (!allowExpired && !row.remaining)) {
      fail(409, 'refund_requires_manual_review', 'Only the unchanged latest grant with remaining time can be refunded; stacked or edited grants need manual reconciliation.');
    }
    return grant;
  }

  async function refund(id, actorId) {
    id = validate(uuidSchema, id);
    if (!actorId) fail(403, 'forbidden', 'An active administrator is required.');
    actorId = validate(uuidSchema, actorId);
    const payment = await readPayment(id);
    await authorize(pool, payment, actorId, true);
    if (payment.status === 'refunded') return paymentView(payment);
    if (payment.status !== 'succeeded') fail(409, 'refund_not_available', 'Only a settled payment can be refunded.');
    const configured = await integration(payment.provider);
    return protect(async () => {
      const reserved = await transaction(pool, async db => {
        await db.query("SET LOCAL TIME ZONE 'UTC'");
        const row = await locked(db, payment);
        await authorize(db, row, actorId, true);
        if (row.status === 'refunded') return row;
        await assertIntegration(db, row, configured);
        const request = await db.query(`SELECT id FROM audit_logs WHERE action='payment.refund_requested'
          AND target_type='payment' AND target_id=$1 LIMIT 1`, [id]);
        if (!request.rows.length) await noOutstandingRefund(db, row.user_id);
        await refundGrant(db, row, request.rows.length > 0);
        if (!request.rows.length) await audit(db, actorId, 'payment.refund_requested', 'payment', id);
        return row;
      });
      if (reserved.status === 'refunded') return paymentView(reserved);
      const evidence = parseResult(refundResult, await invoke(configured.adapter, 'refund', {
        paymentId: id, reference: reserved.provider_reference, transactionId: reserved.provider_transaction_id,
        amountMinor: 50, currency: 'USD', credentials: configured.credentials,
      }));
      bind(reserved, evidence);
      return transaction(pool, async db => {
        await db.query("SET LOCAL TIME ZONE 'UTC'");
        const row = await locked(db, reserved);
        await authorize(db, row, actorId, true);
        bind(row, evidence);
        if (row.status === 'refunded') return paymentView(row);
        await assertIntegration(db, row, configured);
        const grant = await refundGrant(db, row, true);
        await db.query("INSERT INTO payment_events(provider,external_id,kind,payment_id) VALUES($1,$2,'refund',$3)",
          [row.provider, evidence.eventId, id]);
        // Remove only the tail still attributable to this payment, never earlier paid time.
        // Cap now at grantEnd: a slow refund must not extend an already expired grant.
        await db.query(`UPDATE subscriptions SET
          expires_at=GREATEST(COALESCE($2::timestamptz,$3::timestamptz),LEAST(now(),$4::timestamptz)),
          cancelled_at=CASE WHEN $2::timestamptz>now() THEN $5::timestamptz ELSE now() END,
          updated_at=now() WHERE id=$1`,
        [grant.subscriptionId, grant.previousExpiresAt, grant.grantStart, grant.grantEnd, grant.previousCancelledAt]);
        const updated = await db.query("UPDATE payments SET status='refunded',refunded_at=now(),updated_at=now() WHERE id=$1 RETURNING *", [id]);
        await audit(db, actorId, 'payment.refunded', 'payment', id, { eventId: evidence.eventId });
        return paymentView(updated.rows[0]);
      });
    });
  }

  return Object.freeze({ initiate, get, verify, refund });
}
