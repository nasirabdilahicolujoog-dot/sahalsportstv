import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { HttpError } from './errors.js';

const callable = z.custom(value => typeof value === 'function');
const adapterSchema = z.object({ initiate: callable, verify: callable, refund: callable, test: callable }).strict();
const adaptersSchema = z.object({ zaad: adapterSchema.optional(), edahab: adapterSchema.optional() }).strict();
const testResultSchema = z.object({ ok: z.boolean(), message: z.string().max(500).optional() }).strict();

/**
 * Trusted local module contract: export const adapters = { zaad?, edahab? }.
 * Each adapter implements these asynchronous methods (no built-in merchant protocol):
 * - initiate({paymentId, amountMinor, currency, phone, credentials}) -> {reference, instructions?}.
 * - verify({paymentId, reference, credentials}) -> server evidence described below.
 *   reference may be null: look up the SAME merchant paymentId after an uncertain initiation;
 *   never create another invoice during verification. If lookup is unavailable, throw.
 * - refund({paymentId, reference, transactionId, amountMinor, currency, credentials}) -> refund evidence.
 * - test({credentials}) -> {ok: boolean, message?: string}; never move money.
 * credentials = {merchantId, apiUrl, apiKey, secretKey, environment}.
 *
 * All evidence is a strict object: {source:'server_api', provider:'zaad'|'edahab',
 * paymentId, reference, amountMinor:50, currency:'USD', status}.
 * verify status is 'pending', 'failed' (authoritatively terminal), or 'settled';
 * settled additionally REQUIRES transactionId and eventId. refund status is 'refunded'
 * and additionally REQUIRES transactionId (original purchase ID) and eventId (refund ID).
 * IDs must be stable, nonempty strings. Unknown fields are rejected, not silently ignored.
 *
 * Evidence must come from an authenticated server API, NEVER a browser, callback body,
 * invoice-creation success, or a locally fabricated status. A source label is not proof:
 * these modules are trusted server code responsible for fetching and authenticating evidence.
 * initiate AND refund must enforce provider-side idempotency by paymentId, separately
 * per operation, across retries/process restarts; an uncertain refund is retried with
 * identical arguments. Enforce bounded I/O, TLS and the configured endpoint; do not
 * follow redirects to arbitrary hosts or include credentials in errors/messages.
 * WAAFI purchase approval alone and eDahab invoice creation cannot establish this contract;
 * supply a merchant-approved integration including authoritative verification first.
 */
export async function loadAdapters(config) {
  if (!config.paymentAdapterModule) return Object.freeze({});
  try {
    const configured = config.paymentAdapterModule;
    if (typeof configured !== 'string') throw new Error('Invalid module path');
    // Only local files are executable integration configuration, never remote/data URLs.
    if (!isAbsolute(configured) && /^[a-z][a-z0-9+.-]*:/i.test(configured) && !configured.startsWith('file:')) {
      throw new Error('A local module is required');
    }
    const filename = configured.startsWith('file:') ? fileURLToPath(configured) : resolve(configured);
    const loaded = await import(pathToFileURL(filename).href);
    const parsed = adaptersSchema.parse(loaded.adapters);
    const adapters = {};
    for (const [provider, adapter] of Object.entries(parsed)) {
      if (!adapter) continue;
      adapters[provider] = Object.freeze({
        initiate: input => adapter.initiate(input),
        verify: input => adapter.verify(input),
        refund: input => adapter.refund(input),
        test: async input => {
          try {
            return testResultSchema.parse(await adapter.test(input));
          } catch {
            throw new HttpError(502, 'provider_test_failed', 'The provider connection test failed.');
          }
        },
      });
    }
    return Object.freeze(adapters);
  } catch {
    throw new HttpError(503, 'integration_not_configured', 'Configure a valid local payment adapter module.');
  }
}
