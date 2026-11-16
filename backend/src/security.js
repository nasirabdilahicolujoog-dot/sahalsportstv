import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
const scrypt = promisify(scryptCallback);
const N = 32768, r = 8, p = 1;
export const passwordSchema = z.string().min(12).max(128).refine(v => Buffer.byteLength(v) <= 256);
export const emailSchema = z.string().trim().email().max(254).transform(v => v.toLowerCase());
export const phoneSchema = z.string().trim().regex(/^\+?[1-9][0-9]{7,14}$/).transform(v => `+${v.replace(/^\+/, '')}`);
export const nameSchema = z.string().trim().min(2).max(100);
export const uuidSchema = z.uuid();
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [algorithm, salt, expected] = (encoded || '').split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
  const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(hash, Buffer.from(expected, 'hex'));
}
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function encrypt(value, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}
export function decrypt(value, key, context) {
  const [version, iv, tag, ciphertext] = value.split('.');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64url')), cipher.final()]).toString('utf8');
}
export const publicUser = u => ({ id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role });
