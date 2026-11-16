import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createPool, transaction } from '../src/db.js';
import { encrypt } from '../src/security.js';
import { createPaymentService, paymentView } from '../src/payments.js';
import { loadAdapters } from '../src/providers.js';

const error = (status, code) => ({ status, code });

// These adapters never use fetch, HTTP, provider SDKs, or external money networks.
function merchant(provider = 'zaad') {
  const invoices = new Map();
  const calls = { initiate: [], verify: [], refund: [] };
  const overrides = {};
  const settled = paymentId => {
    const invoice = invoices.get(paymentId);
    if (!invoice) throw new Error('Unknown merchant payment ID');
    return { source: 'server_api', provider, paymentId, reference: invoice.reference,
      amountMinor: 50, currency: 'USD', status: 'settled',
      transactionId: `purchase-${paymentId}`, eventId: `settled-${paymentId}` };
  };
  const adapter = {
    async initiate(input) {
      calls.initiate.push(input);
      if (!invoices.has(input.paymentId)) invoices.set(input.paymentId, { reference: `invoice-${input.paymentId}` });
      const result = { ...invoices.get(input.paymentId), instructions: 'Test invoice only' };
      return overrides.initiate ? overrides.initiate(input, result) : result;
    },
    async verify(input) {
      calls.verify.push(input);
      const result = settled(input.paymentId);
      return overrides.verify ? overrides.verify(input, result) : result;
    },
    async refund(input) {
      calls.refund.push(input);
      const result = { ...settled(input.paymentId), status: 'refunded', eventId: `refund-${input.paymentId}` };
      return overrides.refund ? overrides.refund(input, result) : result;
    },
    async test() { return { ok: true }; },
  };
  return { adapter, calls, overrides, invoices };
}

test('paymentView exposes only the fixed-price public fields', () => {
  const id = randomUUID(), userId = randomUUID(), createdAt = new Date();
  assert.deepEqual(paymentView({ id, user_id: userId, provider: 'zaad', currency: 'USD',
    status: 'pending', provider_reference: 'invoice', created_at: createdAt, phone: '+123456789',
    provider_transaction_id: 'private', amount_minor: 50 }),
  { id, userId, provider: 'zaad', amount: 0.5, amountMinor: 50, currency: 'USD',
    status: 'pending', reference: 'invoice', createdAt });
});

test('unconfigured integrations fail 503 before any database write', async () => {
  const service = createPaymentService({ pool: { query() { assert.fail('No database call expected'); } }, config: {}, adapters: {} });
  await assert.rejects(service.initiate(randomUUID(), { provider: 'zaad', phone: '+252612345678' }),
    error(503, 'integration_not_configured'));
});

test('client-supplied status, price and unknown request fields are rejected', async () => {
  const service = createPaymentService({ pool: { query() { assert.fail('No database call expected'); } }, config: {} });
  for (const extra of [{ status: 'succeeded' }, { amountMinor: 1 }, { currency: 'SOS' }, { reference: 'forged' }]) {
    await assert.rejects(service.initiate(randomUUID(), { provider: 'zaad', phone: '+252612345678', ...extra }),
      error(400, 'validation_error'));
  }
});

test('adapter loader permits absence but rejects remote URLs and invalid local contracts', async () => {
  assert.deepEqual(await loadAdapters({ paymentAdapterModule: '' }), {});
  for (const paymentAdapterModule of ['https://example.test/provider.js', 'data:text/javascript,export const adapters={}',
    new URL('../src/security.js', import.meta.url).href]) {
    await assert.rejects(loadAdapters({ paymentAdapterModule }), error(503, 'integration_not_configured'));
  }
});

