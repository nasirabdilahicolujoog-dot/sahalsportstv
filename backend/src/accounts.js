import { z } from 'zod';
import { transaction, audit } from './db.js';
import { fail, validate } from './errors.js';
import { hashPassword, verifyPassword, sha256, randomToken, publicUser, nameSchema, emailSchema, phoneSchema, passwordSchema } from './security.js';

export function authentication(pool) {
  return async (req, res, next) => {
    const header = req.get('authorization') || '';
    if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(header)) fail(401, 'authentication_required', 'Please sign in to continue.');
    req.sessionHash = sha256(header.slice(7));
    const { rows: [user] } = await pool.query(`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active'`, [req.sessionHash]);
    if (!user) fail(401, 'session_expired', 'Your session has expired. Please sign in again.');
    req.user = user;
    res.set('Cache-Control', 'no-store');
    next();
  };
}
export function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') fail(403, 'admin_required', 'Administrator permission is required.');
  next();
}
export const subscriptionView = row => ({ active: Boolean(row?.active), expiresAt: row?.expires_at || null });
export async function accountSnapshot(pool, user) {
  const { rows: [subscription] } = await pool.query('SELECT *,expires_at>now() AND cancelled_at IS NULL AS active FROM subscriptions WHERE user_id=$1', [user.id]);
  const { rows: [trial] } = await pool.query('SELECT *,GREATEST(0,EXTRACT(EPOCH FROM (expires_at-now()))::integer) AS remaining FROM trials WHERE user_id=$1', [user.id]);
  const { rows: [settings] } = await pool.query('SELECT * FROM app_settings');
  const { rows: payments } = await pool.query('SELECT id,provider,amount_minor,currency,status,provider_reference,created_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [user.id]);
  return { user: publicUser(user), subscription: subscriptionView(subscription),
    trial: { startedAt: trial?.started_at || null, expiresAt: trial?.expires_at || null, remainingSeconds: trial?.remaining || 0, eligible: !trial && settings.trial_enabled },
    payments: payments.map(p => ({ id: p.id, provider: p.provider, amount: p.amount_minor / 100, currency: p.currency, status: p.status, reference: p.provider_reference || p.id, createdAt: p.created_at })) };
}
export async function registerAccountRoutes(router, { pool, config, auth }) {
  const dummyHash = await hashPassword(randomToken());
  async function session(db, user) {
    const token = randomToken();
    const { rows: [record] } = await db.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+$3*interval '1 hour') RETURNING expires_at", [sha256(token), user.id, config.sessionHours]);
    return { token, user: publicUser(user), expiresAt: record.expires_at };
  }
  router.post('/auth/register', async (req, res) => {
    const body = validate(z.object({ name: nameSchema, phone: phoneSchema, email: emailSchema, password: passwordSchema }).strict(), req.body);
    const hash = await hashPassword(body.password);
    const result = await transaction(pool, async db => {
      const { rows: [user] } = await db.query('INSERT INTO users(name,phone,email,password_hash) VALUES($1,$2,$3,$4) RETURNING *', [body.name, body.phone, body.email, hash]);
      return session(db, user);
    });
    res.status(201).set('Cache-Control', 'no-store').json(result);
  });
  router.post('/auth/login', async (req, res) => {
    const body = validate(z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(128) }).strict(), req.body);
    const identifier = body.identifier.toLowerCase();
    const phone = `+${identifier.replace(/^\+/, '')}`;
    const { rows: [user] } = await pool.query('SELECT * FROM users WHERE email=$1 OR phone=$2', [identifier, phone]);
    const valid = await verifyPassword(body.password, user?.password_hash || dummyHash);
    if (!valid || !user || user.status !== 'active') fail(401, 'invalid_credentials', 'The sign-in details are incorrect or the account is unavailable.');
    const result = await transaction(pool, async db => {
      const { rows: [current] } = await db.query("SELECT * FROM users WHERE id=$1 AND status='active' AND password_hash=$2 FOR UPDATE", [user.id, user.password_hash]);
      if (!current) fail(401, 'invalid_credentials', 'Please sign in again.');
      if (current.role === 'admin') await audit(db, current.id, 'admin.login', 'user', current.id);
      return session(db, current);
    });
    res.set('Cache-Control', 'no-store').json(result);
  });
  router.post('/auth/reset-password', (req, res) => {
    validate(z.object({ email: emailSchema }).strict(), req.body);
    fail(503, 'mail_not_configured', 'Password recovery requires a configured email delivery service. Contact your service administrator.');
  });
  router.post('/auth/logout', auth, async (req, res) => {
    await transaction(pool, async db => {
      if (req.user.role === 'admin') await audit(db, req.user.id, 'admin.logout', 'user', req.user.id);
      await db.query('DELETE FROM sessions WHERE token_hash=$1', [req.sessionHash]);
    });
    res.json({ message: 'Signed out.' });
  });
  router.get('/me', auth, async (req, res) => res.json(await accountSnapshot(pool, req.user)));
  router.post('/me/password', auth, async (req, res) => {
    const body = validate(z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema }).strict(), req.body);
    if (!await verifyPassword(body.currentPassword, req.user.password_hash)) fail(400, 'invalid_password', 'Your current password is incorrect.');
    const hash = await hashPassword(body.newPassword);
    await transaction(pool, async db => {
      const result = await db.query('UPDATE users SET password_hash=$1 WHERE id=$2 AND password_hash=$3', [hash, req.user.id, req.user.password_hash]);
      if (!result.rowCount) fail(409, 'account_changed', 'The account has changed. Please sign in again.');
      await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2', [req.user.id, req.sessionHash]);
      await audit(db, req.user.id, 'account.password_changed', 'user', req.user.id);
    });
    res.json({ message: 'Password updated. Other sessions have been signed out.' });
  });
  router.post('/trial/start', auth, async (req, res) => {
    await transaction(pool, async db => {
      const { rows: [user] } = await db.query("SELECT id FROM users WHERE id=$1 AND status='active' FOR UPDATE", [req.user.id]);
      if (!user) fail(401, 'account_unavailable', 'The account is unavailable.');
      const { rows: [settings] } = await db.query('SELECT * FROM app_settings FOR SHARE');
      if (!settings.trial_enabled) fail(403, 'trials_disabled', 'Free trials are currently unavailable.');
      const { rowCount } = await db.query("INSERT INTO trials(user_id,started_at,expires_at) VALUES($1,now(),now()+$2*interval '1 minute') ON CONFLICT(user_id) DO NOTHING RETURNING user_id", [user.id, settings.trial_minutes]);
      if (!rowCount) fail(409, 'trial_already_used', 'This account has already used its free trial. Please subscribe to continue watching.');
    });
    res.status(201).json((await accountSnapshot(pool, req.user)).trial);
  });
}
