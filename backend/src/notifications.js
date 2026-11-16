import { readFile } from 'node:fs/promises';
import { createSign } from 'node:crypto';
import { fail } from './errors.js';
import { audit, transaction } from './db.js';

export function notificationService({ pool, config }) {
  let cachedToken, tokenExpiry = 0;
  async function authorization() {
    if (!config.fcmFile) fail(503, 'fcm_not_configured', 'Firebase Cloud Messaging is not configured.');
    const account = JSON.parse(await readFile(config.fcmFile, 'utf8'));
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(account.project_id || '') || !account.client_email || !account.private_key) fail(503, 'fcm_not_configured', 'The Firebase service account is invalid.');
    if (cachedToken && tokenExpiry > Date.now()) return { token: cachedToken, projectId: account.project_id };
    const now = Math.floor(Date.now() / 1000);
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')}`;
    const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    const result = await response.json();
    if (!response.ok || !result.access_token) fail(502, 'fcm_authentication_failed', 'Firebase did not authorize notification delivery.');
    cachedToken = result.access_token; tokenExpiry = Date.now() + 3300_000;
    return { token: cachedToken, projectId: account.project_id };
  }
  return {
    async send(actorId, { title, body, audience }) {
      const credentials = await authorization();
      const { rows: devices } = await pool.query(`SELECT d.token,d.user_id FROM devices d JOIN users u ON u.id=d.user_id
        JOIN sessions s ON s.token_hash=d.session_hash WHERE u.status='active' AND u.role='customer' AND s.expires_at>now()
        AND ($1='all' OR EXISTS(SELECT 1 FROM subscriptions sub WHERE sub.user_id=u.id AND sub.expires_at>now() AND sub.cancelled_at IS NULL)) LIMIT 5001`, [audience]);
      if (!devices.length) fail(409, 'no_devices', 'No eligible customer devices are registered for notifications.');
      if (devices.length > 5000) fail(413, 'audience_too_large', 'This audience requires a background delivery worker. No notifications were sent.');
      const { rows: [notification] } = await pool.query('INSERT INTO notifications(actor_id,title,body,audience) VALUES($1,$2,$3,$4) RETURNING *', [actorId, title, body, audience]);
      const delivered = new Set(); let failures = 0;
      for (let index = 0; index < devices.length; index += 10) {
        await Promise.all(devices.slice(index, index + 10).map(async device => {
          try {
            const response = await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`, {
              method: 'POST', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ message: { token: device.token, data: { title, body, notificationId: notification.id }, android: { priority: 'high' } } }) });
            if (response.ok) delivered.add(device.user_id); else failures++;
          } catch { failures++; }
        }));
      }
      await transaction(pool, async db => {
        for (const userId of delivered) await db.query('INSERT INTO notification_recipients(notification_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [notification.id, userId]);
        await db.query("UPDATE notifications SET status=$1,failure_code=$2 WHERE id=$3", [failures ? 'failed' : 'sent', failures ? 'partial_or_failed_delivery' : null, notification.id]);
        await audit(db, actorId, 'notification.sent', 'notification', notification.id, { audience, deliveredUsers: delivered.size, failedDevices: failures });
      });
      return { id: notification.id, status: failures ? 'partial_or_failed' : 'sent', deliveredUsers: delivered.size, failedDevices: failures };
    }
  };
}
