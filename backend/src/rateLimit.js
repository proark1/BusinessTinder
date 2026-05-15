// Tiny in-memory token-bucket rate limiter. Per-key sliding window.
// Good enough for a single-node deployment; swap for Redis when scaling out.

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

export function rateLimit({ key, limit, windowMs }) {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const id = `${key}:${(typeof key === 'function' ? key(req) : req.ip)}`;
    const result = _check(id, limit, windowMs);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    if (!result.ok) {
      res.setHeader('Retry-After', String(Math.ceil(result.resetIn / 1000)));
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    next();
  };
}

export function rateLimitBy(getKey, limit, windowMs) {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    const id = `kf:${getKey(req)}`;
    const result = _check(id, limit, windowMs);
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
    if (!result.ok) {
      res.setHeader('Retry-After', String(Math.ceil(result.resetIn / 1000)));
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    next();
  };
}

// Periodic cleanup to keep memory bounded
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
}, 60_000).unref?.();
