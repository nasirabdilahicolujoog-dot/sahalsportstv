import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createApp } from './app.js';
import { loadAdapters } from './providers.js';

const config = loadConfig();
const pool = createPool(config);
const adapters = await loadAdapters(config);
const app = await createApp({ pool, config, adapters });

const server = app.listen(config.port, config.host, () => {
  console.log(`Sahal Sports TV API listening on ${config.host}:${config.port} (${config.env})`);
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  server.close(async () => {
    try { await pool.end(); } finally { process.exit(0); }
  });
  server.closeAllConnections();
  setTimeout(() => process.exit(1), 10_000).unref();
  console.log(`Received ${signal}; closing the API.`);
}
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
