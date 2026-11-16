export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
export function validate(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) fail(400, 'validation_error', 'Invalid request fields.');
  return result.data;
}
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err?.code === '23505') return res.status(409).json({ error: { code: 'conflict', message: 'This record already exists or an operation is in progress.' } });
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(err.type === 'entity.too.large' ? 413 : 400).json({ error: { code: 'invalid_body', message: 'A valid JSON body of at most 32 KB is required.' } });
  }
  // Never log request bodies, tokens, SQL parameters, upstream errors, or secrets.
  req.app.locals.logger.error({ event: 'request_failed', requestId: req.requestId, type: err?.name || 'Error' });
  return res.status(500).json({ error: { code: 'internal_error', message: 'The request could not be completed.' } });
}
