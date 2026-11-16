import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, transaction } from './db.js';
import { fail, validate } from './errors.js';
import { encrypt, decrypt, uuidSchema } from './security.js';
import { validateStreamUrl } from './streams.js';
import { paymentView } from './payments.js';

export const channelView = c => ({ id: c.id, name: c.name, category: c.category, quality: c.quality,
  logoUrl: c.logo_url || '', active: c.active, premium: c.premium, licensed: c.licensed, streamConfigured: Boolean(c.stream_url_encrypted) });
const settingsView = s => ({ trialEnabled: s.trial_enabled, trialMinutes: s.trial_minutes, appName: s.app_name, supportEmail: s.support_email });
const providerName = value => validate(z.enum(['zaad', 'edahab']), value);
const providerView = p => ({ provider: p.provider, merchantId: p.merchant_id, apiUrl: p.api_url,
  environment: p.environment, apiKeyConfigured: Boolean(p.api_key_encrypted), secretKeyConfigured: Boolean(p.secret_key_encrypted) });
const idParam = req => validate(uuidSchema, req.params.id);
const channelSchema = z.object({ name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60),
  quality: z.string().trim().min(1).max(30), streamUrl: z.string().trim().max(8192).optional(),
  logoUrl: z.string().trim().max(2048).optional(), active: z.boolean(), premium: z.boolean(), licensed: z.boolean() }).strict();

