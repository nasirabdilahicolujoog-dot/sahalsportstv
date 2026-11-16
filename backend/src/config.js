import { z } from 'zod';

export function loadConfig(env = process.env) {
  const source = { ...env, PUBLIC_BASE_URL: env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || 'http://127.0.0.1:8080' };
  const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url(),
    PROVIDER_ENCRYPTION_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    PUBLIC_BASE_URL: z.string().url().default('http://127.0.0.1:8080'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    SESSION_HOURS: z.coerce.number().int().min(1).max(720).default(168),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(1).default(0),
    FCM_TOPIC_PREFIX: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/).default('sahal'),
  });
  const r = schema.safeParse(source);
  if (!r.success) throw new Error(`Invalid configuration fields: ${[...new Set(r.error.issues.map(i => i.path[0]))].join(', ')}`);
  const v = r.data;
  const key = Buffer.from(v.PROVIDER_ENCRYPTION_KEY, 'base64');
  if (key.length !== 32 || key.toString('base64') !== v.PROVIDER_ENCRYPTION_KEY) throw new Error('Encryption key must contain 32 bytes');
  const origin = new URL(v.PUBLIC_BASE_URL);
  if (origin.username || origin.password || origin.search || origin.hash || !['http:', 'https:'].includes(origin.protocol) || origin.pathname !== '/') throw new Error('PUBLIC_BASE_URL must be an origin');
  if (v.NODE_ENV === 'production' && origin.protocol !== 'https:') throw new Error('HTTPS is required in production');
  function hosts(raw) {
    const values = (raw || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (values.some(h => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(h))) throw new Error('Allowlist must contain exact DNS hostnames only');
    return new Set(values);
  }
  return Object.freeze({
    env: v.NODE_ENV, databaseUrl: v.DATABASE_URL, encryptionKey: key,
    publicBaseUrl: origin.origin, host: v.HOST, port: v.PORT,
    sessionHours: v.SESSION_HOURS, trustProxyHops: v.TRUST_PROXY_HOPS,
    streamHosts: hosts(env.STREAM_ALLOWED_HOSTS), providerHosts: hosts(env.PROVIDER_ALLOWED_HOSTS),
    paymentAdapterModule: env.PAYMENT_ADAPTER_MODULE || '',
    fcmFile: env.FCM_SERVICE_ACCOUNT_FILE || '', fcmTopicPrefix: v.FCM_TOPIC_PREFIX,
  });
}
