import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import { createPool, transaction, audit } from '../src/db.js';
import { nameSchema, emailSchema, phoneSchema, passwordSchema, hashPassword } from '../src/security.js';

// Prefer environment variables to keep passwords out of shell history and process listings.
const { values } = parseArgs({ options: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' }, password: { type: 'string' } } });
const parsed = z.object({ name: nameSchema, email: emailSchema, phone: phoneSchema, password: passwordSchema }).safeParse({
  name: values.name || process.env.ADMIN_NAME, email: values.email || process.env.ADMIN_EMAIL,
  phone: values.phone || process.env.ADMIN_PHONE, password: values.password || process.env.ADMIN_PASSWORD,
});
if (!parsed.success) {
  console.error('Supply name, email, phone, and password (12–128 characters) via --name/--email/--phone/--password or ADMIN_* environment variables.');
  process.exitCode = 1;
} else {
  const pool = createPool(loadConfig());
  try {
    const data = parsed.data;
    const hash = await hashPassword(data.password);
    await transaction(pool, async db => {
      const { rows: [user] } = await db.query("INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,'admin') RETURNING id", [data.name, data.email, data.phone, hash]);
      await audit(db, user.id, 'admin.created_cli', 'user', user.id);
    });
    console.log('Administrator created. Existing accounts are never silently promoted.');
  } catch (err) { console.error('Administrator creation failed:', err.code === '23505' ? 'Account already exists.' : err.code || err.name); process.exitCode = 1; }
  finally { await pool.end(); }
}