export function registerAdminRoutes(router, { pool, config, payments, adapters, notifications }) {
  router.get('/dashboard', async (req, res) => {
    const { rows: [counts] } = await pool.query(`SELECT
      (SELECT count(*)::int FROM users WHERE role='customer' AND status<>'deleted') AS "totalCustomers",
      (SELECT count(*)::int FROM users WHERE status<>'deleted') AS "registeredUsers",
      (SELECT count(*)::int FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.expires_at>now() AND s.cancelled_at IS NULL AND u.status='active') AS "activeSubscriptions",
      (SELECT count(*)::int FROM subscriptions WHERE expires_at<=now() OR cancelled_at IS NOT NULL) AS "expiredSubscriptions",
      (SELECT coalesce(sum(amount_minor),0)::float/100 FROM payments WHERE status='succeeded') AS "totalRevenue",
      (SELECT count(*)::int FROM payments WHERE status='succeeded' AND paid_at>=date_trunc('day',now())) AS "todayPayments",
      (SELECT count(*)::int FROM channels WHERE active AND licensed) AS "activeStreams"`);
    const { rows } = await pool.query('SELECT * FROM payments ORDER BY created_at DESC LIMIT 10');
    res.json({ ...counts, recentTransactions: rows.map(paymentView) });
  });
  router.get('/channels', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM channels ORDER BY name');
    res.json({ items: rows.map(channelView) });
  });
  async function saveChannel(req, res) {
    const creating = req.method === 'POST';
    const id = creating ? randomUUID() : idParam(req);
    const body = validate(creating ? channelSchema : channelSchema.partial(), req.body);
    await transaction(pool, async db => {
      const { rows: [previous] } = await db.query('SELECT * FROM channels WHERE id=$1 FOR UPDATE', [id]);
      if (!creating && !previous) fail(404, 'channel_not_found', 'Channel not found.');
      const value = { ...channelView(previous || {}), ...body };
      let ciphertext = previous?.stream_url_encrypted || null;
      let streamType = previous?.stream_type || null;
      if (body.streamUrl) {
        validateStreamUrl(body.streamUrl, config);
        const pathname = new URL(body.streamUrl).pathname.toLowerCase();
        streamType = pathname.endsWith('.m3u8') ? 'hls' : pathname.endsWith('.mpd') ? 'dash' : null;
        if (!streamType) fail(400, 'stream_format', 'Use an authorized HLS .m3u8 or MPEG-DASH .mpd manifest URL.');
        ciphertext = encrypt(body.streamUrl, config.encryptionKey, `channel:${id}:stream`);
      }
      if (value.logoUrl) {
        let url;
        try { url = new URL(value.logoUrl); } catch { fail(400, 'invalid_logo', 'Use a valid logo URL.'); }
        const local = url.origin === config.publicBaseUrl && /^\/v1\/media\/[a-f0-9-]{36}$/.test(url.pathname);
        if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.hash) fail(400, 'invalid_logo', 'Use HTTPS or an uploaded channel logo.');
      }
      if (value.active && (!value.licensed || !ciphertext)) fail(400, 'license_required', 'A licensed stream is required before activation.');
      if (creating) await db.query(`INSERT INTO channels(id,name,category,quality,logo_url,active,premium,licensed,stream_url_encrypted,stream_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id,value.name,value.category,value.quality,value.logoUrl || null,value.active,value.premium,value.licensed,ciphertext,streamType]);
      else await db.query(`UPDATE channels SET name=$2,category=$3,quality=$4,logo_url=$5,active=$6,premium=$7,licensed=$8,
        stream_url_encrypted=$9,stream_type=$10,updated_at=clock_timestamp() WHERE id=$1`, [id,value.name,value.category,value.quality,value.logoUrl || null,value.active,value.premium,value.licensed,ciphertext,streamType]);
      await audit(db, req.user.id, creating ? 'channel.created' : 'channel.updated', 'channel', id, { active: value.active, licensed: value.licensed });
    });
    const { rows: [channel] } = await pool.query('SELECT * FROM channels WHERE id=$1', [id]);
    res.status(creating ? 201 : 200).json(channelView(channel));
  }
  router.post('/channels', saveChannel);
  router.patch('/channels/:id', saveChannel);
  router.delete('/channels/:id', async (req, res) => {
    const id = idParam(req);
    await transaction(pool, async db => {
      const { rowCount } = await db.query('DELETE FROM channels WHERE id=$1', [id]);
      if (!rowCount) fail(404, 'channel_not_found', 'Channel not found.');
      await audit(db, req.user.id, 'channel.deleted', 'channel', id);
    });
    res.json({ message: 'Channel deleted.' });
  });
  router.get('/customers', async (req, res) => {
    const search = validate(z.string().max(100), req.query.search || '');
    const { rows } = await pool.query(`SELECT id,name,email,phone,status,created_at AS "createdAt" FROM users
      WHERE role='customer' AND status<>'deleted' AND ($1='' OR name ILIKE '%'||$1||'%' OR email ILIKE '%'||$1||'%' OR phone ILIKE '%'||$1||'%') ORDER BY created_at DESC LIMIT 1000`, [search]);
    res.json({ items: rows });
  });
  async function changeCustomer(req, res) {
    const id = idParam(req);
    const status = req.method === 'DELETE' ? 'deleted' : validate(z.object({ status: z.enum(['active','suspended']) }).strict(), req.body).status;
    await transaction(pool, async db => {
      const { rowCount } = await db.query(`UPDATE users SET status=$2,deleted_at=CASE WHEN $2='deleted' THEN now() ELSE deleted_at END
        WHERE id=$1 AND role='customer' AND status<>'deleted'`, [id, status]);
      if (!rowCount) fail(404, 'customer_not_found', 'Customer not found.');
      if (status !== 'active') await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(db, req.user.id, `customer.${status}`, 'user', id);
    });
    res.json({ message: status === 'deleted' ? 'Account closed. Financial, trial and audit history is retained.' : 'Customer status updated.' });
  }
  router.patch('/customers/:id', changeCustomer);
  router.delete('/customers/:id', changeCustomer);
  router.get('/subscriptions', async (req, res) => {
    const { rows } = await pool.query(`SELECT s.id,s.user_id AS "userId",u.name,u.email,s.started_at AS "startedAt",s.expires_at AS "expiresAt",
      s.cancelled_at AS "cancelledAt",s.expires_at>now() AND s.cancelled_at IS NULL AS active
      FROM subscriptions s JOIN users u ON u.id=s.user_id ORDER BY s.updated_at DESC LIMIT 1000`);
    res.json({ items: rows });
  });
  router.patch('/subscriptions/:id', async (req, res) => {
    const id = idParam(req);
    const { action } = validate(z.object({ action: z.enum(['cancel','renew']) }).strict(), req.body);
    await transaction(pool, async db => {
      const { rows: [subscription] } = await db.query('SELECT user_id FROM subscriptions WHERE id=$1', [id]);
      if (!subscription) fail(404, 'subscription_not_found', 'Subscription not found.');
      const { rows: [user] } = await db.query("SELECT status FROM users WHERE id=$1 FOR UPDATE", [subscription.user_id]);
      if (action === 'renew' && user.status !== 'active') fail(409, 'inactive_customer', 'Activate the customer before renewing access.');
      if (action === 'cancel') await db.query('UPDATE subscriptions SET cancelled_at=now(),updated_at=now() WHERE id=$1', [id]);
      else await db.query(`UPDATE subscriptions SET expires_at=(CASE WHEN cancelled_at IS NULL THEN greatest(expires_at,now()) ELSE now() END)+interval '1 month',cancelled_at=NULL,updated_at=now() WHERE id=$1`, [id]);
      await audit(db, req.user.id, action === 'renew' ? 'subscription.manual_renewal' : 'subscription.cancelled', 'subscription', id);
    });
    res.json({ message: action === 'renew' ? 'Administrative renewal applied. No payment has been recorded.' : 'Subscription cancelled.' });
  });
  router.get('/payments', async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM payments ORDER BY created_at DESC LIMIT 1000');
    res.json({ items: rows.map(paymentView) });
  });
  router.post('/payments/:id/verify', async (req, res) => res.json(await payments.verify(idParam(req), req.user.id)));
  router.post('/payments/:id/refund', async (req, res) => res.json(await payments.refund(idParam(req), req.user.id)));
  router.get('/providers/:provider', async (req, res) => {
    const { rows: [row] } = await pool.query('SELECT * FROM providers WHERE provider=$1', [providerName(req.params.provider)]);
    res.json(providerView(row));
  });
  router.put('/providers/:provider', async (req, res) => {
    const provider = providerName(req.params.provider);
    const secret = z.string().min(1).max(4096).refine(v => !/^[*•]+$/.test(v));
    const body = validate(z.object({ merchantId: z.string().trim().min(1).max(200), apiUrl: z.string().url().max(2048),
      apiKey: secret.optional(), secretKey: secret.optional(), environment: z.enum(['sandbox','production']) }).strict(), req.body);
    const url = new URL(body.apiUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search || (url.port && url.port !== '443') || !config.providerHosts.has(url.hostname)) fail(400, 'unapproved_provider', 'Use an approved exact HTTPS provider hostname without credentials or query parameters.');
    const row = await transaction(pool, async db => {
      const { rows: [previous] } = await db.query('SELECT * FROM providers WHERE provider=$1 FOR UPDATE', [provider]);
      const { rows: [saved] } = await db.query(`UPDATE providers SET merchant_id=$2,api_url=$3,environment=$4,api_key_encrypted=$5,secret_key_encrypted=$6,updated_at=now() WHERE provider=$1 RETURNING *`,
        [provider,body.merchantId,body.apiUrl,body.environment,
          body.apiKey ? encrypt(body.apiKey,config.encryptionKey,`provider:${provider}:apiKey`) : previous.api_key_encrypted,
          body.secretKey ? encrypt(body.secretKey,config.encryptionKey,`provider:${provider}:secretKey`) : previous.secret_key_encrypted]);
      await audit(db, req.user.id, 'provider.updated', 'provider', provider, { environment: body.environment });
      return saved;
    });
    res.json(providerView(row));
  });
  router.post('/providers/:provider/test', async (req, res) => {
    const provider = providerName(req.params.provider);
    const adapter = adapters[provider];
    if (!adapter?.test) fail(503, 'provider_unavailable', 'An approved server-side provider adapter must be installed before testing.');
    const { rows: [row] } = await pool.query('SELECT * FROM providers WHERE provider=$1', [provider]);
    if (!row.api_key_encrypted || !row.secret_key_encrypted || !row.merchant_id || !row.api_url) fail(503, 'provider_unconfigured', 'Complete the provider credentials before testing.');
    const url = new URL(row.api_url);
    if (url.protocol !== 'https:' || !config.providerHosts.has(url.hostname)) fail(503, 'provider_unapproved', 'The provider hostname is not approved.');
    const credentials = { merchantId: row.merchant_id, apiUrl: row.api_url, environment: row.environment,
      apiKey: decrypt(row.api_key_encrypted,config.encryptionKey,`provider:${provider}:apiKey`),
      secretKey: decrypt(row.secret_key_encrypted,config.encryptionKey,`provider:${provider}:secretKey`) };
    let connected = false;
    try { connected = (await adapter.test({ credentials }))?.ok === true; } catch { connected = false; }
    await audit(pool, req.user.id, 'provider.tested', 'provider', provider, { connected });
    if (!connected) fail(502, 'provider_test_failed', 'The provider did not confirm authenticated connectivity.');
    res.json({ connected: true, environment: row.environment, message: 'The provider confirmed authenticated connectivity. This does not confirm a payment.' });
  });
  router.get('/settings', async (req, res) => {
    const { rows: [row] } = await pool.query('SELECT * FROM app_settings');
    res.json(settingsView(row));
  });
  router.put('/settings', async (req, res) => {
    const body = validate(z.object({ trialEnabled: z.boolean().optional(), trialMinutes: z.number().int().min(1).max(120).optional(),
      appName: z.string().trim().min(1).max(100).optional(), supportEmail: z.union([z.literal(''), z.email()]).optional() }).strict().refine(v => Object.keys(v).length > 0), req.body);
    const row = await transaction(pool, async db => {
      const { rows: [saved] } = await db.query(`UPDATE app_settings SET trial_enabled=coalesce($1,trial_enabled),trial_minutes=coalesce($2,trial_minutes),
        app_name=coalesce($3,app_name),support_email=coalesce($4,support_email) RETURNING *`, [body.trialEnabled,body.trialMinutes,body.appName,body.supportEmail]);
      await audit(db, req.user.id, 'settings.updated', 'settings', null, body);
      return saved;
    });
    res.json(settingsView(row));
  });
  router.get('/trials', async (req, res) => {
    const { rows } = await pool.query(`SELECT t.user_id AS "userId",u.name,u.email,t.started_at AS "startedAt",t.expires_at AS "expiresAt",
      t.expires_at>now() AS active FROM trials t JOIN users u ON u.id=t.user_id ORDER BY t.started_at DESC LIMIT 1000`);
    res.json({ items: rows });
  });
  router.get('/reports', async (req, res) => {
    const { rows } = await pool.query(`SELECT date_trunc('day',created_at)::date AS day,provider,count(*)::int AS transactions,
      count(*) FILTER(WHERE status='succeeded')::int AS successful,
      coalesce(sum(amount_minor) FILTER(WHERE status='succeeded'),0)::float/100 AS revenue,
      count(*) FILTER(WHERE status='refunded')::int AS refunded FROM payments GROUP BY 1,2 ORDER BY 1 DESC LIMIT 180`);
    res.json({ currency: 'USD', items: rows });
  });
  router.get('/logs', async (req, res) => {
    const { rows } = await pool.query('SELECT id,actor_id AS "actorId",action,target_type AS "targetType",target_id AS "targetId",details,created_at AS "createdAt" FROM audit_logs ORDER BY id DESC LIMIT 500');
    res.json({ items: rows });
  });
  router.get('/notifications', async (req, res) => {
    const { rows } = await pool.query('SELECT id,title,body,audience,status,failure_code AS "failureCode",created_at AS "createdAt" FROM notifications ORDER BY created_at DESC LIMIT 100');
    res.json({ items: rows });
  });
  router.post('/notifications', async (req, res) => {
    const body = validate(z.object({ title: z.string().trim().min(1).max(120), body: z.string().trim().min(1).max(2000), audience: z.enum(['all','premium']) }).strict(), req.body);
    res.status(201).json(await notifications.send(req.user.id, body));
  });
}
