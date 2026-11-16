import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { encrypt, hashPassword, sha256 } from '../src/security.js';

const minimalPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const secretKeys = new Set(['password', 'passwordhash', 'tokenhash', 'sessionhash',
  'apikeyencrypted', 'secretkeyencrypted', 'streamurlencrypted']);
const newPassword = () => randomBytes(24).toString('base64url');
const identity = () => ({
  name: 'Isolated API Test',
  email: `api-${randomUUID()}@example.test`,
  phone: `+25263${randomInt(10_000_000, 100_000_000)}`,
  password: newPassword(),
});

// Assert booleans rather than comparing secrets: Node's assertion diagnostics must
// never print plaintext passwords, bearer tokens, upstream URLs, or ciphertext.
function assertNoCredentials(value, secrets = []) {
  const serialized = JSON.stringify(value) || '';
  for (const secret of secrets.filter(Boolean)) {
    assert.ok(!serialized.includes(secret), 'Response must not disclose credential material');
  }
  function visit(current) {
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      assert.ok(!secretKeys.has(key.replaceAll('_', '').toLowerCase()), 'Response must not expose a credential storage field');
      visit(child);
    }
  }
  visit(value);
}

function statusIs(response, expected) {
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), `Expected HTTP ${statuses.join(' or ')}, received ${response.status}`);
}

function assertSession(data, credentials, role = 'customer') {
  assert.ok(typeof data.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(data.token), 'Authentication must return an opaque bearer token');
  assert.ok(Number.isFinite(Date.parse(data.expiresAt)) && Date.parse(data.expiresAt) > Date.now(), 'Authentication must return a future session expiry');
  assert.ok(uuidPattern.test(data.user?.id || ''), 'Authentication must return a user ID');
  assert.equal(data.user.role, role);
  assert.ok(data.user.email === credentials.email && data.user.phone === credentials.phone, 'Authentication must return the matching public account');
  assertNoCredentials(data, [credentials.password]);
  assertNoCredentials(data.user, [data.token]);
}

