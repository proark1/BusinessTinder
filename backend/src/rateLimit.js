// Per-key fixed-window rate limiter. Uses a shared Redis counter when REDIS_URL
// is configured (so limits hold across instances), and otherwise falls back to
// an in-memory bucket — which is correct for single-node and is also the
// fallback when Redis is briefly unreachable.

import { rateIncr } from './cluster.js';

const buckets = new Map(); // key -> { count, resetAt }

function _check(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, resetIn: windowMs };
  }
  if (b.count >= limit) return { ok: false, remaining: 0, resetIn: b.resetAt - now };
  b.count += 1;
  return { ok: true, remaining: limit - b.count, resetIn: b.resetAt - now };
}

// Prefer the shared Redis window; fall back to the in-memory bucket when it's
// unavailable (returns null).
async function check(key, limit, windowMs) {
  const shared = await rateIncr(key, windowMs);
  if (shared) {
    return { ok: shared.count <= limit, remaining: limit - shared.count, resetIn: shared.resetIn };
  }
  return _check(key, limit, windowMs);
}

function enforce(limit) {
  return (res, result, next) => {
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    if (!result.ok) {
      res.setHeader('Retry-After', String(Math.ceil(result.resetIn / 1000)));
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    return next();
  };
}

export function rateLimit({ key, limit, windowMs }) {
  const apply = enforce(limit);
  return async (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const id = `${key}:${(typeof key === 'function' ? key(req) : req.ip)}`;
    return apply(res, await check(id, limit, windowMs), next);
  };
}

export function rateLimitBy(getKey, limit, windowMs) {
  const apply = enforce(limit);
  return async (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    return apply(res, await check(`kf:${getKey(req)}`, limit, windowMs), next);
  };
}

// Periodic cleanup to keep memory bounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}, 60_000).unref?.();
