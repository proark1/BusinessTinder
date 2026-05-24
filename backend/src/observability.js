// Lightweight observability: per-request IDs, structured request logging, and
// a pluggable error-reporting sink. All optional and dependency-free — wire a
// real APM later by swapping reportError's transport.

import crypto from 'node:crypto';

const ERROR_WEBHOOK_URL = process.env.ERROR_WEBHOOK_URL || '';
const SERVICE = process.env.SERVICE_NAME || 'businesstinder';
// Stay quiet in tests, and let operators turn request logs off explicitly.
const QUIET = process.env.NODE_ENV === 'test' || process.env.LOG_REQUESTS === 'off';

export const HAS_ERROR_REPORTING = !!ERROR_WEBHOOK_URL;

// Attach a request id (honoring an upstream X-Request-Id) and echo it back so
// clients and logs can be correlated.
export function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.id = (typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 200)
    ? incoming
    : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

// One structured JSON line per completed request.
export function requestLogger(req, res, next) {
  if (QUIET) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    console.log(JSON.stringify({
      t: new Date().toISOString(),
      lvl: res.statusCode >= 500 ? 'error' : 'info',
      msg: 'request',
      id: req.id,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Math.round(ms),
    }));
  });
  next();
}

// Report an error to an external sink when ERROR_WEBHOOK_URL is configured.
// Fire-and-forget and swallow its own failures — telemetry must never break
// the request path. No-op when unconfigured.
export function reportError(err, context = {}) {
  if (!ERROR_WEBHOOK_URL) return;
  const payload = {
    service: SERVICE,
    time: new Date().toISOString(),
    message: err?.message || String(err),
    stack: err?.stack || null,
    ...context,
  };
  Promise.resolve()
    .then(() => fetch(ERROR_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }))
    .catch(() => {});
}
