import crypto from 'node:crypto';

const DEFAULT_DEV_TOKEN_SECRET = 'dev-secret-change-me';
const TOKEN_SECRET = process.env.BT_TOKEN_SECRET || DEFAULT_DEV_TOKEN_SECRET;
if (process.env.NODE_ENV === 'production' && TOKEN_SECRET === DEFAULT_DEV_TOKEN_SECRET) {
  throw new Error('BT_TOKEN_SECRET must be set to a strong random value in production.');
}

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, original] = stored.split(':');
  if (!salt || !original) return false;
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  const hashBuf = Buffer.from(hash, 'hex');
  const origBuf = Buffer.from(original, 'hex');
  if (hashBuf.length !== origBuf.length) return false;
  return crypto.timingSafeEqual(hashBuf, origBuf);
}

export function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyToken(token) {
  const [data, sig] = String(token || '').split('.');
  if (!data || !sig) return null;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}