test('PostgreSQL payment domain', { skip: !process.env.TEST_DATABASE_URL, concurrency: false }, async t => {
  // The parent runner owns migrations and TEST_DATABASE_URL. Never migrate or truncate a shared DB here.
  const config = loadConfig({ ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, NODE_ENV: 'test',
    PROVIDER_ENCRYPTION_KEY: randomBytes(32).toString('base64'), PROVIDER_ALLOWED_HOSTS: 'payments.example.test' });
  const pool = createPool(config);
  const originals = (await pool.query("SELECT * FROM providers WHERE provider IN ('zaad','edahab')")).rows;
  t.after(async () => {
    try {
      for (const row of originals) await pool.query(`UPDATE providers SET merchant_id=$2,api_url=$3,
        api_key_encrypted=$4,secret_key_encrypted=$5,environment=$6,updated_at=$7 WHERE provider=$1`,
      [row.provider, row.merchant_id, row.api_url, row.api_key_encrypted, row.secret_key_encrypted, row.environment, row.updated_at]);
    } finally { await pool.end(); }
  });
  assert.equal(originals.length, 2, 'The parent runner must migrate schema.sql first');
  async function configure(provider, environment = 'production') {
    await pool.query(`UPDATE providers SET merchant_id=$2,api_url='https://payments.example.test/api',
      api_key_encrypted=$3,secret_key_encrypted=$4,environment=$5,updated_at=now() WHERE provider=$1`,
    [provider, `test-${provider}`, encrypt('test-api-key', config.encryptionKey, `provider:${provider}:apiKey`),
      encrypt('test-secret-key', config.encryptionKey, `provider:${provider}:secretKey`), environment]);
  }
  await configure('zaad');
  await configure('edahab');
  async function user(role = 'customer') {
    const id = randomUUID();
    const phone = `+1${BigInt(`0x${id.replaceAll('-', '')}`).toString().slice(-12)}`;
    const { rows } = await pool.query(`INSERT INTO users(id,name,email,phone,password_hash,role)
      VALUES($1,'Payment Test',$2,$3,'not-a-login-hash',$4) RETURNING *`, [id, `${id}@payments.example.test`, phone, role]);
    return rows[0];
  }
  function fixture(provider = 'zaad') {
    const fake = merchant(provider);
    return { ...fake, service: createPaymentService({ pool, config, adapters: { [provider]: fake.adapter } }), provider };
  }
  const begin = (fixture, account) => fixture.service.initiate(account.id, { provider: fixture.provider, phone: account.phone });
  const subscription = async userId => (await pool.query('SELECT * FROM subscriptions WHERE user_id=$1', [userId])).rows[0];
  const stored = async id => (await pool.query('SELECT * FROM payments WHERE id=$1', [id])).rows[0];
  const admin = await user('admin');

  await t.test('missing credentials and disallowed endpoints fail before insertion', async () => {
    const f = fixture(), account = await user();
    const disallowed = createPaymentService({ pool, config: { ...config, providerHosts: new Set() }, adapters: { zaad: f.adapter } });
    await assert.rejects(disallowed.initiate(account.id, { provider: 'zaad', phone: account.phone }), error(503, 'integration_not_configured'));
    const original = (await pool.query("SELECT secret_key_encrypted FROM providers WHERE provider='zaad'")).rows[0];
    try {
      await pool.query("UPDATE providers SET secret_key_encrypted=NULL WHERE provider='zaad'");
      await assert.rejects(begin(f, account), error(503, 'integration_not_configured'));
    } finally {
      await pool.query("UPDATE providers SET secret_key_encrypted=$1 WHERE provider='zaad'", [original.secret_key_encrypted]);
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE user_id=$1', [account.id])).rows[0].n, 0);
    assert.equal(f.calls.initiate.length, 0);
  });

  await t.test('sandbox cannot create a live charge or grant', async () => {
    const f = fixture('edahab'), account = await user();
    try {
      await pool.query("UPDATE providers SET environment='sandbox' WHERE provider='edahab'");
      await assert.rejects(begin(f, account), error(503, 'sandbox_not_supported'));
      assert.equal(f.calls.initiate.length, 0);
      assert.equal(await subscription(account.id), undefined);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM payments WHERE user_id=$1', [account.id])).rows[0].n, 0);
    } finally { await pool.query("UPDATE providers SET environment='production' WHERE provider='edahab'"); }
  });

  await t.test('invoice creation is pending; only server settlement grants one calendar month', async () => {
    const f = fixture('edahab'), account = await user();
    const payment = await begin(f, account);
    assert.equal(payment.status, 'pending');
    assert.equal(await subscription(account.id), undefined);
    assert.equal(f.calls.initiate[0].amountMinor, 50);
    assert.equal(f.calls.initiate[0].credentials.apiKey, 'test-api-key');
    assert.equal(f.calls.initiate[0].credentials.secretKey, 'test-secret-key');
    f.overrides.verify = (_input, result) => {
      const { transactionId, eventId, ...pending } = result;
      return { ...pending, status: 'pending' };
    };
    assert.equal((await f.service.verify(payment.id, account.id)).status, 'pending');
    assert.equal(await subscription(account.id), undefined);
    delete f.overrides.verify;
    assert.equal((await f.service.verify(payment.id, account.id)).status, 'succeeded');
    const { rows } = await pool.query("SELECT expires_at=started_at+interval '1 month' AS exact FROM subscriptions WHERE user_id=$1", [account.id]);
    assert.equal(rows[0].exact, true);
  });

  await t.test('forged source, wrong amount/currency/provider/IDs and extra evidence cannot grant', async () => {
    const f = fixture(), account = await user(), payment = await begin(f, account);
    const mutations = [
      { source: 'client' }, { source: 'webhook' }, { source: undefined }, { amountMinor: 49 }, { amountMinor: '50' },
      { currency: 'SOS' }, { provider: 'edahab' }, { paymentId: randomUUID() }, { reference: 'wrong-invoice' },
      { status: 'success' }, { settled: true }, { transactionId: '' }, { eventId: undefined },
    ];
    for (const mutation of mutations) {
      f.overrides.verify = (_input, result) => ({ ...result, ...mutation });
      await assert.rejects(f.service.verify(payment.id), error(502, 'invalid_provider_evidence'));
      assert.equal(await subscription(account.id), undefined);
      assert.equal((await stored(payment.id)).status, 'pending');
    }
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1', [payment.id])).rows[0].n, 0);
  });

  await t.test('initiation cannot claim settlement in its strict receipt', async () => {
    const f = fixture(), account = await user();
    f.overrides.initiate = (_input, result) => ({ ...result, status: 'settled' });
    await assert.rejects(begin(f, account), error(502, 'invalid_provider_evidence'));
    assert.equal(await subscription(account.id), undefined);
    assert.equal((await pool.query('SELECT status FROM payments WHERE user_id=$1', [account.id])).rows[0].status, 'initiating');
  });

  await t.test('concurrent/repeated verification is idempotent and uses calendar months, not 30 days', async () => {
    const f = fixture(), account = await user();
    await pool.query("INSERT INTO subscriptions(user_id,expires_at) VALUES($1,'2092-01-31 12:00:00+00')", [account.id]);
    const payment = await begin(f, account);
    const results = await Promise.all([f.service.verify(payment.id), f.service.verify(payment.id)]);
    assert.ok(results.every(result => result.status === 'succeeded'));
    await f.service.verify(payment.id);
    assert.equal((await subscription(account.id)).expires_at.toISOString(), '2092-02-29T12:00:00.000Z');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1', [payment.id])).rows[0].n, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE target_id=$1 AND action='payment.succeeded'", [payment.id])).rows[0].n, 1);
  });

  await t.test('reusing an event or provider transaction on a different payment rolls back its grant', async () => {
    for (const field of ['eventId', 'transactionId']) {
      const f = fixture(), firstUser = await user(), secondUser = await user();
      const first = await begin(f, firstUser);
      await f.service.verify(first.id);
      const second = await begin(f, secondUser);
      f.overrides.verify = (_input, result) => ({ ...result,
        [field]: field === 'eventId' ? `settled-${first.id}` : `purchase-${first.id}` });
      await assert.rejects(f.service.verify(second.id), error(409, 'provider_replay'));
      assert.equal(await subscription(secondUser.id), undefined);
      assert.equal((await stored(second.id)).status, 'pending');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1', [second.id])).rows[0].n, 0);
    }
  });

  await t.test('duplicate invoice guard survives initiation and verification attempts', async () => {
    const f = fixture(), firstUser = await user(), secondUser = await user();
    const first = await begin(f, firstUser);
    f.overrides.initiate = (_input, result) => ({ ...result, reference: first.reference });
    await assert.rejects(begin(f, secondUser), error(409, 'provider_replay'));
    const second = (await pool.query('SELECT * FROM payments WHERE user_id=$1', [secondUser.id])).rows[0];
    assert.equal(second.status, 'initiating');
    assert.equal(second.provider_reference, null);
    f.overrides.verify = (_input, result) => ({ ...result, reference: first.reference });
    await assert.rejects(f.service.verify(second.id), error(409, 'provider_replay'));
    assert.equal(await subscription(secondUser.id), undefined);
    assert.equal((await stored(second.id)).provider_reference, null);
  });

  await t.test('timeout preserves initiation; retries reuse its ID and reconciliation never charges again', async () => {
    const f = fixture(), account = await user();
    f.overrides.initiate = () => { throw new Error('Timeout after provider accepted charge'); };
    await assert.rejects(begin(f, account), error(502, 'initiate_uncertain'));
    const payment = (await pool.query('SELECT * FROM payments WHERE user_id=$1', [account.id])).rows[0];
    assert.equal(payment.status, 'initiating');
    assert.equal((await begin(f, account)).id, payment.id);
    assert.equal(f.calls.initiate.length, 1);
    await assert.rejects(f.service.initiate(account.id, { provider: 'zaad', phone: '+1999999999999' }), error(409, 'payment_in_progress'));
    assert.equal((await f.service.verify(payment.id)).status, 'succeeded');
    assert.equal(f.calls.verify[0].reference, null);
    assert.equal(f.calls.verify[0].paymentId, payment.id);
    assert.equal(f.calls.initiate.length, 1);
  });

  await t.test('in-flight retries do not duplicate calls or hold a transaction across provider I/O', async () => {
    const f = fixture(), account = await user();
    let release, started;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    f.overrides.initiate = async (_input, result) => { started(); await gate; return result; };
    const initiating = begin(f, account);
    try {
      await entered;
      const retry = await begin(f, account);
      assert.equal(retry.status, 'initiating');
      await transaction(pool, async db => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE NOWAIT', [account.id]);
        await db.query('SELECT id FROM payments WHERE id=$1 FOR UPDATE NOWAIT', [retry.id]);
      });
      assert.equal(f.calls.initiate.length, 1);
    } finally { release(); }
    assert.equal((await initiating).status, 'pending');
  });

  await t.test('get and manual operations enforce ownership/admin boundaries', async () => {
    const f = fixture(), account = await user(), stranger = await user(), payment = await begin(f, account);
    await assert.rejects(f.service.get(stranger.id, payment.id), error(404, 'payment_not_found'));
    await assert.rejects(f.service.verify(payment.id, stranger.id), error(403, 'forbidden'));
    assert.equal((await f.service.get(account.id, payment.id)).id, payment.id);
    await f.service.verify(payment.id, account.id);
    await assert.rejects(f.service.refund(payment.id, account.id), error(403, 'forbidden'));
    await assert.rejects(f.service.refund(payment.id), error(403, 'forbidden'));
    assert.equal(f.calls.refund.length, 0);
  });

  await t.test('configuration changes cannot reclassify or verify an existing production invoice', async () => {
    const f = fixture(), account = await user(), payment = await begin(f, account);
    try {
      await pool.query("UPDATE providers SET merchant_id='different-test-merchant' WHERE provider='zaad'");
      await assert.rejects(f.service.verify(payment.id), error(409, 'integration_changed'));
      assert.equal(f.calls.verify.length, 0);
      assert.equal(await subscription(account.id), undefined);
    } finally { await pool.query("UPDATE providers SET merchant_id='test-zaad' WHERE provider='zaad'"); }
  });

  await t.test('latest-grant refund is idempotent and preserves all earlier remaining paid time', async () => {
    const f = fixture(), account = await user();
    await pool.query("INSERT INTO subscriptions(user_id,expires_at) VALUES($1,'2092-01-31 12:00:00+00')", [account.id]);
    const payment = await begin(f, account);
    await f.service.verify(payment.id);
    assert.equal((await f.service.refund(payment.id, admin.id)).status, 'refunded');
    assert.equal((await f.service.refund(payment.id, admin.id)).status, 'refunded');
    const remaining = await subscription(account.id);
    assert.equal(remaining.expires_at.toISOString(), '2092-01-31T12:00:00.000Z');
    assert.equal(remaining.cancelled_at, null);
    assert.equal(f.calls.refund.length, 1);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_events WHERE payment_id=$1 AND kind='refund'", [payment.id])).rows[0].n, 1);
  });

  await t.test('refund of a currently consumed grant revokes only its remaining access', async () => {
    const f = fixture(), account = await user(), payment = await begin(f, account);
    await f.service.verify(payment.id);
    await f.service.refund(payment.id, admin.id);
    const { rows } = await pool.query('SELECT expires_at<=now() AS revoked,expires_at>=started_at AS valid FROM subscriptions WHERE user_id=$1', [account.id]);
    assert.deepEqual(rows[0], { revoked: true, valid: true });
  });

  await t.test('earlier stacked grants are rejected before any refund network call', async () => {
    const f = fixture(), account = await user(), first = await begin(f, account);
    await f.service.verify(first.id);
    const second = await begin(f, account);
    await f.service.verify(second.id);
    const before = (await subscription(account.id)).expires_at.toISOString();
    await assert.rejects(f.service.refund(first.id, admin.id), error(409, 'refund_requires_manual_review'));
    assert.equal(f.calls.refund.length, 0);
    assert.equal((await subscription(account.id)).expires_at.toISOString(), before);
  });

  await t.test('uncertain refund reserves the grant and retries the same provider operation', async () => {
    const f = fixture(), account = await user(), payment = await begin(f, account);
    await f.service.verify(payment.id);
    const before = (await subscription(account.id)).expires_at.toISOString();
    f.overrides.refund = () => { throw new Error('Refund accepted but response lost'); };
    await assert.rejects(f.service.refund(payment.id, admin.id), error(502, 'refund_uncertain'));
    assert.equal((await stored(payment.id)).status, 'succeeded');
    assert.equal((await subscription(account.id)).expires_at.toISOString(), before);
    await assert.rejects(begin(f, account), error(409, 'refund_in_progress'));
    delete f.overrides.refund;
    await f.service.refund(payment.id, admin.id);
    assert.deepEqual(f.calls.refund[0], f.calls.refund[1]);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM audit_logs WHERE target_id=$1 AND action='payment.refund_requested'", [payment.id])).rows[0].n, 1);
  });

  await t.test('forged/replayed refund evidence cannot revoke a grant', async () => {
    const f = fixture(), account = await user(), payment = await begin(f, account);
    await f.service.verify(payment.id);
    const before = (await subscription(account.id)).expires_at.toISOString();
    for (const mutation of [{ source: 'client' }, { amountMinor: 100 }, { transactionId: 'wrong-purchase' }]) {
      f.overrides.refund = (_input, result) => ({ ...result, ...mutation });
      await assert.rejects(f.service.refund(payment.id, admin.id), error(502, 'invalid_provider_evidence'));
    }
    f.overrides.refund = (_input, result) => ({ ...result, eventId: `settled-${payment.id}` });
    await assert.rejects(f.service.refund(payment.id, admin.id), error(409, 'provider_replay'));
    assert.equal((await stored(payment.id)).status, 'succeeded');
    assert.equal((await subscription(account.id)).expires_at.toISOString(), before);
    delete f.overrides.refund;
    assert.equal((await f.service.refund(payment.id, admin.id)).status, 'refunded');
  });
});