describe('v1 API security and account lifecycle', { concurrency: false, timeout: 120_000 }, () => {
  let pool;
  let server;
  let origin;
  let config;
  let admin;

  async function request(method, path, { token, body } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetch(`${origin}/v1${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`${method} API request failed before receiving a response`);
    }
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { throw new Error(`${method} API returned non-JSON (HTTP ${response.status})`); }
    }
    return { status: response.status, data };
  }

  async function register(credentials = identity()) {
    const response = await request('POST', '/auth/register', { body: credentials });
    statusIs(response, 201);
    assertSession(response.data, credentials);
    return { ...response.data, credentials };
  }

  async function login(credentials, identifier = credentials.email) {
    const response = await request('POST', '/auth/login', { body: { identifier, password: credentials.password } });
    statusIs(response, 200);
    assertSession(response.data, credentials, credentials.role || 'customer');
    return response.data;
  }

  async function sessionCount(userId) {
    const { rows: [row] } = await pool.query('SELECT count(*)::integer AS count FROM sessions WHERE user_id=$1', [userId]);
    return row.count;
  }

  before(async () => {
    // External runners must explicitly supply a disposable, already-migrated DB.
    // Never fall back to DATABASE_URL, which may name a developer's real database.
    if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required; run npm test for an isolated, migrated PostgreSQL database.');
    config = loadConfig({
      NODE_ENV: 'test', DATABASE_URL: process.env.TEST_DATABASE_URL,
      PROVIDER_ENCRYPTION_KEY: process.env.PROVIDER_ENCRYPTION_KEY || randomBytes(32).toString('base64'),
      PUBLIC_BASE_URL: 'http://127.0.0.1:8080',
      PROVIDER_ALLOWED_HOSTS: 'api.example.test', STREAM_ALLOWED_HOSTS: 'stream.example.test',
      PAYMENT_ADAPTER_MODULE: '', FCM_SERVICE_ACCOUNT_FILE: '',
    });
    pool = createPool(config);
    const app = await createApp({ pool, config });
    server = await new Promise((resolveListen, reject) => {
      const listening = app.listen(0, '127.0.0.1');
      server = listening;
      listening.once('error', reject);
      listening.once('listening', () => resolveListen(listening));
    });
    origin = `http://127.0.0.1:${server.address().port}`;

    const credentials = { ...identity(), name: 'Isolated Test Administrator', role: 'admin' };
    const passwordHash = await hashPassword(credentials.password);
    await pool.query("INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'admin')",
      [credentials.name, credentials.email, credentials.phone, passwordHash]);
    admin = { ...await login(credentials), credentials };
  });

  after(async () => {
    try {
      if (server?.listening) {
        await new Promise((resolveClose, reject) => {
          server.close(error => error ? reject(error) : resolveClose());
          server.closeAllConnections();
        });
      }
    } finally { if (pool) await pool.end(); }
  });

  it('strictly rejects role injection during registration and creates only customers', async () => {
    const credentials = identity();
    const rejected = await request('POST', '/auth/register', { body: { ...credentials, role: 'admin' } });
    statusIs(rejected, 400);
    assertNoCredentials(rejected.data, [credentials.password]);
    const { rowCount } = await pool.query('SELECT id FROM users WHERE email=$1', [credentials.email]);
    assert.equal(rowCount, 0, 'Rejected registration must not create an account');
    await register(credentials);
  });

  it('rejects unauthenticated and customer access to the admin dashboard', async () => {
    const customer = await register();
    statusIs(await request('GET', '/admin/dashboard'), 401);
    statusIs(await request('GET', '/admin/dashboard', { token: customer.token }), 403);
    const dashboard = await request('GET', '/admin/dashboard', { token: admin.token });
    statusIs(dashboard, 200);
    assertNoCredentials(dashboard.data, [admin.token, admin.credentials.password, customer.token, customer.credentials.password]);
  });

  it('logs in by email and phone, rejects invalid passwords, and never returns stored credentials', async () => {
    const customer = await register();
    await login(customer.credentials);
    await login(customer.credentials, customer.credentials.phone);
    const count = await sessionCount(customer.user.id);
    const wrongPassword = newPassword();
    const rejected = await request('POST', '/auth/login', {
      body: { identifier: customer.credentials.email, password: wrongPassword },
    });
    statusIs(rejected, 401);
    assertNoCredentials(rejected.data, [wrongPassword, customer.credentials.password]);
    assert.equal(await sessionCount(customer.user.id), count, 'Failed login must not create a session');
    statusIs(await request('POST', '/auth/login', { body: { identifier: identity().email, password: wrongPassword } }), 401);
    const me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    const { rows: [stored] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [customer.user.id]);
    assertNoCredentials(me.data, [stored.password_hash, customer.credentials.password, customer.token]);
  });

  it('returns bootstrap channel metadata without raw upstream URLs or encrypted credentials', async t => {
    const id = randomUUID();
    const upstream = `https://stream.example.test/live/${randomUUID()}/index.m3u8?key=${randomBytes(20).toString('hex')}`;
    const encrypted = encrypt(upstream, config.encryptionKey, `channel:${id}:stream`);
    await pool.query(`INSERT INTO channels(id,name,category,quality,stream_url_encrypted,stream_type,active,licensed)
      VALUES($1,'API test channel','Sports','HD',$2,'hls',true,true)`, [id, encrypted]);
    t.after(() => pool.query('DELETE FROM channels WHERE id=$1', [id]));
    const response = await request('GET', '/bootstrap');
    statusIs(response, 200);
    assert.ok(Array.isArray(response.data.channels), 'Bootstrap must return a channel catalogue');
    assert.ok(response.data.channels.some(channel => channel.id === id), 'The public catalogue must include the active fixture channel');
    assertNoCredentials(response.data, [upstream, encrypted, new URL(upstream).searchParams.get('key')]);
    assert.ok(!JSON.stringify(response.data).includes('stream.example.test'), 'The public catalogue must not reveal the upstream host');
  });

  it('starts a trial exactly once under concurrent requests, with no expiry reset', async () => {
    const customer = await register();
    const { rows: [settings] } = await pool.query('SELECT trial_enabled,trial_minutes FROM app_settings');
    assert.equal(settings.trial_enabled, true, 'The migrated test fixture must enable trials');
    assert.ok(settings.trial_minutes >= 1 && settings.trial_minutes <= 120);
    const responses = await Promise.all(Array.from({ length: 4 }, () => request('POST', '/trial/start', { token: customer.token })));
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409, 409, 409]);
    const { rows } = await pool.query('SELECT started_at,expires_at FROM trials WHERE user_id=$1', [customer.user.id]);
    assert.equal(rows.length, 1);
    const original = rows[0];
    assert.equal(original.expires_at.getTime() - original.started_at.getTime(), settings.trial_minutes * 60_000);
    statusIs(await request('POST', '/trial/start', { token: customer.token }), 409);
    const { rows: [unchanged] } = await pool.query('SELECT started_at,expires_at FROM trials WHERE user_id=$1', [customer.user.id]);
    assert.deepEqual(unchanged, original, 'Repeated trial requests must not reset history');
    const me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    assert.ok(Number.isInteger(me.data.trial.remainingSeconds) && me.data.trial.remainingSeconds > 0 &&
      me.data.trial.remainingSeconds <= settings.trial_minutes * 60, 'Account must report bounded trial time remaining');
    assert.equal(me.data.trial.eligible, false);
    assert.equal(me.data.subscription.active, false);
    assertNoCredentials(me.data, [customer.token, customer.credentials.password]);
  });

  it('reports zero remaining time for an expired trial and does not restart it', async () => {
    const customer = await register();
    const { rows: [original] } = await pool.query(`INSERT INTO trials(user_id,started_at,expires_at)
      VALUES($1,now()-interval '1 day',now()-interval '1 day'+interval '15 minutes') RETURNING started_at,expires_at`, [customer.user.id]);
    const me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    assert.equal(me.data.trial.remainingSeconds, 0);
    assert.equal(me.data.trial.eligible, false);
    assert.equal(me.data.subscription.active, false);
    statusIs(await request('POST', '/trial/start', { token: customer.token }), 409);
    const { rows: [unchanged] } = await pool.query('SELECT started_at,expires_at FROM trials WHERE user_id=$1', [customer.user.id]);
    assert.deepEqual(unchanged, original);
  });

  it('reports active, cancelled, and expired subscriptions from server state', async () => {
    const customer = await register();
    await pool.query("INSERT INTO subscriptions(user_id,expires_at) VALUES($1,now()+interval '1 day')", [customer.user.id]);
    let me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    assert.equal(me.data.subscription.active, true);
    await pool.query('UPDATE subscriptions SET cancelled_at=now() WHERE user_id=$1', [customer.user.id]);
    me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    assert.equal(me.data.subscription.active, false);
    await pool.query("UPDATE subscriptions SET cancelled_at=NULL,expires_at=now()-interval '1 minute' WHERE user_id=$1", [customer.user.id]);
    me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    assert.equal(me.data.subscription.active, false);
  });

  it('admin suspension revokes every customer session and prevents login', async () => {
    const customer = await register();
    const secondSession = await login(customer.credentials);
    assert.equal(await sessionCount(customer.user.id), 2);
    statusIs(await request('PATCH', `/admin/customers/${customer.user.id}`, {
      token: customer.token, body: { status: 'suspended' },
    }), 403);
    const suspended = await request('PATCH', `/admin/customers/${customer.user.id}`, {
      token: admin.token, body: { status: 'suspended' },
    });
    statusIs(suspended, 200);
    assertNoCredentials(suspended.data, [customer.credentials.password, customer.token]);
    assert.equal(await sessionCount(customer.user.id), 0, 'Suspension must delete sessions, not merely deny individual requests');
    for (const token of [customer.token, secondSession.token]) statusIs(await request('GET', '/me', { token }), 401);
    statusIs(await request('POST', '/auth/login', {
      body: { identifier: customer.credentials.email, password: customer.credentials.password },
    }), 401);
  });

  it('requires authentication and valid payment phones, and fails closed without an adapter', async () => {
    const customer = await register();
    const body = { provider: 'edahab', phone: customer.credentials.phone };
    statusIs(await request('POST', '/payments', { body }), 401);
    statusIs(await request('POST', '/payments', { token: customer.token, body: { ...body, phone: 'not-a-phone' } }), 400);
    const unavailable = await request('POST', '/payments', { token: customer.token, body });
    statusIs(unavailable, 503);
    assertNoCredentials(unavailable.data, [customer.token, customer.credentials.password]);
    const { rowCount } = await pool.query("SELECT id FROM payments WHERE user_id=$1 AND status='succeeded'", [customer.user.id]);
    assert.equal(rowCount, 0, 'Unavailable integrations must never fabricate a successful payment');
    const me = await request('GET', '/me', { token: customer.token });
    statusIs(me, 200);
    assert.equal(me.data.subscription.active, false);
  });

  it('saves approved HTTPS provider configuration, masks secrets, and reports unavailable tests', async t => {
    const customer = await register();
    const path = '/admin/providers/zaad';
    statusIs(await request('GET', path, { token: customer.token }), 403);
    statusIs(await request('GET', path), 401);
    const { rows: [original] } = await pool.query("SELECT * FROM providers WHERE provider='zaad'");
    t.after(() => pool.query(`UPDATE providers SET merchant_id=$1,api_url=$2,api_key_encrypted=$3,
      secret_key_encrypted=$4,environment=$5,updated_at=$6 WHERE provider='zaad'`,
    [original.merchant_id, original.api_url, original.api_key_encrypted, original.secret_key_encrypted, original.environment, original.updated_at]));
    const credentials = {
      merchantId: `test-${randomUUID()}`, apiUrl: 'https://api.example.test/payments',
      apiKey: randomBytes(32).toString('base64url'), secretKey: randomBytes(32).toString('base64url'), environment: 'sandbox',
    };
    for (const apiUrl of ['http://api.example.test/payments', 'https://unapproved.example.test/payments']) {
      statusIs(await request('PUT', path, { token: admin.token, body: { ...credentials, apiUrl } }), 400);
    }
    const saved = await request('PUT', path, { token: admin.token, body: credentials });
    statusIs(saved, 200);
    assertNoCredentials(saved.data, [credentials.apiKey, credentials.secretKey]);
    const { rows: [stored] } = await pool.query("SELECT api_key_encrypted,secret_key_encrypted FROM providers WHERE provider='zaad'");
    assert.ok(stored.api_key_encrypted && stored.api_key_encrypted !== credentials.apiKey, 'API keys must be encrypted at rest');
    assert.ok(stored.secret_key_encrypted && stored.secret_key_encrypted !== credentials.secretKey, 'Provider secrets must be encrypted at rest');
    const fetched = await request('GET', path, { token: admin.token });
    statusIs(fetched, 200);
    assertNoCredentials(fetched.data, [credentials.apiKey, credentials.secretKey, stored.api_key_encrypted, stored.secret_key_encrypted]);
    const unavailable = await request('POST', `${path}/test`, { token: admin.token });
    statusIs(unavailable, 503);
    assertNoCredentials(unavailable.data, [credentials.apiKey, credentials.secretKey]);
  });

  it('accepts valid admin PNG uploads, rejects malformed PNGs, and returns 404 for unknown media', async () => {
    const customer = await register();
    const body = { mimeType: 'image/png', data: minimalPng };
    statusIs(await request('POST', '/admin/logos', { body }), 401);
    statusIs(await request('POST', '/admin/logos', { token: customer.token, body }), 403);
    for (const data of ['not-base64!', Buffer.from('not a PNG').toString('base64'), Buffer.from(minimalPng, 'base64').subarray(0, 12).toString('base64')]) {
      statusIs(await request('POST', '/admin/logos', { token: admin.token, body: { ...body, data } }), 400);
    }
    const uploaded = await request('POST', '/admin/logos', { token: admin.token, body });
    statusIs(uploaded, [200, 201]);
    assert.ok(typeof uploaded.data.url === 'string', 'Logo uploads must return a media URL');
    const url = new URL(uploaded.data.url, config.publicBaseUrl);
    assert.equal(url.origin, config.publicBaseUrl);
    assert.ok(url.pathname.startsWith('/v1/') && uuidPattern.test(url.pathname), 'Media must use a local, opaque asset URL');
    const media = await fetch(`${origin}${url.pathname}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    assert.equal(media.status, 200);
    assert.ok(media.headers.get('content-type')?.startsWith('image/png'));
    assert.ok(Buffer.from(await media.arrayBuffer()).equals(Buffer.from(minimalPng, 'base64')), 'Media must preserve the uploaded PNG bytes');
    const unknown = url.pathname.replace(uuidPattern, randomUUID());
    const missing = await fetch(`${origin}${unknown}`, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  });

  it('authenticates notifications and device registration, bounds tokens, and removes logout-bound devices', async () => {
    const customer = await register();
    statusIs(await request('GET', '/notifications'), 401);
    statusIs(await request('POST', '/devices', { body: { token: randomBytes(16).toString('hex') } }), 401);
    for (const token of ['', 'a'.repeat(9), 'a'.repeat(4097), 123]) {
      statusIs(await request('POST', '/devices', { token: customer.token, body: { token } }), 400);
    }
    for (const token of [randomBytes(8).toString('hex').slice(0, 10), randomBytes(32).toString('hex').padEnd(4096, 'a')]) {
      statusIs(await request('POST', '/devices', { token: customer.token, body: { token } }), [200, 201]);
    }
    const { rows: devices } = await pool.query('SELECT session_hash FROM devices WHERE user_id=$1', [customer.user.id]);
    assert.equal(devices.length, 2);
    assert.ok(devices.every(device => device.session_hash === sha256(customer.token)), 'Devices must be bound to the authenticated session');
    const notifications = await request('GET', '/notifications', { token: customer.token });
    statusIs(notifications, 200);
    assertNoCredentials(notifications.data, [customer.token, customer.credentials.password]);
    statusIs(await request('POST', '/auth/logout', { token: customer.token }), [200, 204]);
    statusIs(await request('GET', '/me', { token: customer.token }), 401);
    statusIs(await request('GET', '/notifications', { token: customer.token }), 401);
    statusIs(await request('POST', '/devices', { token: customer.token, body: { token: randomBytes(16).toString('hex') } }), 401);
    assert.equal(await sessionCount(customer.user.id), 0);
    const { rowCount } = await pool.query('SELECT token FROM devices WHERE user_id=$1', [customer.user.id]);
    assert.equal(rowCount, 0, 'Logout must cascade to session-bound devices');
  });

  it('rejects incorrect current passwords without mutation and revokes other sessions after a valid change', async () => {
    const customer = await register();
    const otherSession = await login(customer.credentials);
    const password = newPassword();
    const { rows: [original] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [customer.user.id]);
    const rejected = await request('POST', '/me/password', {
      token: customer.token, body: { currentPassword: newPassword(), newPassword: password },
    });
    statusIs(rejected, [400, 401]);
    assertNoCredentials(rejected.data, [password, customer.credentials.password, original.password_hash]);
    const { rows: [unchanged] } = await pool.query('SELECT password_hash FROM users WHERE id=$1', [customer.user.id]);
    assert.ok(unchanged.password_hash === original.password_hash, 'A rejected password change must not alter stored credentials');
    assert.equal(await sessionCount(customer.user.id), 2);
    statusIs(await request('GET', '/me', { token: otherSession.token }), 200);
    const changed = await request('POST', '/me/password', {
      token: customer.token, body: { currentPassword: customer.credentials.password, newPassword: password },
    });
    statusIs(changed, [200, 204]);
    assertNoCredentials(changed.data, [password, customer.credentials.password]);
    statusIs(await request('GET', '/me', { token: otherSession.token }), 401);
    statusIs(await request('POST', '/auth/login', {
      body: { identifier: customer.credentials.email, password: customer.credentials.password },
    }), 401);
    await login({ ...customer.credentials, password });
  });
});
