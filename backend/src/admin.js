import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, transaction } from './db.js';
import { fail, validate } from './errors.js';
import { encrypt, decrypt, hashPassword, uuidSchema, emailSchema, nameSchema, passwordSchema, phoneSchema } from './security.js';
import { validateStreamUrl } from './streams.js';
import { paymentView } from './payments.js';

export const channelView = c => ({ id: c.id, name: c.name, category: c.category, quality: c.quality,
  logoUrl: c.logo_url || '', active: c.active, premium: c.premium, licensed: c.licensed, streamConfigured: Boolean(c.stream_url_encrypted) });
const settingsView = s => ({ trialEnabled: s.trial_enabled, trialMinutes: s.trial_minutes, appName: s.app_name,
  supportEmail: s.support_email, supportPhone: s.support_phone, logoUrl: s.logo_url,
  currency: s.currency, priceMinor: s.price_minor });
const providerName = value => validate(z.enum(['zaad', 'edahab']), value);
const providerView = p => ({ provider: p.provider, merchantId: p.merchant_id, apiUrl: p.api_url,
  environment: p.environment, apiKeyConfigured: Boolean(p.api_key_encrypted), secretKeyConfigured: Boolean(p.secret_key_encrypted) });
const idParam = req => validate(uuidSchema, req.params.id);
const channelSchema = z.object({ name: z.string().trim().min(1).max(120), category: z.string().trim().min(1).max(60),
  quality: z.string().trim().min(1).max(30), streamUrl: z.string().trim().max(8192).optional(),
  logoUrl: z.string().trim().max(2048).optional(), active: z.boolean(), premium: z.boolean(), licensed: z.boolean() }).strict();
const adMimeTypes = ['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav'];
const audioAdView = (row, config) => ({ id: row.id, title: row.title, mimeType: row.mime_type, active: row.active,
  sizeBytes: row.size_bytes, createdAt: row.created_at, url: `${config.publicBaseUrl}/v1/ads/${row.id}/audio` });
