import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authentication, adminOnly, registerAccountRoutes } from './accounts.js';
import { registerAdminRoutes } from './admin.js';
import { errorHandler, fail, validate } from './errors.js';
import { createPaymentService } from './payments.js';
import { createStreamService } from './streams.js';
import { notificationService } from './notifications.js';

function pngDimensions(data) {
  if (data.length < 45 || data.length > 2 * 1024 * 1024) return null;
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  if (data.readUInt32BE(8) !== 13 || data.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8192 || height > 8192) return null;
  if (data.toString('ascii', data.length - 8, data.length - 4) !== 'IEND') return null;
  return { width, height };
}

export async function createApp({ pool, config, adapters = {} }) {
  const app = express();
  const logger = { info: () => {}, error: message => console.error(JSON.stringify(message)) };
  app.locals.logger = logger;
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxyHops > 0 ? config.trustProxyHops : false);
  app.use(helmet());
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-Id', req.requestId);
    next();
  });

  const smallJson = express.json({ limit: '32kb' });
  const logoJson = express.json({ limit: '3mb' });
  const adJson = express.json({ limit: '8mb' });
  app.use((req, res, next) => {
    const parser = req.method === 'POST' && req.path === '/v1/admin/logos' ? logoJson
      : req.method === 'POST' && req.path === '/v1/admin/ads' ? adJson : smallJson;
    return parser(req, res, next);
  });

  const limitHandler = (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests. Try again later.' } });
  const general = rateLimit({ windowMs: 15 * 60_000, limit: 2000, standardHeaders: 'draft-7', legacyHeaders: false, handler: limitHandler });
  const sensitive = rateLimit({ windowMs: 15 * 60_000, limit: 100, standardHeaders: 'draft-7', legacyHeaders: false, handler: limitHandler });

  const payments = createPaymentService({ pool, config, adapters });
  const streams = createStreamService({ pool, config });
  const notifications = notificationService({ pool, config });
  const auth = authentication(pool);
  const api = express.Router();
  app.use('/v1', general, api);

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  api.get('/bootstrap', async (req, res) => {
    const { rows: channels } = await pool.query('SELECT * FROM channels ORDER BY name');
    const { rows: [settings] } = await pool.query('SELECT * FROM app_settings');
    const { rows: matches } = await pool.query('SELECT id,home,away,competition,starts_at AS "startsAt",live FROM matches ORDER BY starts_at LIMIT 100');
    const { rows: ads } = await pool.query('SELECT id,title,mime_type,created_at FROM audio_ads WHERE active ORDER BY created_at DESC LIMIT 10');
    const base = ['Football', 'Basketball', 'Tennis', 'UFC', 'Cricket', 'Other Sports'];
    const categories = [...new Set([...base, ...channels.map(channel => channel.category)])];
    res.json({
      channels: channels.map(channel => ({ id: channel.id, name: channel.name, category: channel.category,
        quality: channel.quality, active: channel.active, premium: channel.premium,
        logoUrl: channel.logo_url || '', licensed: channel.licensed })),
      categories, matches, price: settings.price_minor / 100, priceMinor: settings.price_minor,
      currency: settings.currency, trialMinutes: settings.trial_minutes,
      appName: settings.app_name, supportEmail: settings.support_email, supportPhone: settings.support_phone,
      logoUrl: settings.logo_url,
      ads: ads.map(ad => ({ id: ad.id, title: ad.title, mimeType: ad.mime_type,
        url: `${config.publicBaseUrl}/v1/ads/${ad.id}/audio` })),
    });
  });

  api.get('/ads/:id/audio', async (req, res) => {
    const id = validate(z.uuid(), req.params.id);
    const { rows: [ad] } = await pool.query('SELECT mime_type,data FROM audio_ads WHERE id=$1 AND active', [id]);
    if (!ad) fail(404, 'ad_not_found', 'Audio ad not found.');
    res.status(200);
    res.setHeader('Content-Type', ad.mime_type);
    res.setHeader('Content-Length', ad.data.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'none');
    res.end(ad.data);
  });

  api.get('/media/:id', async (req, res) => {
    const id = validate(z.uuid(), req.params.id);
    const { rows: [logo] } = await pool.query('SELECT data FROM channel_logos WHERE id=$1', [id]);
    if (!logo) fail(404, 'media_not_found', 'Media not found.');
    res.status(200);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.end(logo.data);
  });

  api.use('/auth', sensitive);
  registerAccountRoutes(api, { pool, config, auth });

  api.post('/payments', auth, async (req, res) => {
    res.status(201).json(await payments.initiate(req.user.id, req.body));
  });
  api.get('/payments/:id', auth, async (req, res) => res.json(await payments.get(req.user.id, req.params.id)));

  api.get('/channels/:id/playback', auth, async (req, res) => {
    res.json(await streams.playback(req.user, req.sessionHash, req.params.id));
  });
  api.get('/streams/:playbackId/:resourceId', auth, streams.proxy);
  api.get('/streams/:playbackId/:resourceId/:segment', auth, streams.proxy);

  api.post('/devices', auth, async (req, res) => {
    const { token } = validate(z.object({ token: z.string().min(10).max(4096) }).strict(), req.body);
    const { rows: [device] } = await pool.query(`INSERT INTO devices(token,user_id,session_hash) VALUES($1,$2,$3)
      ON CONFLICT(token) DO UPDATE SET session_hash=EXCLUDED.session_hash,updated_at=now()
      WHERE devices.user_id=EXCLUDED.user_id RETURNING token`, [token, req.user.id, req.sessionHash]);
    if (!device) fail(409, 'device_conflict', 'This device notification token is registered to another account.');
    res.status(201).json({ registered: true });
  });
  api.get('/notifications', auth, async (req, res) => {
    const { rows } = await pool.query(`SELECT n.id,n.title,n.body,n.audience,n.created_at AS "createdAt"
      FROM notification_recipients r JOIN notifications n ON n.id=r.notification_id
      WHERE r.user_id=$1 ORDER BY n.created_at DESC LIMIT 100`, [req.user.id]);
    res.json({ items: rows });
  });

  const adminRouter = express.Router();
  registerAdminRoutes(adminRouter, { pool, config, payments, adapters, notifications });
  api.post('/admin/logos', auth, adminOnly, async (req, res) => {
    const body = validate(z.object({ mimeType: z.literal('image/png'), data: z.string().min(4).max(3_000_000) }).strict(), req.body);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.data) || body.data.length % 4 !== 0) fail(400, 'invalid_image', 'A base64 PNG image is required.');
    const data = Buffer.from(body.data, 'base64');
    if (!pngDimensions(data)) fail(400, 'invalid_image', 'The file is not a supported PNG image of at most 2 MB.');
    const id = randomUUID();
    await pool.query('INSERT INTO channel_logos(id,actor_id,data) VALUES($1,$2,$3)', [id, req.user.id, data]);
    res.status(201).json({ id, url: `${config.publicBaseUrl}/v1/media/${id}` });
  });
  api.use('/admin', auth, adminOnly, adminRouter);

  app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: 'The requested endpoint does not exist.' } }));
  app.use(errorHandler);
  return app;
}