const audioSignature = (mime, data) => {
  const ascii = (start, end) => data.subarray(start, end).toString('latin1');
  if (mime === 'audio/mpeg') return (data[0] === 0xFF && (data[1] & 0xE0) === 0xE0) || ascii(0, 3) === 'ID3';
  if (mime === 'audio/mp4') return data.length > 12 && ascii(4, 8) === 'ftyp';
  if (mime === 'audio/ogg') return ascii(0, 4) === 'OggS';
  if (mime === 'audio/wav') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE';
  return data[0] === 0xFF && (data[1] & 0xF0) === 0xF0;
};

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
  router.patch('/customers/:id', async (req, res) => {
    const id = idParam(req);
    const body = validate(z.object({ name: nameSchema.optional(), email: emailSchema.optional(), phone: phoneSchema.optional(),
      status: z.enum(['active', 'suspended']).optional() }).strict()
      .refine(value => Object.keys(value).length > 0), req.body);
    let saved;
    try {
      saved = await transaction(pool, async db => {
        const { rows: [current] } = await db.query("SELECT * FROM users WHERE id=$1 AND role='customer' AND status<>'deleted' FOR UPDATE", [id]);
        if (!current) fail(404, 'customer_not_found', 'Customer not found.');
        const status = body.status ?? current.status;
        const { rows: [updated] } = await db.query(`UPDATE users SET name=$2,email=$3,phone=$4,status=$5 WHERE id=$1
          RETURNING id,name,email,phone,status,created_at AS "createdAt"`,
        [id, body.name ?? current.name, body.email ?? current.email, body.phone ?? current.phone, status]);
        if (status !== 'active') await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
        await audit(db, req.user.id, 'customer.updated', 'user', id, { fields: Object.keys(body) });
        return updated;
      });
    } catch (err) {
      if (err?.code === '23505') fail(409, 'duplicate_customer', 'That email address or phone number is already used by another account.');
      throw err;
    }
    res.json({ message: 'Customer details updated.', customer: saved });
  });
  router.delete('/customers/:id', async (req, res) => {
    const id = idParam(req);
    await transaction(pool, async db => {
      const { rowCount } = await db.query(`UPDATE users SET status='deleted',deleted_at=now()
        WHERE id=$1 AND role='customer' AND status<>'deleted'`, [id]);
      if (!rowCount) fail(404, 'customer_not_found', 'Customer not found.');
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(db, req.user.id, 'customer.deleted', 'user', id);
    });
    res.json({ message: 'Account closed. Financial, trial and audit history is retained.' });
  });
  router.post('/customers/:id/password', async (req, res) => {
    const id = idParam(req);
    const { newPassword } = validate(z.object({ newPassword: passwordSchema }).strict(), req.body);
    const hash = await hashPassword(newPassword);
    await transaction(pool, async db => {
      const { rowCount } = await db.query(`UPDATE users SET password_hash=$2
        WHERE id=$1 AND role='customer' AND status<>'deleted'`, [id, hash]);
      if (!rowCount) fail(404, 'customer_not_found', 'Customer not found.');
      await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
      await audit(db, req.user.id, 'customer.password_reset', 'user', id);
    });
    res.json({ message: 'Password reset. The customer has been signed out on every device.' });
  });
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
      appName: z.string().trim().min(1).max(100).optional(), supportEmail: z.union([z.literal(''), z.email()]).optional(),
      supportPhone: z.union([z.literal(''), z.string().trim().regex(/^\+?[0-9][0-9 ()-]{6,30}$/)]).optional(),
      currency: z.string().trim().regex(/^[A-Za-z]{3,4}$/).transform(value => value.toUpperCase()).optional(),
      priceMinor: z.number().int().min(1).max(100000000).optional(),
      logoUrl: z.string().trim().max(2048).optional() }).strict().refine(value => Object.keys(value).length > 0), req.body);
    if (body.logoUrl) {
      let url;
      try { url = new URL(body.logoUrl); } catch { fail(400, 'invalid_logo', 'Use a valid logo URL.'); }
      const local = url.origin === config.publicBaseUrl && /^\/v1\/media\/[a-f0-9-]{36}$/.test(url.pathname);
      if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.hash) fail(400, 'invalid_logo', 'Use HTTPS or an uploaded logo.');
    }
    const row = await transaction(pool, async db => {
      const { rows: [saved] } = await db.query(`UPDATE app_settings SET trial_enabled=coalesce($1,trial_enabled),trial_minutes=coalesce($2,trial_minutes),
        app_name=coalesce($3,app_name),support_email=coalesce($4,support_email),support_phone=coalesce($5,support_phone),
        currency=coalesce($6,currency),price_minor=coalesce($7,price_minor),logo_url=coalesce($8,logo_url) RETURNING *`,
      [body.trialEnabled, body.trialMinutes, body.appName, body.supportEmail, body.supportPhone,
        body.currency, body.priceMinor, body.logoUrl]);
      await audit(db, req.user.id, 'settings.updated', 'settings', null, body);
      return saved;
    });
    res.json(settingsView(row));
  });
  router.get('/ads', async (req, res) => {
    const { rows } = await pool.query(`SELECT id,title,mime_type,active,octet_length(data) AS size_bytes,
      created_at FROM audio_ads ORDER BY created_at DESC LIMIT 100`);
    res.json({ items: rows.map(row => audioAdView(row, config)) });
  });
  router.post('/ads', async (req, res) => {
    const body = validate(z.object({ title: z.string().trim().min(1).max(120),
      mimeType: z.enum(adMimeTypes), data: z.string().min(4).max(7000000), active: z.boolean().optional() }).strict(), req.body);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data) || body.data.length % 4 !== 0) fail(400, 'invalid_audio', 'A base64 audio file is required.');
    const data = Buffer.from(body.data, 'base64');
    if (data.length < 1 || data.length > 5 * 1024 * 1024 || !audioSignature(body.mimeType, data)) {
      fail(400, 'invalid_audio', 'The file is not a supported audio recording of at most 5 MB.');
    }
    const id = randomUUID();
    const { rows: [row] } = await pool.query(`INSERT INTO audio_ads(id,title,mime_type,data,active,actor_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,title,mime_type,active,octet_length(data) AS size_bytes,created_at`,
    [id, body.title, body.mimeType, data, body.active ?? true, req.user.id]);
    await audit(pool, req.user.id, 'ad.created', 'audio_ad', id, { mimeType: body.mimeType, sizeBytes: data.length });
    res.status(201).json(audioAdView(row, config));
  });
  router.patch('/ads/:id', async (req, res) => {
    const id = idParam(req);
    const body = validate(z.object({ title: z.string().trim().min(1).max(120).optional(), active: z.boolean().optional() }).strict()
      .refine(value => Object.keys(value).length > 0), req.body);
    const { rows: [row] } = await pool.query(`UPDATE audio_ads SET title=coalesce($2,title),active=coalesce($3,active),updated_at=now()
      WHERE id=$1 RETURNING id,title,mime_type,active,octet_length(data) AS size_bytes,created_at`, [id, body.title, body.active]);
    if (!row) fail(404, 'ad_not_found', 'Audio ad not found.');
    await audit(pool, req.user.id, 'ad.updated', 'audio_ad', id, body);
    res.json(audioAdView(row, config));
  });
  router.delete('/ads/:id', async (req, res) => {
    const id = idParam(req);
    const { rowCount } = await pool.query('DELETE FROM audio_ads WHERE id=$1', [id]);
    if (!rowCount) fail(404, 'ad_not_found', 'Audio ad not found.');
    await audit(pool, req.user.id, 'ad.deleted', 'audio_ad', id);
    res.json({ message: 'Audio ad deleted.' });
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
    const { rows: [settings] } = await pool.query('SELECT currency FROM app_settings');
    res.json({ currency: settings.currency, items: rows });
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
