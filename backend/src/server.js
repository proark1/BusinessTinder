import express from 'express';
import cors from 'cors';
import compression from 'compression';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { scoreProfile, rankProfiles, diversify } from './scoring.js';
import { moderateText, moderateImage } from './moderation.js';
import { suggestIcebreakers } from './icebreakers.js';
import { rateLimit } from './rateLimit.js';
import { PROMPTS, normalizePrompts, mutualHighlights } from './prompts.js';
import { sendVerifyEmail, sendResetEmail, sendMatchEmail, sendMessageDigestEmail, sendCompanyVerifyEmail, HAS_EMAIL } from './email.js';
import { geocode, distanceKm, normalizeLocation } from './geocode.js';
import { uploadDataUrl, HAS_CLOUD_UPLOAD } from './upload.js';
import { isDisposableEmail } from './disposable.js';
import { FAKE_USERS, FAKE_PASSWORD } from './fakes.js';
import { todayKey, slugify, randomCode, effectivePlanTier, escapeHtml, isBanned, validatePassword, emailDomain, isFreeEmailDomain } from './helpers.js';
import { loginLockState, recordLoginFailure, clearLoginFailures } from './loginGuard.js';
import { requestId, requestLogger, reportError, HAS_ERROR_REPORTING } from './observability.js';
import { generateSecret, verifyTotp, otpauthUrl, generateRecoveryCodes, hashRecoveryCode } from './totp.js';
import { initCluster, clusterEnabled, publishDelivery, presenceAdd, presenceRemove, isOnlineAnywhere } from './cluster.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.resolve(__dirname, '..', '..');

let PrismaClient = null;
try {
  ({ PrismaClient } = await import('@prisma/client'));
} catch {
  // @prisma/client is optional; backend falls back to in-memory storage when missing.
}

const app = express();
app.set('trust proxy', 1); // honor X-Forwarded-For for rate limiting behind a proxy

// Per-request id + structured request logging, before anything else so every
// response (including errors) carries an X-Request-Id.
app.use(requestId);
app.use(requestLogger);

// gzip JSON responses + static assets. The big wins are /discover and /search
// payloads and the unminified script.js / styles.css.
app.use(compression());

// CORS: comma-separated allow-list via ALLOWED_ORIGINS. In production an empty
// list locks the API down; in dev/test we keep the old wide-open behavior so
// the static frontend + tests work without extra config.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (allowedOrigins.length > 0) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl / server-to-server
      cb(null, allowedOrigins.includes(origin));
    },
    credentials: true,
  }));
} else if (process.env.NODE_ENV === 'production') {
  console.error('[startup] ALLOWED_ORIGINS is empty in production — refusing all cross-origin requests.');
  app.use(cors({ origin: false }));
} else {
  app.use(cors());
}

app.use(express.json({ limit: '4mb' })); // big enough for a small photo dataURL

// Express 4 doesn't forward async-handler rejections to error middleware.
// Wrap every route + middleware registration so a thrown / rejected promise
// becomes next(err) instead of a hung request → mystery 404 from upstream
// proxies. Recurses into handler arrays (Express supports those) and skips
// 4-arg error middlewares so they keep their (err, req, res, next) signature.
const wrapHandler = (h) => {
  if (Array.isArray(h)) return h.map(wrapHandler);
  if (typeof h === 'function' && h.length <= 3) {
    return (req, res, next) => Promise.resolve(h(req, res, next)).catch(next);
  }
  return h;
};
for (const verb of ['get', 'post', 'put', 'delete', 'patch', 'use', 'all']) {
  const orig = app[verb].bind(app);
  app[verb] = (...args) => orig(...args.map(wrapHandler));
}

const limits = {
  authStrict: rateLimit({ key: 'auth-strict', limit: 8, windowMs: 60_000 }),       // login/register/forgot/reset/google
  swipe: rateLimit({ key: 'swipe', limit: 60, windowMs: 60_000 }),
  message: rateLimit({ key: 'msg', limit: 90, windowMs: 60_000 }),
  general: rateLimit({ key: 'gen', limit: 240, windowMs: 60_000 }),
};

const DEFAULT_DEV_JWT_SECRET = 'dev-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || DEFAULT_DEV_JWT_SECRET;
if (process.env.NODE_ENV === 'production' && JWT_SECRET === DEFAULT_DEV_JWT_SECRET) {
  throw new Error('JWT_SECRET must be set to a strong random value in production.');
}
const DATABASE_URL = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@businesstinder.app';
const FREE_DAILY_SWIPES = Number(process.env.FREE_DAILY_SWIPES || 30);
const FREE_DAILY_LIKE_REVEALS = Number(process.env.FREE_DAILY_LIKE_REVEALS || 1);
// Max number of signups a single inviter earns referral rewards for (anti-farming).
const REFERRAL_REWARD_CAP = Number(process.env.REFERRAL_REWARD_CAP || 25);
// A throwaway bcrypt hash compared against when an email is unknown, so login
// timing doesn't reveal whether an account exists.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync('bt-timing-equalizer', 10);
// Cap the discover pool so we never fetch/score/serialize the entire profile
// table in one request. Most-recently-active candidates win the slots.
const DISCOVER_LIMIT = Number(process.env.DISCOVER_LIMIT || 200);
// Cap search results returned to the client.
const SEARCH_LIMIT = Number(process.env.SEARCH_LIMIT || 50);
// Read ADMIN_EMAILS live (memoized on the raw string) so admin access can be
// changed without a restart, and so tests can set it before exercising the
// admin routes regardless of module-load order.
let _adminCache = { raw: null, set: new Set() };
function isAdminEmail(email) {
  const raw = process.env.ADMIN_EMAILS || '';
  if (raw !== _adminCache.raw) {
    _adminCache = { raw, set: new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) };
  }
  return _adminCache.set.has(String(email || '').toLowerCase());
}
const APP_URL = process.env.APP_URL || '';
const NODE_ENV = process.env.NODE_ENV || 'development';

const prisma = DATABASE_URL && PrismaClient
  ? new PrismaClient({ datasources: { db: { url: DATABASE_URL } } })
  : null;

if (!prisma) {
  if (NODE_ENV === 'production') {
    console.error('[FATAL] DATABASE_URL is required in production. Refusing to start with in-memory storage.');
    process.exit(1);
  }
  console.warn('[warn] No DATABASE_URL set — using in-memory storage. Data will not persist.');
}

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
if (!googleClient) console.warn('[warn] GOOGLE_CLIENT_ID not set — Google login disabled.');

if (HAS_EMAIL) console.log('[info] Email delivery configured (Resend).');
else console.warn('[warn] RESEND_API_KEY not set — emails will be logged to console.');

if (HAS_CLOUD_UPLOAD) console.log('[info] Cloud image upload configured (Cloudinary).');
else console.warn('[warn] CLOUDINARY_URL not set — uploads fall back to inline base64.');

let webpush = null;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush = (await import('web-push')).default;
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log('[info] Web push configured.');
  } catch {
    console.warn('[warn] VAPID keys set but `web-push` not installed; run `npm i web-push`.');
  }
} else {
  console.warn('[warn] VAPID keys not set — push notifications disabled.');
}

const mem = {
  users: [],
  profiles: [],
  swipes: [],
  matches: [],
  conversations: [],
  messages: [],
  saved: [],
  reports: [],
  blocks: [],
  pushSubs: [],
  profileViews: [],
};
const wsClients = new Map(); // userId -> Set<WebSocket>

// In-memory throttle for "you have a new message" digest emails. Key is
// `${recipientId}:${conversationId}`, value is the timestamp of the last
// email. We only email once per hour per thread so users don't get
// hammered when a conversation is active but they happen to be offline.
// A periodic sweep keeps the map from growing unbounded over time.
const MSG_EMAIL_THROTTLE_MS = 60 * 60_000;
const lastMessageEmail = new Map();
function shouldEmailMessage(recipientId, conversationId) {
  const key = `${recipientId}:${conversationId}`;
  const last = lastMessageEmail.get(key) || 0;
  if (Date.now() - last < MSG_EMAIL_THROTTLE_MS) return false;
  lastMessageEmail.set(key, Date.now());
  return true;
}
// Drop expired entries every 10 minutes — entries older than the throttle
// window are no longer affecting any decision so they can safely go.
setInterval(() => {
  const cutoff = Date.now() - MSG_EMAIL_THROTTLE_MS;
  for (const [k, t] of lastMessageEmail) if (t < cutoff) lastMessageEmail.delete(k);
}, 10 * 60_000).unref?.();

const BOOST_DURATION_MS = 30 * 60_000;
function isBoostActive(user) {
  return !!(user?.boostUntil && new Date(user.boostUntil).getTime() > Date.now());
}

function addWsClient(userId, ws) {
  if (!wsClients.has(userId)) wsClients.set(userId, new Set());
  wsClients.get(userId).add(ws);
}
// Returns true when that was the user's last local socket (so callers can
// clear cross-instance presence).
function removeWsClient(userId, ws) {
  const set = wsClients.get(userId);
  if (!set) return false;
  set.delete(ws);
  if (set.size === 0) { wsClients.delete(userId); return true; }
  return false;
}
// Deliver only to sockets connected to THIS instance.
function localSendToUser(userId, payload) {
  const set = wsClients.get(userId);
  if (!set || set.size === 0) return false;
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const ws of set) {
    try { ws.send(json); } catch {}
  }
  return true;
}
// Deliver locally and, when clustered, fan out to the other instances. Returns
// whether the message was delivered to a local socket.
function sendToUser(userId, payload) {
  const local = localSendToUser(userId, payload);
  if (clusterEnabled()) publishDelivery(userId, payload);
  return local;
}
// Is this user connected to any instance (local or, when clustered, remote)?
async function isUserConnected(userId) {
  if (wsClients.has(userId)) return true;
  if (clusterEnabled()) return isOnlineAnywhere(userId);
  return false;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl || null,
    planTier: effectivePlanTier(user),
    planExpiresAt: user.planExpiresAt || null,
    referralCode: user.referralCode || null,
    emailVerified: !!user.emailVerified,
    verified: !!user.verified,
    emailOptOut: !!user.notifEmailOptOut,
    companyVerified: !!user.companyVerifiedAt,
    companyDomain: user.companyDomain || null,
    twoFactorEnabled: !!user.totpEnabled,
    isAdmin: isAdminEmail(user.email),
  };
}

function sign(user, extra = {}) {
  return jwt.sign({ userId: user.id, email: user.email, ...extra }, JWT_SECRET, { expiresIn: '7d' });
}

// One-click email unsubscribe link token. A dedicated HMAC (not a JWT) so the
// link can't be replayed as an auth token. Deterministic so we don't need to
// persist it.
function unsubToken(userId) {
  return crypto.createHmac('sha256', JWT_SECRET).update(`unsub:${userId}`).digest('base64url');
}
function unsubscribePath(userId) {
  return `/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;
}
function verifyUnsubToken(userId, token) {
  const expected = unsubToken(userId);
  const a = Buffer.from(String(token || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Whether transactional "activity" emails (match / message digest) should go to
// this recipient. Verification + password-reset emails always send regardless.
function wantsActivityEmail(user) {
  return !!user && !user.notifEmailOptOut;
}

function banMessage(user) {
  const until = user?.bannedUntil ? ` until ${new Date(user.bannedUntil).toISOString().slice(0, 10)}` : '';
  const reason = user?.banReason ? ` Reason: ${user.banReason}` : '';
  return `Your account has been suspended${until}.${reason}`;
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Step-up tokens (e.g. the pre-2FA `mfaToken`) are signed with the same
    // secret but carry a `purpose`. They must NOT be accepted as a full
    // session token, or 2FA could be bypassed by skipping /auth/2fa.
    if (payload.purpose) return res.status(401).json({ error: 'Unauthorized' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

async function findUserByEmail(email) {
  if (prisma) return prisma.user.findUnique({ where: { email } });
  return mem.users.find((u) => u.email === email) || null;
}
async function findUserById(id) {
  if (prisma) return prisma.user.findUnique({ where: { id } });
  return mem.users.find((u) => u.id === id) || null;
}
async function findProfileByUserId(userId) {
  if (prisma) return prisma.profile.findUnique({ where: { userId } });
  return mem.profiles.find((p) => p.userId === userId) || null;
}
async function findProfileBySlug(slug) {
  if (prisma) return prisma.profile.findUnique({ where: { slug } });
  return mem.profiles.find((p) => p.slug === slug) || null;
}
async function ensureReferralCode(user) {
  if (user.referralCode) return user;
  const code = randomCode(8);
  if (prisma) return prisma.user.update({ where: { id: user.id }, data: { referralCode: code } });
  user.referralCode = code;
  return user;
}
async function uniqueSlug(base) {
  let slug = base || `user-${randomCode(4)}`;
  for (let i = 0; i < 6; i += 1) {
    const existing = await findProfileBySlug(slug);
    if (!existing) return slug;
    slug = `${base}-${randomCode(3)}`;
  }
  return `${base}-${randomCode(6)}`;
}

async function isBlocked(aId, bId) {
  if (prisma) {
    const b = await prisma.block.findFirst({
      where: { OR: [{ blockerId: aId, targetId: bId }, { blockerId: bId, targetId: aId }] },
    });
    return !!b;
  }
  return mem.blocks.some(
    (x) => (x.blockerId === aId && x.targetId === bId) || (x.blockerId === bId && x.targetId === aId),
  );
}

async function canAccessConversation(userId, conversationId) {
  if (prisma) {
    const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!convo) return false;
    const m = await prisma.match.findUnique({ where: { id: convo.matchId } });
    return !!m && (m.userAId === userId || m.userBId === userId);
  }
  const convo = mem.conversations.find((c) => c.id === conversationId);
  if (!convo) return false;
  const m = mem.matches.find((x) => x.id === convo.matchId);
  return !!m && (m.userAId === userId || m.userBId === userId);
}

async function otherUserInConversation(userId, conversationId) {
  let convo, match;
  if (prisma) {
    convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
    if (!convo) return null;
    match = await prisma.match.findUnique({ where: { id: convo.matchId } });
  } else {
    convo = mem.conversations.find((c) => c.id === conversationId);
    if (!convo) return null;
    match = mem.matches.find((m) => m.id === convo.matchId);
  }
  if (!match) return null;
  return match.userAId === userId ? match.userBId : match.userAId;
}

async function pushToUser(userId, payload) {
  if (!webpush) return;
  let subs;
  if (prisma) subs = await prisma.pushSubscription.findMany({ where: { userId } });
  else subs = mem.pushSubs.filter((s) => s.userId === userId);
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(payload),
        );
      } catch (err) {
        if (err?.statusCode === 410 || err?.statusCode === 404) {
          if (prisma) await prisma.pushSubscription.delete({ where: { endpoint: sub.endpoint } });
          else mem.pushSubs = mem.pushSubs.filter((s) => s.endpoint !== sub.endpoint);
        }
      }
    }),
  );
}

// ---------- routes ----------

app.get('/health', async (_req, res) => {
  let dbOk = !prisma;
  if (prisma) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
  }
  res.json({
    ok: dbOk,
    mode: prisma ? 'postgres' : 'memory',
    googleLogin: !!googleClient,
    pushEnabled: !!webpush,
  });
});


app.get('/ops/readiness', async (_req, res) => {
  let dbOk = !prisma;
  if (prisma) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      dbOk = true;
    } catch {
      dbOk = false;
    }
  }

  const checks = [
    { key: 'database', ok: dbOk, required: true, detail: prisma ? 'Postgres reachable' : 'Running in in-memory mode (dev only)' },
    { key: 'jwtSecret', ok: JWT_SECRET !== 'dev-secret-change-me', required: true, detail: JWT_SECRET !== 'dev-secret-change-me' ? 'Custom JWT secret configured' : 'Using default dev JWT secret' },
    { key: 'googleAuth', ok: !!googleClient, required: false, detail: !!googleClient ? 'Google Sign-In configured' : 'GOOGLE_CLIENT_ID missing' },
    { key: 'emailDelivery', ok: !!HAS_EMAIL, required: false, detail: !!HAS_EMAIL ? 'Resend email delivery configured' : 'RESEND_API_KEY missing (dev console email mode)' },
    { key: 'cloudUpload', ok: !!HAS_CLOUD_UPLOAD, required: false, detail: !!HAS_CLOUD_UPLOAD ? 'Cloudinary upload configured' : 'CLOUDINARY_URL missing (base64 fallback mode)' },
    { key: 'pushNotifications', ok: !!webpush, required: false, detail: !!webpush ? 'Web push configured' : 'VAPID/web-push missing' },
    { key: 'errorReporting', ok: HAS_ERROR_REPORTING, required: false, detail: HAS_ERROR_REPORTING ? 'Error webhook configured' : 'ERROR_WEBHOOK_URL missing (errors logged only)' },
    { key: 'multiNode', ok: clusterEnabled(), required: false, detail: clusterEnabled() ? 'Redis pub/sub active — WebSocket scales across instances' : 'Single-node WebSocket (set REDIS_URL to scale out)' },
  ];

  const criticalChecks = checks.filter((c) => c.required);
  const criticalOk = criticalChecks.every((c) => c.ok);
  const optionalOk = checks.filter((c) => !c.required).every((c) => c.ok);

  res.json({
    ok: criticalOk,
    mode: prisma ? 'postgres' : 'memory',
    timestamp: new Date().toISOString(),
    summary: {
      criticalOk,
      optionalOk,
      total: checks.length,
      passing: checks.filter((c) => c.ok).length,
    },
    checks,
  });
});

app.get('/auth/config', (_req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    vapidPublicKey: VAPID_PUBLIC || null,
    freeDailySwipes: FREE_DAILY_SWIPES,
    freeDailyLikeReveals: FREE_DAILY_LIKE_REVEALS,
    hasCloudUpload: HAS_CLOUD_UPLOAD,
  });
});

async function applyReferralPayout(newUser, code) {
  if (!code) return newUser;
  // A new account can only be attributed to a referrer once.
  if (newUser.referredBy) return newUser;
  let inviter;
  if (prisma) inviter = await prisma.user.findUnique({ where: { referralCode: code } });
  else inviter = mem.users.find((u) => u.referralCode === code);
  if (!inviter || inviter.id === newUser.id) return newUser;

  // Anti-farming: an inviter only earns referral rewards for their first
  // REFERRAL_REWARD_CAP signups. Beyond that we still welcome the new user with
  // their bonus, but stop extending the inviter's PRO so a single account can't
  // mint unlimited PRO by registering throwaway referrals.
  let referredCount;
  if (prisma) referredCount = await prisma.user.count({ where: { referredBy: inviter.id } });
  else referredCount = mem.users.filter((u) => u.referredBy === inviter.id).length;
  const rewardInviter = referredCount < REFERRAL_REWARD_CAP;

  // Extend (don't shorten) any existing PRO window.
  const newCurrent = newUser.planExpiresAt ? new Date(newUser.planExpiresAt).getTime() : 0;
  const newReward = new Date(Math.max(newCurrent, Date.now()) + 30 * 86400_000);
  if (rewardInviter) {
    const inviterCurrent = inviter.planExpiresAt ? new Date(inviter.planExpiresAt).getTime() : 0;
    const inviterReward = new Date(Math.max(inviterCurrent, Date.now()) + 30 * 86400_000);
    if (prisma) await prisma.user.update({ where: { id: inviter.id }, data: { planTier: 'PRO', planExpiresAt: inviterReward } });
    else { inviter.planTier = 'PRO'; inviter.planExpiresAt = inviterReward.toISOString(); }
  }
  if (prisma) {
    return prisma.user.update({
      where: { id: newUser.id },
      data: { planTier: 'PRO', planExpiresAt: newReward, referredBy: inviter.id },
    });
  }
  newUser.planTier = 'PRO'; newUser.planExpiresAt = newReward.toISOString();
  newUser.referredBy = inviter.id;
  return newUser;
}

app.post('/auth/register', limits.authStrict, async (req, res) => {
  const { email, password, fullName, referredBy } = req.body || {};
  if (!email || !password || !fullName) return res.status(400).json({ error: 'Missing fields' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ error: 'Invalid email address' });
  if (isDisposableEmail(email)) return res.status(400).json({ error: 'Please use a real work or personal email — disposable domains are not allowed.' });
  const pw = validatePassword(password);
  if (!pw.ok) return res.status(400).json({ error: pw.reason });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const passwordHash = await bcrypt.hash(password, 10);
  const referralCode = randomCode(8);
  const verificationToken = randomCode(24);
  let user;
  if (prisma) {
    user = await prisma.user.create({ data: { email, passwordHash, fullName, referralCode, verificationToken } });
  } else {
    user = {
      id: crypto.randomUUID(), email, passwordHash, fullName, avatarUrl: null,
      planTier: 'FREE', referralCode, referredBy: null,
      swipesToday: 0, lastSwipeDay: null,
      emailVerified: false, verificationToken,
      verified: false,
      lastLikeRevealDay: null, likeRevealsToday: 0, revealedLikerIds: [],
    };
    mem.users.push(user);
  }
  user = await applyReferralPayout(user, referredBy);
  const verifyPath = `/auth/verify?token=${verificationToken}`;
  // Fire-and-forget — never block signup on email delivery.
  sendVerifyEmail(user.email, user.fullName, verifyPath).catch((err) => console.warn('[email] verify', err?.message));
  // Surface the dev-mode link to the client (omitted in prod when email is wired).
  const verifyUrl = NODE_ENV === 'production' && HAS_EMAIL ? undefined : verifyPath;
  res.json({ token: sign(user), user: publicUser(user), verifyUrl });
});

const LOCKOUT_MSG = 'Too many failed login attempts. Please wait a few minutes and try again.';
app.post('/auth/login', limits.authStrict, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const lock = loginLockState(email);
  if (lock.locked) return res.status(429).json({ error: LOCKOUT_MSG, retryAfterMs: lock.retryAfterMs });
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) {
    await bcrypt.compare(String(password), DUMMY_PASSWORD_HASH); // equalize timing vs. the real path
    const r = recordLoginFailure(email);
    return res.status(r.locked ? 429 : 401).json(r.locked ? { error: LOCKOUT_MSG, retryAfterMs: r.retryAfterMs } : { error: 'Invalid credentials' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    const r = recordLoginFailure(email);
    return res.status(r.locked ? 429 : 401).json(r.locked ? { error: LOCKOUT_MSG, retryAfterMs: r.retryAfterMs } : { error: 'Invalid credentials' });
  }
  if (isBanned(user)) return res.status(403).json({ error: banMessage(user) });
  clearLoginFailures(email);
  // 2FA step-up: password was correct, but a second factor is required before
  // we hand out a full session token.
  if (user.totpEnabled) {
    const mfaToken = jwt.sign({ userId: user.id, purpose: 'mfa' }, JWT_SECRET, { expiresIn: '5m' });
    return res.json({ mfaRequired: true, mfaToken });
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

// Second step of a 2FA login: exchange the short-lived mfaToken + a TOTP code
// (or a one-time recovery code) for a real session token.
app.post('/auth/2fa', limits.authStrict, async (req, res) => {
  const { mfaToken, code } = req.body || {};
  let payload;
  try {
    payload = jwt.verify(String(mfaToken || ''), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Your verification step expired — sign in again.' });
  }
  if (payload.purpose !== 'mfa') return res.status(401).json({ error: 'Invalid token' });
  const user = await findUserById(payload.userId);
  if (!user || !user.totpEnabled) return res.status(400).json({ error: '2FA is not enabled for this account.' });
  if (isBanned(user)) return res.status(403).json({ error: banMessage(user) });

  const entered = String(code || '').trim();
  if (verifyTotp(user.totpSecret, entered)) {
    return res.json({ token: sign(user), user: publicUser(user) });
  }
  // Fall back to a one-time recovery code.
  const hash = hashRecoveryCode(entered);
  const codes = user.recoveryCodes || [];
  if (codes.includes(hash)) {
    const remaining = codes.filter((c) => c !== hash);
    if (prisma) await prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: remaining } });
    else user.recoveryCodes = remaining;
    return res.json({ token: sign(user), user: publicUser(user), recoveryCodeUsed: true });
  }
  return res.status(401).json({ error: 'Invalid code.' });
});

app.post('/auth/google', limits.authStrict, async (req, res) => {
  if (!googleClient) return res.status(503).json({ error: 'Google login not configured' });
  const { credential, referredBy } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing credential' });
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'Invalid Google credential' });
  }
  if (!payload?.email_verified) return res.status(401).json({ error: 'Google account email not verified' });
  const email = payload.email;
  const fullName = payload.name || email.split('@')[0];
  const googleSub = payload.sub;
  const avatarUrl = payload.picture || null;

  let user;
  if (prisma) {
    user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await prisma.user.create({
        data: { email, fullName, googleSub, avatarUrl, passwordHash: '', referralCode: randomCode(8), referredBy: referredBy || null },
      });
    } else if (!user.googleSub) {
      user = await prisma.user.update({
        where: { id: user.id },
        data: { googleSub, avatarUrl: user.avatarUrl || avatarUrl, fullName: user.fullName || fullName },
      });
    }
  } else {
    user = mem.users.find((u) => u.email === email);
    if (!user) {
      user = {
        id: crypto.randomUUID(), email, fullName, googleSub, avatarUrl,
        passwordHash: '', planTier: 'FREE', referralCode: randomCode(8),
        referredBy: referredBy || null, swipesToday: 0, lastSwipeDay: null,
      };
      mem.users.push(user);
    } else {
      user.googleSub = user.googleSub || googleSub;
      user.avatarUrl = user.avatarUrl || avatarUrl;
    }
  }
  if (isBanned(user)) return res.status(403).json({ error: banMessage(user) });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/auth/verify', limits.authStrict, async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');
  let user;
  if (prisma) {
    user = await prisma.user.findUnique({ where: { verificationToken: String(token) } });
    if (!user) return res.status(404).send('Invalid or expired token');
    await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true, verificationToken: null } });
  } else {
    user = mem.users.find((u) => u.verificationToken === token);
    if (!user) return res.status(404).send('Invalid or expired token');
    user.emailVerified = true;
    user.verificationToken = null;
  }
  // Browser-friendly redirect back to the app.
  res.redirect('/?verified=1');
});

app.post('/auth/forgot', limits.authStrict, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const user = await findUserByEmail(email);
  // Always respond OK so we don't leak which emails exist.
  if (!user) return res.json({ ok: true });
  const token = randomCode(32);
  const expiresAt = new Date(Date.now() + 60 * 60_000); // 1h
  if (prisma) {
    await prisma.user.update({ where: { id: user.id }, data: { resetToken: token, resetTokenExpiresAt: expiresAt } });
  } else {
    user.resetToken = token;
    user.resetTokenExpiresAt = expiresAt.toISOString();
  }
  const resetPath = `/?reset=${token}`;
  sendResetEmail(user.email, user.fullName, resetPath).catch((err) => console.warn('[email] reset', err?.message));
  const resetUrl = NODE_ENV === 'production' && HAS_EMAIL ? undefined : resetPath;
  res.json({ ok: true, resetUrl });
});

// Resend the verification email on demand.
app.post('/auth/resend-verify', auth, limits.authStrict, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!me) return res.status(404).json({ error: 'User not found' });
  if (me.emailVerified) return res.json({ ok: true, alreadyVerified: true });
  const token = me.verificationToken || randomCode(24);
  if (prisma) await prisma.user.update({ where: { id: me.id }, data: { verificationToken: token } });
  else me.verificationToken = token;
  const verifyPath = `/auth/verify?token=${token}`;
  sendVerifyEmail(me.email, me.fullName, verifyPath).catch(() => {});
  const verifyUrl = NODE_ENV === 'production' && HAS_EMAIL ? undefined : verifyPath;
  res.json({ ok: true, verifyUrl });
});

app.post('/auth/reset', limits.authStrict, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  const pwReset = validatePassword(password);
  if (!pwReset.ok) return res.status(400).json({ error: pwReset.reason });
  let user;
  if (prisma) user = await prisma.user.findUnique({ where: { resetToken: token } });
  else user = mem.users.find((u) => u.resetToken === token);
  if (!user) return res.status(404).json({ error: 'Invalid or expired token' });
  const exp = user.resetTokenExpiresAt ? new Date(user.resetTokenExpiresAt).getTime() : 0;
  if (exp < Date.now()) return res.status(400).json({ error: 'Token expired' });
  const passwordHash = await bcrypt.hash(password, 10);
  if (prisma) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash, resetToken: null, resetTokenExpiresAt: null },
    });
  } else {
    user.passwordHash = passwordHash;
    user.resetToken = null;
    user.resetTokenExpiresAt = null;
  }
  res.json({ ok: true, token: sign(user) });
});

app.get('/me', auth, async (req, res) => {
  const user = await findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await ensureReferralCode(user);
  const profile = await findProfileByUserId(user.id);
  // Heartbeat: bump lastActiveAt on every /me hit (cheapest place that fires
  // on app open + every tab focus refresh).
  if (profile) {
    const now = new Date();
    const last = profile.lastActiveAt ? new Date(profile.lastActiveAt).getTime() : 0;
    if (now.getTime() - last > 60_000) {
      if (prisma) await prisma.profile.update({ where: { userId: user.id }, data: { lastActiveAt: now } });
      else profile.lastActiveAt = now.toISOString();
    }
  }
  res.json({ user: publicUser(updated), profile: profile || null });
});

// GDPR-style data export: everything we hold for the signed-in user, as a
// downloadable JSON file. Read-only; secrets (hashes/tokens) are never included.
app.get('/me/export', auth, async (req, res) => {
  const me = req.user.userId;
  const user = await findUserById(me);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const profile = await findProfileByUserId(me);

  let swipes, matches, saved, blocks, reports, messages, conversations;
  if (prisma) {
    [swipes, matches, saved, blocks, reports] = await Promise.all([
      prisma.swipe.findMany({ where: { fromUserId: me }, orderBy: { createdAt: 'desc' } }),
      prisma.match.findMany({ where: { OR: [{ userAId: me }, { userBId: me }] }, orderBy: { createdAt: 'desc' } }),
      prisma.savedProfile.findMany({ where: { userId: me } }),
      prisma.block.findMany({ where: { blockerId: me } }),
      prisma.report.findMany({ where: { reporterId: me } }),
    ]);
    conversations = await prisma.conversation.findMany({ where: { matchId: { in: matches.map((m) => m.id) } } });
    const convIds = conversations.map((c) => c.id);
    messages = convIds.length
      ? await prisma.message.findMany({ where: { conversationId: { in: convIds } }, orderBy: { createdAt: 'asc' } })
      : [];
  } else {
    swipes = mem.swipes.filter((s) => s.fromUserId === me);
    matches = mem.matches.filter((m) => m.userAId === me || m.userBId === me);
    const matchIds = new Set(matches.map((m) => m.id));
    conversations = mem.conversations.filter((c) => matchIds.has(c.matchId));
    const convIds = new Set(conversations.map((c) => c.id));
    messages = mem.messages.filter((m) => convIds.has(m.conversationId));
    saved = mem.saved.filter((s) => s.userId === me);
    blocks = mem.blocks.filter((b) => b.blockerId === me);
    reports = mem.reports.filter((r) => r.reporterId === me);
  }

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="businesstinder-export.json"');
  res.send(JSON.stringify({
    exportedAt: new Date().toISOString(),
    account: publicUser(user),
    profile: profile || null,
    swipes,
    matches,
    conversations,
    messages,
    saved,
    blocks,
    reports,
  }, null, 2));
});

app.get('/prompts', (_req, res) => res.json({ prompts: PROMPTS }));

const PROFILE_FIELDS = [
  'headline', 'userType', 'lookingFor', 'bio', 'stage', 'industries', 'skills',
  'location', 'remoteOk', 'commitment', 'linkedinUrl', 'avatarUrl', 'photoUrl',
  'photos', 'pastCompanies', 'hoursPerWeek', 'calLink', 'pitchDeckUrl',
  'promptIds', 'promptAnswers',
];
function sanitizeProfile(body) {
  const out = {};
  for (const k of PROFILE_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  if (Array.isArray(out.lookingFor)) out.lookingFor = out.lookingFor.slice(0, 5);
  if (Array.isArray(out.industries)) out.industries = out.industries.slice(0, 6);
  if (Array.isArray(out.skills)) out.skills = out.skills.slice(0, 8);
  if (Array.isArray(out.pastCompanies)) out.pastCompanies = out.pastCompanies.slice(0, 6);
  if (Array.isArray(out.photos)) {
    out.photos = out.photos.filter(Boolean).slice(0, 5);
    for (const p of out.photos) {
      // moderateImage trusts https URLs and verifies data-URL bytes match their
      // declared type (rejecting SVG, mislabeled, or non-image payloads).
      const mod = moderateImage(p);
      if (!mod.ok) return { error: `Photo rejected: ${mod.reason}` };
    }
  }
  // photoUrl/avatarUrl can be set directly (not just derived from photos[]), so
  // run them through the same image gate to keep non-image/unsafe URLs out.
  for (const field of ['photoUrl', 'avatarUrl']) {
    if (typeof out[field] === 'string' && out[field]) {
      const mod = moderateImage(out[field]);
      if (!mod.ok) return { error: `${field} rejected: ${mod.reason}` };
    }
  }
  if (Array.isArray(out.photos) && out.photos.length && !out.photoUrl) out.photoUrl = out.photos[0];
  if (out.hoursPerWeek != null) out.hoursPerWeek = Math.max(0, Math.min(80, Number(out.hoursPerWeek) || 0));
  for (const field of ['headline', 'bio']) {
    if (typeof out[field] === 'string') {
      const mod = moderateText(out[field]);
      if (!mod.ok) return { error: `${field} rejected: ${mod.reason}` };
    }
  }
  // Prompts: accept either {promptIds, promptAnswers} or {prompts: [...]} forms.
  if (out.promptIds !== undefined || out.promptAnswers !== undefined || body.prompts !== undefined) {
    const norm = normalizePrompts({
      promptIds: out.promptIds, promptAnswers: out.promptAnswers, prompts: body.prompts,
    });
    for (const a of norm.promptAnswers) {
      const mod = moderateText(a);
      if (!mod.ok) return { error: `Prompt answer rejected: ${mod.reason}` };
    }
    out.promptIds = norm.promptIds;
    out.promptAnswers = norm.promptAnswers;
  }
  return out;
}

async function profileWithGeo(existing, data) {
  // Only re-geocode when the location text actually changed.
  if (data.location && (!existing || normalizeLocation(existing.location) !== normalizeLocation(data.location))) {
    const point = await geocode(data.location);
    if (point) {
      data.latitude = point.lat;
      data.longitude = point.lng;
    } else {
      // Unknown city — keep stale coords out so distance filters don't match the wrong place.
      data.latitude = null;
      data.longitude = null;
    }
  }
  return data;
}

// Create or fully replace the current user's profile. Used by the onboarding
// wizard as well as the "Save changes" button in edit mode.
app.post('/profiles', auth, async (req, res) => {
  const result = sanitizeProfile(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  let data = result;
  if (!data.userType) return res.status(400).json({ error: 'userType is required' });
  if (!data.headline) return res.status(400).json({ error: 'headline is required' });
  const user = await findUserById(req.user.userId);
  const existing = await findProfileByUserId(req.user.userId);
  const slug = existing?.slug || (await uniqueSlug(slugify(user.fullName)));
  data = await profileWithGeo(existing, data);

  if (prisma) {
    const profile = await prisma.profile.upsert({
      where: { userId: req.user.userId },
      update: { ...data, lastActiveAt: new Date() },
      create: { userId: req.user.userId, slug, ...data, lastActiveAt: new Date() },
    });
    return res.json(profile);
  }
  if (existing) {
    Object.assign(existing, data, { lastActiveAt: new Date().toISOString() });
    return res.json(existing);
  }
  const profile = {
    id: crypto.randomUUID(), userId: req.user.userId, slug,
    latitude: null, longitude: null,
    ...data, lastActiveAt: new Date().toISOString(),
  };
  mem.profiles.push(profile);
  res.json(profile);
});

// Quick partial edit (headline/bio/prompts/photos/etc) — does not force the
// user back through the onboarding wizard.
app.patch('/profiles', auth, async (req, res) => {
  const existing = await findProfileByUserId(req.user.userId);
  if (!existing) return res.status(404).json({ error: 'Profile not found — complete onboarding first.' });
  const result = sanitizeProfile(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  const data = await profileWithGeo(existing, result);
  if (prisma) {
    const updated = await prisma.profile.update({
      where: { userId: req.user.userId },
      data: { ...data, lastActiveAt: new Date() },
    });
    return res.json(updated);
  }
  Object.assign(existing, data, { lastActiveAt: new Date().toISOString() });
  res.json(existing);
});

// Upload an image. Accepts a base64 data URL (data:image/png;base64,…).
// Returns { url } — either a Cloudinary https URL or the original data URL
// when no cloud provider is configured (so the client flow is identical
// in dev and prod).
app.post('/upload', auth, limits.general, async (req, res) => {
  const { dataUrl, folder } = req.body || {};
  if (!dataUrl || typeof dataUrl !== 'string') return res.status(400).json({ error: 'dataUrl required' });
  const imgMod = moderateImage(dataUrl);
  if (!imgMod.ok) return res.status(400).json({ error: `Image rejected: ${imgMod.reason}` });
  // 4MB cap on the raw base64 payload — generous for a photo, small enough not to abuse Cloudinary.
  if (dataUrl.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max ~3MB).' });
  if (!HAS_CLOUD_UPLOAD) {
    return res.json({ url: dataUrl, storage: 'inline' });
  }
  try {
    const url = await uploadDataUrl(dataUrl, folder === 'chat' ? 'businesstinder/chat' : 'businesstinder/profiles');
    if (!url) throw new Error('upload returned no url');
    res.json({ url, storage: 'cloud' });
  } catch (err) {
    console.warn('[upload] cloud failed, falling back to inline', err?.message);
    res.json({ url: dataUrl, storage: 'inline' });
  }
});

app.get('/profiles/me', auth, async (req, res) => {
  res.json((await findProfileByUserId(req.user.userId)) || null);
});

app.get('/discover', auth, async (req, res) => {
  const mine = req.user.userId;
  const meProfile = await findProfileByUserId(mine);
  const maxKm = req.query.maxKm ? Math.max(1, Math.min(20000, Number(req.query.maxKm) || 0)) : null;
  const filters = {
    stage: req.query.stage || null,
    lookingFor: req.query.lookingFor || null,
    location: req.query.location ? String(req.query.location).toLowerCase() : null,
    industry: req.query.industry && req.query.industry !== 'all' ? req.query.industry : null,
  };

  // Boost slot 1: anyone who SUPER_LIKEd the current user jumps to the top.
  let filtered;
  let superLikers;
  if (prisma) {
    // These three only depend on `mine`, so fetch them in one round-trip.
    const [swiped, blocks, superLikedMe] = await Promise.all([
      prisma.swipe.findMany({ where: { fromUserId: mine }, select: { toUserId: true } }),
      prisma.block.findMany({ where: { OR: [{ blockerId: mine }, { targetId: mine }] } }),
      prisma.swipe.findMany({ where: { toUserId: mine, direction: 'SUPER_LIKE' }, select: { fromUserId: true } }),
    ]);
    superLikers = superLikedMe;
    const excludeIds = [mine, ...swiped.map((s) => s.toUserId), ...blocks.map((b) => (b.blockerId === mine ? b.targetId : b.blockerId))];
    filtered = await prisma.profile.findMany({
      where: {
        userId: { notIn: excludeIds },
        stage: filters.stage || undefined,
        lookingFor: filters.lookingFor ? { has: filters.lookingFor } : undefined,
        industries: filters.industry ? { has: filters.industry } : undefined,
        location: filters.location ? { contains: filters.location, mode: 'insensitive' } : undefined,
        // Hide banned / actively-suspended owners.
        user: { OR: [{ bannedAt: null }, { bannedUntil: { lte: new Date() } }] },
      },
      include: { user: { select: { fullName: true, avatarUrl: true, companyVerifiedAt: true, companyDomain: true } } },
      orderBy: { lastActiveAt: 'desc' },
      take: DISCOVER_LIMIT,
    });
  } else {
    const usersById = new Map(mem.users.map((u) => [u.id, u]));
    const swiped = new Set(mem.swipes.filter((s) => s.fromUserId === mine).map((s) => s.toUserId));
    const blocked = new Set();
    for (const b of mem.blocks) {
      if (b.blockerId === mine) blocked.add(b.targetId);
      if (b.targetId === mine) blocked.add(b.blockerId);
    }
    filtered = mem.profiles
      .filter((p) => p.userId !== mine && !swiped.has(p.userId) && !blocked.has(p.userId) && !isBanned(usersById.get(p.userId)))
      .map((p) => {
        const u = usersById.get(p.userId);
        return { ...p, user: { fullName: u?.fullName, avatarUrl: u?.avatarUrl, companyVerifiedAt: u?.companyVerifiedAt, companyDomain: u?.companyDomain } };
      });
    if (filters.stage) filtered = filtered.filter((p) => p.stage === filters.stage);
    if (filters.lookingFor) filtered = filtered.filter((p) => (p.lookingFor || []).includes(filters.lookingFor));
    if (filters.industry) filtered = filtered.filter((p) => (p.industries || []).includes(filters.industry));
    if (filters.location) filtered = filtered.filter((p) => (p.location || '').toLowerCase().includes(filters.location));
    superLikers = mem.swipes.filter((s) => s.toUserId === mine && s.direction === 'SUPER_LIKE');
  }
  const superLikerSet = new Set(superLikers.map((s) => s.fromUserId));

  // Boost slot 2: users with an active boost window get ranked above normal
  // but below super-likers. Look up each candidate profile owner's boostUntil.
  const candidateIds = filtered.map((p) => p.userId);
  const activeBoostSet = new Set();
  if (candidateIds.length) {
    if (prisma) {
      const boosted = await prisma.user.findMany({
        where: { id: { in: candidateIds }, boostUntil: { gt: new Date() } },
        select: { id: true },
      });
      boosted.forEach((u) => activeBoostSet.add(u.id));
    } else {
      const idSet = new Set(candidateIds);
      mem.users
        .filter((u) => idSet.has(u.id) && isBoostActive(u))
        .forEach((u) => activeBoostSet.add(u.id));
    }
  }

  // Distance filter + per-profile distanceKm enrichment. Skipped silently
  // when either side hasn't been geocoded — text/remote-OK signals still
  // drive matching.
  const meGeo = meProfile?.latitude != null && meProfile?.longitude != null
    ? { lat: meProfile.latitude, lng: meProfile.longitude } : null;
  if (maxKm && meGeo) {
    filtered = filtered.filter((p) => {
      if (p.remoteOk && meProfile?.remoteOk) return true; // mutual remote bypasses distance
      if (p.latitude == null || p.longitude == null) return true; // keep ungeocoded — fall through
      const d = distanceKm(meGeo, { lat: p.latitude, lng: p.longitude });
      return d == null || d <= maxKm;
    });
  }

  const ranked = diversify(rankProfiles(meProfile, filtered));
  const tier = (id) => (superLikerSet.has(id) ? 2 : activeBoostSet.has(id) ? 1 : 0);
  ranked.sort((a, b) => {
    const t = tier(b.profile.userId) - tier(a.profile.userId);
    if (t !== 0) return t;
    return 0; // preserve ranked order within a tier
  });
  const out = ranked.map(({ profile, score, reasons }) => {
    const km = meGeo && profile.latitude != null && profile.longitude != null
      ? distanceKm(meGeo, { lat: profile.latitude, lng: profile.longitude }) : null;
    return {
      ...profile,
      fullName: profile.user?.fullName,
      avatarUrl: profile.photoUrl || profile.avatarUrl || profile.user?.avatarUrl,
      companyVerified: !!profile.user?.companyVerifiedAt,
      companyDomain: profile.user?.companyDomain || null,
      matchScore: score,
      matchReasons: reasons,
      mutualHighlights: mutualHighlights(meProfile, profile),
      superLikedYou: superLikerSet.has(profile.userId),
      boosted: activeBoostSet.has(profile.userId),
      distanceKm: km != null ? Math.round(km) : null,
    };
  });
  res.json(out);
});

app.post('/profile-views/:userId', auth, limits.general, async (req, res) => {
  const viewerId = req.user.userId;
  const viewedId = req.params.userId;
  if (!viewedId || viewedId === viewerId) return res.json({ ok: true });
  const target = await findUserById(viewedId);
  if (!target) return res.json({ ok: true }); // silently no-op, don't leak existence
  if (await isBlocked(viewerId, viewedId)) return res.json({ ok: true });
  if (prisma) {
    await prisma.profileView.create({ data: { viewerId, viewedId } });
  } else {
    if (!mem.profileViews) mem.profileViews = [];
    mem.profileViews.push({ id: crypto.randomUUID(), viewerId, viewedId, createdAt: new Date().toISOString() });
  }
  res.json({ ok: true });
});

app.get('/profile-views/incoming', auth, async (req, res) => {
  const me = req.user.userId;
  const user = await findUserById(me);
  const isPro = effectivePlanTier(user) === 'PRO';
  const cutoff = new Date(Date.now() - 30 * 86400_000);

  // Count first — for FREE this is the only thing we need to return.
  let count;
  if (prisma) {
    const groups = await prisma.profileView.groupBy({
      by: ['viewerId'],
      where: { viewedId: me, createdAt: { gt: cutoff } },
    });
    count = groups.length;
  } else {
    const distinct = new Set();
    for (const v of (mem.profileViews || [])) {
      if (v.viewedId === me && new Date(v.createdAt) > cutoff) distinct.add(v.viewerId);
    }
    count = distinct.size;
  }

  if (!isPro) return res.json({ count, profiles: null, locked: true });

  // PRO: paginate (default 25, max 100).
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  let viewerIds;
  if (prisma) {
    // Distinct viewer IDs ordered by most recent view.
    const rows = await prisma.$queryRaw`
      SELECT DISTINCT ON ("viewerId") "viewerId", "createdAt"
      FROM "ProfileView"
      WHERE "viewedId" = ${me} AND "createdAt" > ${cutoff}
      ORDER BY "viewerId", "createdAt" DESC
    `;
    viewerIds = rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit).map((r) => r.viewerId);
  } else {
    const seen = new Map();
    for (const v of (mem.profileViews || [])) {
      if (v.viewedId !== me || new Date(v.createdAt) <= cutoff) continue;
      const prev = seen.get(v.viewerId);
      if (!prev || new Date(v.createdAt) > new Date(prev)) seen.set(v.viewerId, v.createdAt);
    }
    viewerIds = [...seen.entries()].sort((a, b) => new Date(b[1]) - new Date(a[1])).slice(0, limit).map(([id]) => id);
  }

  let profiles;
  if (prisma) {
    profiles = await prisma.profile.findMany({
      where: { userId: { in: viewerIds } },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
  } else {
    const viewerIdSet = new Set(viewerIds);
    const usersById = new Map(mem.users.map((u) => [u.id, u]));
    profiles = mem.profiles
      .filter((p) => viewerIdSet.has(p.userId))
      .map((p) => ({ ...p, user: { fullName: usersById.get(p.userId)?.fullName } }));
  }
  // Preserve the recency order.
  const byId = new Map(profiles.map((p) => [p.userId, p]));
  const ordered = viewerIds.map((id) => byId.get(id)).filter(Boolean);
  res.json({
    count, locked: false, limit,
    profiles: ordered.map((p) => ({ ...p, fullName: p.user?.fullName, avatarUrl: p.photoUrl || p.avatarUrl || p.user?.avatarUrl })),
  });
});

app.get('/search', auth, async (req, res) => {
  const meId = req.user.userId;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);

  if (prisma) {
    // Filter + cap in the DB so we never pull the whole profile table over the
    // wire on every keystroke. ILIKE is case-insensitive; array_to_string folds
    // the tag columns into the haystack so keyword searches ("AI", "fintech")
    // still match. Escape LIKE metacharacters so a stray % or _ stays literal.
    const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await prisma.$queryRaw`
      SELECT p.*, u."fullName" AS "ownerName", u."avatarUrl" AS "ownerAvatar",
             u."companyVerifiedAt" AS "ownerCompanyVerifiedAt", u."companyDomain" AS "ownerCompanyDomain"
      FROM "Profile" p
      JOIN "User" u ON u."id" = p."userId"
      WHERE p."userId" <> ${meId}
        AND (u."bannedAt" IS NULL OR u."bannedUntil" <= NOW())
        AND (
          COALESCE(p."headline", '') || ' ' || COALESCE(p."bio", '') || ' ' ||
          COALESCE(p."location", '') || ' ' || COALESCE(u."fullName", '') || ' ' ||
          array_to_string(p."industries", ' ') || ' ' ||
          array_to_string(p."skills", ' ') || ' ' ||
          array_to_string(p."pastCompanies", ' ')
        ) ILIKE ${pattern}
      ORDER BY p."lastActiveAt" DESC
      LIMIT ${SEARCH_LIMIT}
    `;
    return res.json(rows.map(({ ownerName, ownerAvatar, ownerCompanyVerifiedAt, ownerCompanyDomain, ...p }) => ({
      ...p,
      fullName: ownerName,
      avatarUrl: p.photoUrl || p.avatarUrl || ownerAvatar,
      companyVerified: !!ownerCompanyVerifiedAt,
      companyDomain: ownerCompanyDomain || null,
    })));
  }

  const usersById = new Map(mem.users.map((u) => [u.id, u]));
  const out = [];
  for (const p of mem.profiles) {
    if (p.userId === meId) continue;
    const owner = usersById.get(p.userId);
    if (isBanned(owner)) continue;
    const hay = [
      p.headline, p.bio, p.location, owner?.fullName,
      (p.industries || []).join(' '),
      (p.skills || []).join(' '),
      (p.pastCompanies || []).join(' '),
    ].filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(q)) continue;
    out.push({ ...p, fullName: owner?.fullName, avatarUrl: p.photoUrl || p.avatarUrl || owner?.avatarUrl, companyVerified: !!owner?.companyVerifiedAt, companyDomain: owner?.companyDomain || null });
    if (out.length >= SEARCH_LIMIT) break;
  }
  res.json(out);
});

app.post('/swipes', auth, limits.swipe, async (req, res) => {
  const { toUserId, direction } = req.body || {};
  const fromUserId = req.user.userId;
  if (!['LEFT', 'RIGHT', 'SUPER_LIKE'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  if (toUserId === fromUserId) return res.status(400).json({ error: 'You cannot swipe on yourself' });
  if (await isBlocked(fromUserId, toUserId)) return res.status(403).json({ error: 'Blocked' });

  // Reject swipes against non-existent users (also avoids an FK 500 on insert).
  const target = await findUserById(toUserId);
  if (!target) return res.status(404).json({ error: 'User not found' });

  // Daily quota for FREE plan.
  const user = await findUserById(fromUserId);
  if (isBanned(user)) return res.status(403).json({ error: banMessage(user) });
  if (effectivePlanTier(user) !== 'PRO') {
    const today = todayKey();
    if (prisma) {
      // Atomic: roll the counter over on a new day, then increment only while
      // under the cap. The conditional WHERE makes the limit race-safe so a
      // burst of parallel swipes can't slip past FREE_DAILY_SWIPES.
      await prisma.user.updateMany({ where: { id: fromUserId, NOT: { lastSwipeDay: today } }, data: { swipesToday: 0, lastSwipeDay: today } });
      const bumped = await prisma.user.updateMany({
        where: { id: fromUserId, swipesToday: { lt: FREE_DAILY_SWIPES } },
        data: { swipesToday: { increment: 1 } },
      });
      if (bumped.count === 0) {
        return res.status(429).json({ error: 'Daily free swipe limit reached. Upgrade to Pro.', limit: FREE_DAILY_SWIPES });
      }
    } else {
      const count = user.lastSwipeDay === today ? user.swipesToday || 0 : 0;
      if (count >= FREE_DAILY_SWIPES) {
        return res.status(429).json({ error: 'Daily free swipe limit reached. Upgrade to Pro.', limit: FREE_DAILY_SWIPES });
      }
      user.swipesToday = count + 1;
      user.lastSwipeDay = today;
    }
  }

  if (prisma) {
    await prisma.swipe.upsert({
      where: { fromUserId_toUserId: { fromUserId, toUserId } },
      update: { direction },
      create: { fromUserId, toUserId, direction },
    });
    const reciprocal = await prisma.swipe.findFirst({
      where: { fromUserId: toUserId, toUserId: fromUserId, direction: { in: ['RIGHT', 'SUPER_LIKE'] } },
    });
    if ((direction === 'RIGHT' || direction === 'SUPER_LIKE') && reciprocal) {
      const [a, b] = [fromUserId, toUserId].sort();
      const match = await prisma.match.upsert({
        where: { userAId_userBId: { userAId: a, userBId: b } },
        update: {}, create: { userAId: a, userBId: b },
      });
      const conversation = await prisma.conversation.upsert({
        where: { matchId: match.id }, update: {}, create: { matchId: match.id },
      });
      const theirProfile = await prisma.profile.findUnique({ where: { userId: toUserId } });
      const myProfile = await prisma.profile.findUnique({ where: { userId: fromUserId } });
      pushToUser(toUserId, { title: 'New match on BusinessTinder', body: `${user.fullName} matched with you.` });
      // Also email the other side — push is opt-in, email is the safer net.
      const otherUser = await findUserById(toUserId);
      if (otherUser?.email && wantsActivityEmail(otherUser)) sendMatchEmail(otherUser.email, otherUser.fullName, user.fullName, unsubscribePath(otherUser.id)).catch(() => {});
      return res.json({ matched: true, match, conversation, icebreakers: suggestIcebreakers(theirProfile), theirIcebreakers: suggestIcebreakers(myProfile) });
    }
    return res.json({ matched: false });
  }

  mem.swipes = mem.swipes.filter((s) => !(s.fromUserId === fromUserId && s.toUserId === toUserId));
  mem.swipes.push({ id: crypto.randomUUID(), fromUserId, toUserId, direction });
  const reciprocal = mem.swipes.find(
    (s) => s.fromUserId === toUserId && s.toUserId === fromUserId && (s.direction === 'RIGHT' || s.direction === 'SUPER_LIKE'),
  );
  if ((direction === 'RIGHT' || direction === 'SUPER_LIKE') && reciprocal) {
    const [a, b] = [fromUserId, toUserId].sort();
    let match = mem.matches.find((m) => m.userAId === a && m.userBId === b);
    if (!match) {
      match = { id: crypto.randomUUID(), userAId: a, userBId: b, createdAt: new Date().toISOString() };
      mem.matches.push(match);
    }
    let conversation = mem.conversations.find((c) => c.matchId === match.id);
    if (!conversation) {
      conversation = { id: crypto.randomUUID(), matchId: match.id };
      mem.conversations.push(conversation);
    }
    const theirProfile = mem.profiles.find((p) => p.userId === toUserId);
    const myProfile = mem.profiles.find((p) => p.userId === fromUserId);
    pushToUser(toUserId, { title: 'New match on BusinessTinder', body: `${user.fullName} matched with you.` });
    const otherUser = mem.users.find((u) => u.id === toUserId);
    if (otherUser?.email) sendMatchEmail(otherUser.email, otherUser.fullName, user.fullName).catch(() => {});
    return res.json({ matched: true, match, conversation, icebreakers: suggestIcebreakers(theirProfile), theirIcebreakers: suggestIcebreakers(myProfile) });
  }
  res.json({ matched: false });
});

app.get('/likes/incoming', auth, async (req, res) => {
  const me = req.user.userId;
  let likers;
  if (prisma) {
    likers = await prisma.swipe.findMany({ where: { toUserId: me, direction: 'RIGHT' } });
    const swiped = await prisma.swipe.findMany({ where: { fromUserId: me }, select: { toUserId: true } });
    const seen = new Set(swiped.map((s) => s.toUserId));
    likers = likers.filter((l) => !seen.has(l.fromUserId));
  } else {
    const seen = new Set(mem.swipes.filter((s) => s.fromUserId === me).map((s) => s.toUserId));
    likers = mem.swipes.filter((s) => s.toUserId === me && s.direction === 'RIGHT' && !seen.has(s.fromUserId));
  }
  const user = await findUserById(me);
  const isPro = effectivePlanTier(user) === 'PRO';
  const likerIds = likers.map((l) => l.fromUserId);
  const fetchProfilesByIds = async (ids) => {
    if (!ids.length) return [];
    if (prisma) {
      return prisma.profile.findMany({
        where: { userId: { in: ids } },
        include: { user: { select: { fullName: true, avatarUrl: true } } },
      });
    }
    const idSet = new Set(ids);
    const usersById = new Map(mem.users.map((u) => [u.id, u]));
    return mem.profiles
      .filter((p) => idSet.has(p.userId))
      .map((p) => ({ ...p, user: { fullName: usersById.get(p.userId)?.fullName } }));
  };
  const shape = (arr) => arr.map((p) => ({
    ...p, fullName: p.user?.fullName, avatarUrl: p.photoUrl || p.avatarUrl || p.user?.avatarUrl,
  }));

  if (isPro) {
    const profiles = await fetchProfilesByIds(likerIds);
    return res.json({ count: likers.length, locked: false, profiles: shape(profiles) });
  }

  // FREE: show silhouettes of every liker (no identifying fields) so users
  // see momentum even before paying. They can additionally unlock one full
  // reveal per day (rotating across the liker set).
  const today = todayKey();
  const day = user.lastLikeRevealDay || null;
  const revealsToday = day === today ? user.likeRevealsToday || 0 : 0;
  const revealedIds = (user.revealedLikerIds || []).filter((id) => likerIds.includes(id));
  const revealedProfiles = revealedIds.length ? shape(await fetchProfilesByIds(revealedIds)) : [];

  const silhouettes = likers.map((l) => ({
    userId: l.fromUserId,
    masked: true,
    revealed: revealedIds.includes(l.fromUserId),
  }));

  res.json({
    count: likers.length,
    locked: true,
    silhouettes,
    revealedProfiles,
    revealsToday,
    dailyRevealLimit: FREE_DAILY_LIKE_REVEALS,
    canReveal: likers.length > revealedIds.length && revealsToday < FREE_DAILY_LIKE_REVEALS,
  });
});

// Unlock one liker per day on the free plan. Picks the most recent liker the
// user hasn't seen yet — gives them a fresh face every day they come back.
app.post('/likes/reveal', auth, limits.general, async (req, res) => {
  const me = req.user.userId;
  const user = await findUserById(me);
  if (effectivePlanTier(user) === 'PRO') return res.status(400).json({ error: 'Already Pro — all likers visible.' });
  const today = todayKey();
  const day = user.lastLikeRevealDay || null;
  const revealsToday = day === today ? user.likeRevealsToday || 0 : 0;
  if (revealsToday >= FREE_DAILY_LIKE_REVEALS) {
    return res.status(429).json({ error: 'Out of free reveals today. Upgrade to Pro to see everyone.' });
  }
  let likers;
  if (prisma) {
    likers = await prisma.swipe.findMany({
      where: { toUserId: me, direction: 'RIGHT' },
      orderBy: { createdAt: 'desc' },
    });
    const swiped = await prisma.swipe.findMany({ where: { fromUserId: me }, select: { toUserId: true } });
    const seen = new Set(swiped.map((s) => s.toUserId));
    likers = likers.filter((l) => !seen.has(l.fromUserId));
  } else {
    const seen = new Set(mem.swipes.filter((s) => s.fromUserId === me).map((s) => s.toUserId));
    likers = mem.swipes
      .filter((s) => s.toUserId === me && s.direction === 'RIGHT' && !seen.has(s.fromUserId))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }
  const already = new Set(user.revealedLikerIds || []);
  const next = likers.find((l) => !already.has(l.fromUserId));
  if (!next) return res.status(404).json({ error: 'Nobody new to reveal yet.' });

  const newRevealed = [...(user.revealedLikerIds || []), next.fromUserId].slice(-50);
  if (prisma) {
    await prisma.user.update({
      where: { id: me },
      data: { lastLikeRevealDay: today, likeRevealsToday: revealsToday + 1, revealedLikerIds: newRevealed },
    });
  } else {
    user.lastLikeRevealDay = today;
    user.likeRevealsToday = revealsToday + 1;
    user.revealedLikerIds = newRevealed;
  }

  let profile;
  if (prisma) {
    profile = await prisma.profile.findUnique({
      where: { userId: next.fromUserId },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
  } else {
    const p = mem.profiles.find((p) => p.userId === next.fromUserId);
    if (p) profile = { ...p, user: { fullName: mem.users.find((u) => u.id === next.fromUserId)?.fullName } };
  }
  if (!profile) return res.status(404).json({ error: 'Profile no longer available.' });

  res.json({
    profile: {
      ...profile,
      fullName: profile.user?.fullName,
      avatarUrl: profile.photoUrl || profile.avatarUrl || profile.user?.avatarUrl,
    },
    revealsToday: revealsToday + 1,
    dailyRevealLimit: FREE_DAILY_LIKE_REVEALS,
  });
});

// Admin verification. Flips the `verified` badge on a target user. Gated by
// the ADMIN_EMAILS env var — no public route exists for users to self-verify.
function isAdminUser(user) {
  return !!user && isAdminEmail(user.email);
}

app.post('/admin/verify', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!isAdminUser(me)) return res.status(403).json({ error: 'Admin only' });
  const { userId, verified } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (prisma) await prisma.user.update({ where: { id: userId }, data: { verified: !!verified } });
  else {
    const u = mem.users.find((x) => x.id === userId);
    if (u) u.verified = !!verified;
  }
  res.json({ ok: true });
});

// Ban (or timed-suspend) a user. `days` omitted/null = permanent. Also closes
// any of the target's still-open reports as ACTIONED.
app.post('/admin/ban', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!isAdminUser(me)) return res.status(403).json({ error: 'Admin only' });
  const { userId, days, reason } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (userId === me.id) return res.status(400).json({ error: 'You cannot ban yourself.' });
  const bannedAt = new Date();
  const numDays = Number(days);
  const bannedUntil = Number.isFinite(numDays) && numDays > 0
    ? new Date(Date.now() + numDays * 86400_000) : null;
  const banReason = reason ? String(reason).slice(0, 280) : null;
  if (prisma) {
    await prisma.user.update({ where: { id: userId }, data: { bannedAt, bannedUntil, banReason } });
    await prisma.report.updateMany({
      where: { targetId: userId, status: 'OPEN' },
      data: { status: 'ACTIONED', reviewedAt: new Date(), reviewedById: me.id },
    });
  } else {
    const u = mem.users.find((x) => x.id === userId);
    if (!u) return res.status(404).json({ error: 'User not found' });
    u.bannedAt = bannedAt.toISOString();
    u.bannedUntil = bannedUntil ? bannedUntil.toISOString() : null;
    u.banReason = banReason;
    for (const r of mem.reports) {
      if (r.targetId === userId && (r.status || 'OPEN') === 'OPEN') {
        r.status = 'ACTIONED'; r.reviewedAt = new Date().toISOString(); r.reviewedById = me.id;
      }
    }
  }
  res.json({ ok: true, bannedUntil: bannedUntil ? bannedUntil.toISOString() : null });
});

app.post('/admin/unban', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!isAdminUser(me)) return res.status(403).json({ error: 'Admin only' });
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (prisma) {
    await prisma.user.update({ where: { id: userId }, data: { bannedAt: null, bannedUntil: null, banReason: null } });
  } else {
    const u = mem.users.find((x) => x.id === userId);
    if (u) { u.bannedAt = null; u.bannedUntil = null; u.banReason = null; }
  }
  res.json({ ok: true });
});

// Resolve a report without banning (dismiss as not-actionable, or mark actioned).
app.post('/admin/reports/:id/resolve', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!isAdminUser(me)) return res.status(403).json({ error: 'Admin only' });
  const status = ['DISMISSED', 'ACTIONED', 'OPEN'].includes(req.body?.status) ? req.body.status : 'DISMISSED';
  const { id } = req.params;
  if (prisma) {
    await prisma.report.update({
      where: { id },
      data: { status, reviewedAt: new Date(), reviewedById: me.id },
    });
  } else {
    const r = mem.reports.find((x) => x.id === id);
    if (!r) return res.status(404).json({ error: 'Report not found' });
    r.status = status; r.reviewedAt = new Date().toISOString(); r.reviewedById = me.id;
  }
  res.json({ ok: true, status });
});

// Seed a small cast of demo profiles so the admin can swipe through a varied
// deck during testing. Idempotent — users whose email already exists are
// skipped (the existing rows are not modified). Locations are geocoded so
// distance filters work against the seeded set.
app.post('/admin/seed-fakes', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!isAdminUser(me)) return res.status(403).json({ error: 'Admin only' });

  const passwordHash = await bcrypt.hash(FAKE_PASSWORD, 10);
  let created = 0;
  let skipped = 0;
  const errors = [];

  for (const seed of FAKE_USERS) {
    try {
      const existing = await findUserByEmail(seed.email);
      if (existing) { skipped += 1; continue; }

      // Build the user row.
      let user;
      if (prisma) {
        user = await prisma.user.create({
          data: {
            email: seed.email,
            passwordHash,
            fullName: seed.fullName,
            emailVerified: true,        // seeded users skip the verify dance
            verified: false,
            referralCode: randomCode(8),
          },
        });
      } else {
        user = {
          id: crypto.randomUUID(),
          email: seed.email,
          passwordHash,
          fullName: seed.fullName,
          avatarUrl: null,
          planTier: 'FREE',
          referralCode: randomCode(8),
          referredBy: null,
          swipesToday: 0,
          lastSwipeDay: null,
          emailVerified: true,
          verificationToken: null,
          verified: false,
          lastLikeRevealDay: null,
          likeRevealsToday: 0,
          revealedLikerIds: [],
          createdAt: new Date().toISOString(),
        };
        mem.users.push(user);
      }

      // Geocode the location so distance filters work for these profiles.
      const point = await geocode(seed.location);
      const slug = await uniqueSlug(slugify(seed.fullName));

      const profileData = {
        headline: seed.headline,
        userType: seed.userType,
        lookingFor: seed.lookingFor || [],
        bio: seed.bio,
        stage: seed.stage,
        industries: seed.industries || [],
        skills: seed.skills || [],
        location: seed.location,
        remoteOk: !!seed.remoteOk,
        commitment: seed.commitment || null,
        pastCompanies: seed.pastCompanies || [],
        promptIds: seed.promptIds || [],
        promptAnswers: seed.promptAnswers || [],
        latitude: point?.lat ?? null,
        longitude: point?.lng ?? null,
      };

      if (prisma) {
        await prisma.profile.create({
          data: { userId: user.id, slug, ...profileData, lastActiveAt: new Date() },
        });
      } else {
        mem.profiles.push({
          id: crypto.randomUUID(),
          userId: user.id,
          slug,
          ...profileData,
          lastActiveAt: new Date().toISOString(),
        });
      }
      created += 1;
    } catch (err) {
      console.warn('[seed-fakes] failed for', seed.email, err?.message);
      errors.push({ email: seed.email, error: err?.message || 'unknown' });
    }
  }

  res.json({
    created,
    skipped,
    total: FAKE_USERS.length,
    errors,
    credentials: { password: FAKE_PASSWORD, emails: FAKE_USERS.map((u) => u.email) },
  });
});

// Tiny admin queue endpoint so reviewers can see pending reports + recent users.
app.get('/admin/queue', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!isAdminUser(me)) return res.status(403).json({ error: 'Admin only' });
  if (prisma) {
    const [reports, recentUsers] = await Promise.all([
      // Open reports first, then most-recent.
      prisma.report.findMany({ orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 50 }),
      prisma.user.findMany({ orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, email: true, fullName: true, verified: true, emailVerified: true, bannedAt: true, bannedUntil: true, banReason: true, createdAt: true } }),
    ]);
    return res.json({ reports, recentUsers: recentUsers.map((u) => ({ ...u, banned: isBanned(u) })) });
  }
  const reports = [...mem.reports].sort((a, b) => {
    const sa = (a.status || 'OPEN') === 'OPEN' ? 0 : 1;
    const sb = (b.status || 'OPEN') === 'OPEN' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  }).slice(0, 50);
  res.json({
    reports: reports.map((r) => ({ status: 'OPEN', ...r })),
    recentUsers: mem.users.slice(-50).reverse().map((u) => ({
      id: u.id, email: u.email, fullName: u.fullName, verified: !!u.verified, emailVerified: !!u.emailVerified,
      bannedAt: u.bannedAt || null, bannedUntil: u.bannedUntil || null, banReason: u.banReason || null, banned: isBanned(u), createdAt: u.createdAt,
    })),
  });
});

app.get('/matches', auth, async (req, res) => {
  const userId = req.user.userId;
  if (prisma) {
    const matches = await prisma.match.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
      orderBy: { createdAt: 'desc' },
    });
    const otherIds = matches.map((m) => (m.userAId === userId ? m.userBId : m.userAId));
    const convs = await prisma.conversation.findMany({ where: { matchId: { in: matches.map((m) => m.id) } } });
    const convIds = convs.map((c) => c.id);
    // Single round-trip for both last-message and unread counts.
    const [others, lastMessages, unreadGroups] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: otherIds } }, include: { profile: true } }),
      convIds.length
        ? prisma.$queryRaw`
            SELECT DISTINCT ON ("conversationId") *
            FROM "Message"
            WHERE "conversationId" = ANY(${convIds}::text[])
            ORDER BY "conversationId", "createdAt" DESC
          `
        : Promise.resolve([]),
      convIds.length
        ? prisma.message.groupBy({
            by: ['conversationId'],
            where: { conversationId: { in: convIds }, senderId: { not: userId }, status: { not: 'READ' } },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const lastByConv = new Map(lastMessages.map((m) => [m.conversationId, m]));
    const unreadByConv = new Map(unreadGroups.map((g) => [g.conversationId, g._count._all]));
    return res.json(
      matches.map((m) => {
        const otherId = m.userAId === userId ? m.userBId : m.userAId;
        const other = others.find((u) => u.id === otherId);
        const conversation = convs.find((c) => c.matchId === m.id) || null;
        return {
          ...m,
          other: other
            ? { id: other.id, fullName: other.fullName, avatarUrl: other.profile?.photoUrl || other.avatarUrl, profile: other.profile }
            : null,
          conversation,
          lastMessage: conversation ? lastByConv.get(conversation.id) || null : null,
          unreadCount: conversation ? (unreadByConv.get(conversation.id) || 0) : 0,
        };
      }),
    );
  }
  const matches = mem.matches
    .filter((m) => m.userAId === userId || m.userBId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const usersById = new Map(mem.users.map((u) => [u.id, u]));
  const profilesByUserId = new Map(mem.profiles.map((p) => [p.userId, p]));
  const convByMatchId = new Map(mem.conversations.map((c) => [c.matchId, c]));
  const msgsByConv = new Map();
  for (const x of mem.messages) {
    const list = msgsByConv.get(x.conversationId);
    if (list) list.push(x);
    else msgsByConv.set(x.conversationId, [x]);
  }
  res.json(
    matches.map((m) => {
      const otherId = m.userAId === userId ? m.userBId : m.userAId;
      const user = usersById.get(otherId);
      const profile = profilesByUserId.get(otherId);
      const conversation = convByMatchId.get(m.id);
      const msgs = conversation ? (msgsByConv.get(conversation.id) || []) : [];
      const lastMessage = msgs.length ? msgs[msgs.length - 1] : null;
      const unreadCount = msgs.filter((x) => x.senderId !== userId && x.status !== 'READ').length;
      return {
        ...m,
        other: user ? { id: user.id, fullName: user.fullName, avatarUrl: profile?.photoUrl || user.avatarUrl, profile } : null,
        conversation,
        lastMessage,
        unreadCount,
      };
    }),
  );
});

app.post('/conversations/:conversationId/read', auth, async (req, res) => {
  const { conversationId } = req.params;
  if (!(await canAccessConversation(req.user.userId, conversationId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (prisma) {
    await prisma.message.updateMany({
      where: { conversationId, senderId: { not: req.user.userId }, status: { not: 'READ' } },
      data: { status: 'READ' },
    });
  } else {
    mem.messages.forEach((m) => {
      if (m.conversationId === conversationId && m.senderId !== req.user.userId) m.status = 'READ';
    });
  }
  // Let the other party update their "Read" receipts live.
  const otherId = await otherUserInConversation(req.user.userId, conversationId);
  if (otherId) sendToUser(otherId, { type: 'read', conversationId, at: new Date().toISOString() });
  res.json({ ok: true });
});

app.get('/messages/:conversationId', auth, async (req, res) => {
  const { conversationId } = req.params;
  if (!(await canAccessConversation(req.user.userId, conversationId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 50));
  const before = req.query.before ? String(req.query.before) : null;
  if (prisma) {
    let beforeMsg = null;
    if (before) beforeMsg = await prisma.message.findUnique({ where: { id: before } });
    const where = { conversationId, ...(beforeMsg ? { createdAt: { lt: beforeMsg.createdAt } } : {}) };
    const messages = await prisma.message.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit });
    return res.json(messages.reverse());
  }
  let all = mem.messages.filter((m) => m.conversationId === conversationId);
  if (before) {
    const idx = all.findIndex((m) => m.id === before);
    if (idx >= 0) all = all.slice(0, idx);
  }
  res.json(all.slice(-limit));
});

app.post('/messages/:conversationId', auth, limits.message, async (req, res) => {
  const { conversationId } = req.params;
  const { body, kind } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Missing body' });
  const safeKind = ['text', 'image'].includes(kind) ? kind : 'text';
  if (safeKind === 'image') {
    const mod = moderateImage(body);
    if (!mod.ok) return res.status(400).json({ error: `Image rejected: ${mod.reason}` });
  } else {
    const mod = moderateText(body);
    if (!mod.ok) return res.status(400).json({ error: `Message blocked: ${mod.reason}` });
  }
  const sender = await findUserById(req.user.userId);
  if (isBanned(sender)) return res.status(403).json({ error: banMessage(sender) });
  if (!(await canAccessConversation(req.user.userId, conversationId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const otherId = await otherUserInConversation(req.user.userId, conversationId);
  if (otherId && (await isBlocked(req.user.userId, otherId))) {
    return res.status(403).json({ error: 'Blocked' });
  }
  let saved;
  if (prisma) {
    saved = await prisma.message.create({
      data: { conversationId, senderId: req.user.userId, body, kind: safeKind, status: 'SENT' },
    });
  } else {
    saved = {
      id: crypto.randomUUID(), conversationId, senderId: req.user.userId, body, kind: safeKind,
      status: 'SENT', createdAt: new Date().toISOString(),
    };
    mem.messages.push(saved);
  }
  res.json(saved);
});

app.post('/saved/:userId', auth, async (req, res) => {
  const meId = req.user.userId;
  const target = req.params.userId;
  if (prisma) {
    await prisma.savedProfile.upsert({
      where: { userId_profileUserId: { userId: meId, profileUserId: target } },
      update: {}, create: { userId: meId, profileUserId: target },
    });
  } else if (!mem.saved.find((s) => s.userId === meId && s.profileUserId === target)) {
    mem.saved.push({ id: crypto.randomUUID(), userId: meId, profileUserId: target, createdAt: new Date().toISOString() });
  }
  res.json({ ok: true });
});

app.delete('/saved/:userId', auth, async (req, res) => {
  const meId = req.user.userId;
  const target = req.params.userId;
  if (prisma) {
    await prisma.savedProfile.deleteMany({ where: { userId: meId, profileUserId: target } });
  } else {
    mem.saved = mem.saved.filter((s) => !(s.userId === meId && s.profileUserId === target));
  }
  res.json({ ok: true });
});

app.get('/saved', auth, async (req, res) => {
  const meId = req.user.userId;
  let ids;
  if (prisma) {
    const rows = await prisma.savedProfile.findMany({ where: { userId: meId } });
    ids = rows.map((r) => r.profileUserId);
  } else {
    ids = mem.saved.filter((s) => s.userId === meId).map((s) => s.profileUserId);
  }
  let profiles;
  if (prisma) {
    profiles = await prisma.profile.findMany({
      where: { userId: { in: ids } },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
  } else {
    const idSet = new Set(ids);
    const usersById = new Map(mem.users.map((u) => [u.id, u]));
    profiles = mem.profiles
      .filter((p) => idSet.has(p.userId))
      .map((p) => ({ ...p, user: { fullName: usersById.get(p.userId)?.fullName } }));
  }
  res.json(profiles.map((p) => ({ ...p, fullName: p.user?.fullName, avatarUrl: p.photoUrl || p.avatarUrl || p.user?.avatarUrl })));
});

app.get('/swipes/history', auth, async (req, res) => {
  const meId = req.user.userId;
  let rows;
  if (prisma) {
    rows = await prisma.swipe.findMany({
      where: { fromUserId: meId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        toUser: { select: { fullName: true, avatarUrl: true } },
      },
    });
    const ids = rows.map((r) => r.toUserId);
    const profiles = await prisma.profile.findMany({ where: { userId: { in: ids } } });
    const byId = new Map(profiles.map((p) => [p.userId, p]));
    return res.json(rows.map((r) => {
      const prof = byId.get(r.toUserId);
      return {
        toUserId: r.toUserId,
        direction: r.direction,
        createdAt: r.createdAt,
        fullName: r.toUser?.fullName || 'Unknown',
        headline: prof?.headline || '',
        avatarUrl: prof?.photoUrl || prof?.avatarUrl || r.toUser?.avatarUrl || null,
      };
    }));
  }

  rows = mem.swipes
    .filter((x) => x.fromUserId === meId)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, 100);

  const usersById = new Map(mem.users.map((u) => [u.id, u]));
  const profilesByUserId = new Map(mem.profiles.map((p) => [p.userId, p]));
  return res.json(rows.map((r) => {
    const user = usersById.get(r.toUserId);
    const prof = profilesByUserId.get(r.toUserId);
    return {
      toUserId: r.toUserId,
      direction: r.direction,
      createdAt: r.createdAt || null,
      fullName: user?.fullName || 'Unknown',
      headline: prof?.headline || '',
      avatarUrl: prof?.photoUrl || prof?.avatarUrl || user?.avatarUrl || null,
    };
  }));
});

app.post('/blocks', auth, async (req, res) => {
  const meId = req.user.userId;
  const target = req.body?.targetId;
  if (!target) return res.status(400).json({ error: 'targetId required' });
  if (target === meId) return res.status(400).json({ error: 'You cannot block yourself' });
  if (!(await findUserById(target))) return res.status(404).json({ error: 'User not found' });
  if (prisma) {
    await prisma.block.upsert({
      where: { blockerId_targetId: { blockerId: meId, targetId: target } },
      update: {}, create: { blockerId: meId, targetId: target },
    });
  } else if (!mem.blocks.find((b) => b.blockerId === meId && b.targetId === target)) {
    mem.blocks.push({ id: crypto.randomUUID(), blockerId: meId, targetId: target, createdAt: new Date().toISOString() });
  }
  res.json({ ok: true });
});

app.post('/reports', auth, async (req, res) => {
  const meId = req.user.userId;
  const { targetId, reason } = req.body || {};
  if (!targetId) return res.status(400).json({ error: 'targetId required' });
  if (targetId === meId) return res.status(400).json({ error: 'You cannot report yourself' });
  if (!(await findUserById(targetId))) return res.status(404).json({ error: 'User not found' });
  if (prisma) {
    await prisma.report.create({ data: { reporterId: meId, targetId, reason: reason || null } });
    await prisma.block.upsert({
      where: { blockerId_targetId: { blockerId: meId, targetId } },
      update: {}, create: { blockerId: meId, targetId },
    });
  } else {
    mem.reports.push({ id: crypto.randomUUID(), reporterId: meId, targetId, reason: reason || null, status: 'OPEN', createdAt: new Date().toISOString() });
    if (!mem.blocks.find((b) => b.blockerId === meId && b.targetId === targetId)) {
      mem.blocks.push({ id: crypto.randomUUID(), blockerId: meId, targetId, createdAt: new Date().toISOString() });
    }
  }
  res.json({ ok: true });
});

app.post('/push/subscribe', auth, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) return res.status(400).json({ error: 'Invalid subscription' });
  const data = { userId: req.user.userId, endpoint, p256dh: keys.p256dh, auth: keys.auth };
  if (prisma) {
    await prisma.pushSubscription.upsert({ where: { endpoint }, update: data, create: data });
    await prisma.user.update({ where: { id: req.user.userId }, data: { notifPushOptIn: true } });
  } else {
    mem.pushSubs = mem.pushSubs.filter((s) => s.endpoint !== endpoint);
    mem.pushSubs.push({ id: crypto.randomUUID(), ...data, createdAt: new Date().toISOString() });
  }
  res.json({ ok: true });
});

// Toggle activity (match / message digest) emails for the signed-in user.
app.post('/me/notifications', auth, async (req, res) => {
  const emailOptOut = !!req.body?.emailOptOut;
  if (prisma) {
    await prisma.user.update({ where: { id: req.user.userId }, data: { notifEmailOptOut: emailOptOut } });
  } else {
    const u = mem.users.find((x) => x.id === req.user.userId);
    if (u) u.notifEmailOptOut = emailOptOut;
  }
  res.json({ ok: true, emailOptOut });
});

// Start work-email verification: store the address + a token and email a
// confirmation link. Requires a real, non-free, non-disposable work domain so
// the resulting badge actually means something.
app.post('/me/company-email', auth, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const domain = emailDomain(email);
  if (!domain) return res.status(400).json({ error: 'Enter a valid work email.' });
  if (isDisposableEmail(email) || isFreeEmailDomain(email)) {
    return res.status(400).json({ error: 'Use your company email — free/disposable providers don\'t qualify.' });
  }
  const me = await findUserById(req.user.userId);
  if (!me) return res.status(404).json({ error: 'User not found' });
  const token = randomCode(24);
  if (prisma) {
    await prisma.user.update({ where: { id: me.id }, data: { companyEmail: email, companyVerifyToken: token, companyVerifiedAt: null, companyDomain: null } });
  } else {
    me.companyEmail = email; me.companyVerifyToken = token; me.companyVerifiedAt = null; me.companyDomain = null;
  }
  const verifyPath = `/company/verify?token=${token}`;
  sendCompanyVerifyEmail(email, me.fullName, verifyPath).catch((err) => console.warn('[email] company-verify', err?.message));
  const verifyUrl = NODE_ENV === 'production' && HAS_EMAIL ? undefined : verifyPath;
  res.json({ ok: true, companyDomain: domain, verifyUrl });
});

// Confirm a work email from the emailed link. No auth — the token authorizes.
app.get('/company/verify', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) return res.status(400).send('Missing token');
  let user;
  if (prisma) user = await prisma.user.findUnique({ where: { companyVerifyToken: token } });
  else user = mem.users.find((u) => u.companyVerifyToken === token);
  if (!user) return res.status(404).send('Invalid or expired link');
  const domain = emailDomain(user.companyEmail);
  if (prisma) {
    await prisma.user.update({ where: { id: user.id }, data: { companyVerifiedAt: new Date(), companyDomain: domain, companyVerifyToken: null } });
  } else {
    user.companyVerifiedAt = new Date().toISOString(); user.companyDomain = domain; user.companyVerifyToken = null;
  }
  res.redirect('/?companyVerified=1');
});

// ---------- two-factor auth (TOTP) ----------
// Begin enrollment: mint a secret (not yet active) and return the otpauth URI
// for the user's authenticator app. Activation happens in /me/2fa/enable.
app.post('/me/2fa/setup', auth, async (req, res) => {
  const user = await findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totpEnabled) return res.status(400).json({ error: '2FA is already enabled. Disable it first to re-enroll.' });
  const secret = generateSecret();
  if (prisma) await prisma.user.update({ where: { id: user.id }, data: { totpSecret: secret } });
  else user.totpSecret = secret;
  res.json({ secret, otpauthUrl: otpauthUrl(secret, user.email) });
});

// Confirm enrollment with a code from the app, then return one-time recovery
// codes (shown to the user once; only hashes are stored).
app.post('/me/2fa/enable', auth, async (req, res) => {
  const user = await findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.totpEnabled) return res.status(400).json({ error: '2FA is already enabled.' });
  if (!user.totpSecret) return res.status(400).json({ error: 'Start setup first.' });
  if (!verifyTotp(user.totpSecret, String(req.body?.code || '').trim())) {
    return res.status(400).json({ error: 'That code is incorrect — check your authenticator and try again.' });
  }
  const recoveryCodes = generateRecoveryCodes();
  const hashed = recoveryCodes.map(hashRecoveryCode);
  if (prisma) await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: true, recoveryCodes: hashed } });
  else { user.totpEnabled = true; user.recoveryCodes = hashed; }
  res.json({ ok: true, recoveryCodes });
});

// Turn 2FA off. Requires a current code (or recovery code) to prove possession.
app.post('/me/2fa/disable', auth, async (req, res) => {
  const user = await findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!user.totpEnabled) return res.json({ ok: true, twoFactorEnabled: false });
  const entered = String(req.body?.code || '').trim();
  const codeOk = verifyTotp(user.totpSecret, entered) || (user.recoveryCodes || []).includes(hashRecoveryCode(entered));
  if (!codeOk) return res.status(400).json({ error: 'Enter a valid 2FA or recovery code to disable.' });
  if (prisma) await prisma.user.update({ where: { id: user.id }, data: { totpEnabled: false, totpSecret: null, recoveryCodes: [] } });
  else { user.totpEnabled = false; user.totpSecret = null; user.recoveryCodes = []; }
  res.json({ ok: true, twoFactorEnabled: false });
});

// One-click unsubscribe from a transactional email footer. No auth — the
// signed token in the link authorizes it. Always opts the user OUT.
app.get('/unsubscribe', async (req, res) => {
  const userId = String(req.query.u || '');
  const token = String(req.query.t || '');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!userId || !verifyUnsubToken(userId, token)) {
    return res.status(400).send(unsubscribePage('That unsubscribe link is invalid or expired.', false));
  }
  if (prisma) {
    await prisma.user.update({ where: { id: userId }, data: { notifEmailOptOut: true } }).catch(() => {});
  } else {
    const u = mem.users.find((x) => x.id === userId);
    if (u) u.notifEmailOptOut = true;
  }
  res.send(unsubscribePage("You're unsubscribed from BusinessTinder activity emails. You can re-enable them anytime in Settings.", true));
});

app.post('/plan/upgrade', auth, async (req, res) => {
  // Real Stripe wiring goes here. Until that lands we refuse to flip the flag
  // in production so a stray authenticated POST can't grant free Pro to anyone.
  // Set ALLOW_DEV_PLAN_UPGRADE=true to opt back in (for staging/QA only).
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEV_PLAN_UPGRADE !== 'true') {
    return res.status(501).json({ error: 'Plan upgrade is not yet available. Payment integration pending.' });
  }
  // Give the dev/staging grant a finite lifetime so it can't accidentally become
  // a permanent free Pro for whoever triggers it.
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  if (prisma) await prisma.user.update({ where: { id: req.user.userId }, data: { planTier: 'PRO', planExpiresAt: expiresAt } });
  else {
    const u = mem.users.find((u) => u.id === req.user.userId);
    if (u) { u.planTier = 'PRO'; u.planExpiresAt = expiresAt.toISOString(); }
  }
  res.json({ ok: true, planTier: 'PRO', planExpiresAt: expiresAt.toISOString() });
});

// Boost: Pro-only top-of-deck placement for 30 minutes. One per day.
app.post('/boost', auth, limits.general, async (req, res) => {
  const me = await findUserById(req.user.userId);
  if (!me) return res.status(404).json({ error: 'User not found' });
  if (effectivePlanTier(me) !== 'PRO') {
    return res.status(402).json({ error: 'Boost is a Pro feature.' });
  }
  const today = todayKey();
  if (me.lastBoostDay === today) {
    return res.status(429).json({ error: 'You already used your boost today. Come back tomorrow.' });
  }
  const boostUntil = new Date(Date.now() + BOOST_DURATION_MS);
  if (prisma) {
    await prisma.user.update({ where: { id: me.id }, data: { boostUntil, lastBoostDay: today } });
  } else {
    me.boostUntil = boostUntil.toISOString();
    me.lastBoostDay = today;
  }
  res.json({ ok: true, boostUntil, durationMs: BOOST_DURATION_MS });
});

app.get('/boost/status', auth, async (req, res) => {
  const me = await findUserById(req.user.userId);
  const active = isBoostActive(me);
  const today = todayKey();
  res.json({
    active,
    boostUntil: active ? me.boostUntil : null,
    usedToday: me?.lastBoostDay === today,
    isPro: effectivePlanTier(me) === 'PRO',
  });
});

// Unmatch: remove the match, conversation, messages between the current
// user and the other side. Does not block — they can still re-discover
// each other unless one of them blocks explicitly.
app.delete('/matches/:matchId', auth, async (req, res) => {
  const me = req.user.userId;
  const { matchId } = req.params;
  if (prisma) {
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ error: 'Match not found' });
    if (match.userAId !== me && match.userBId !== me) return res.status(403).json({ error: 'Not your match' });
    // Conversation → messages cascades via the FK; the match→conversation
    // link is not declared as a cascade in the schema so we delete by hand.
    // Wrap both deletes in a transaction so we never leave an orphaned
    // conversation if the match delete fails partway.
    await prisma.$transaction([
      prisma.conversation.deleteMany({ where: { matchId } }),
      prisma.match.delete({ where: { id: matchId } }),
    ]);
    return res.json({ ok: true });
  }
  const match = mem.matches.find((m) => m.id === matchId);
  if (!match) return res.status(404).json({ error: 'Match not found' });
  if (match.userAId !== me && match.userBId !== me) return res.status(403).json({ error: 'Not your match' });
  const convIds = new Set(mem.conversations.filter((c) => c.matchId === matchId).map((c) => c.id));
  mem.conversations = mem.conversations.filter((c) => c.matchId !== matchId);
  mem.messages = mem.messages.filter((m) => !convIds.has(m.conversationId));
  mem.matches = mem.matches.filter((m) => m.id !== matchId);
  res.json({ ok: true });
});

app.post('/referrals/redeem', auth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  let inviter;
  if (prisma) inviter = await prisma.user.findUnique({ where: { referralCode: code } });
  else inviter = mem.users.find((u) => u.referralCode === code);
  if (!inviter) return res.status(404).json({ error: 'Invalid code' });
  if (inviter.id === req.user.userId) return res.status(400).json({ error: 'Cannot redeem your own code' });
  const me = await findUserById(req.user.userId);
  // Idempotent: a referral can only ever be attributed once per account.
  if (me?.referredBy) return res.status(400).json({ error: 'You have already redeemed a referral code' });
  if (prisma) await prisma.user.update({ where: { id: req.user.userId }, data: { referredBy: inviter.id } });
  else if (me) me.referredBy = inviter.id;
  res.json({ ok: true, inviter: { fullName: inviter.fullName } });
});

app.get('/icebreakers', auth, async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (await isBlocked(req.user.userId, userId)) return res.status(403).json({ error: 'Forbidden' });
  const them = await findProfileByUserId(userId);
  res.json({ prompts: suggestIcebreakers(them) });
});

app.delete('/me', auth, async (req, res) => {
  const me = req.user.userId;
  if (prisma) {
    // Find this user's matches first so we can drop the linked conversations
    // (there is no FK cascade from Match → Conversation in the schema).
    const myMatches = await prisma.match.findMany({
      where: { OR: [{ userAId: me }, { userBId: me }] }, select: { id: true },
    });
    const matchIds = myMatches.map((m) => m.id);
    if (matchIds.length) {
      // Cascade from Conversation → Message via the existing FK relation.
      await prisma.conversation.deleteMany({ where: { matchId: { in: matchIds } } });
    }
    await prisma.savedProfile.deleteMany({ where: { OR: [{ userId: me }, { profileUserId: me }] } });
    await prisma.profileView.deleteMany({ where: { OR: [{ viewerId: me }, { viewedId: me }] } });
    await prisma.report.deleteMany({ where: { OR: [{ reporterId: me }, { targetId: me }] } });
    await prisma.block.deleteMany({ where: { OR: [{ blockerId: me }, { targetId: me }] } });
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    await prisma.user.delete({ where: { id: me } });
  } else {
    const myMatchIds = new Set(
      mem.matches.filter((m) => m.userAId === me || m.userBId === me).map((m) => m.id),
    );
    const myConvIds = new Set(
      mem.conversations.filter((c) => myMatchIds.has(c.matchId)).map((c) => c.id),
    );
    mem.users = mem.users.filter((u) => u.id !== me);
    mem.profiles = mem.profiles.filter((p) => p.userId !== me);
    mem.swipes = mem.swipes.filter((s) => s.fromUserId !== me && s.toUserId !== me);
    mem.matches = mem.matches.filter((m) => m.userAId !== me && m.userBId !== me);
    mem.conversations = mem.conversations.filter((c) => !myConvIds.has(c.id));
    mem.messages = mem.messages.filter((m) => m.senderId !== me && !myConvIds.has(m.conversationId));
    mem.saved = mem.saved.filter((s) => s.userId !== me && s.profileUserId !== me);
    mem.reports = mem.reports.filter((r) => r.reporterId !== me && r.targetId !== me);
    mem.blocks = mem.blocks.filter((b) => b.blockerId !== me && b.targetId !== me);
    mem.pushSubs = mem.pushSubs.filter((s) => s.userId !== me);
    mem.profileViews = (mem.profileViews || []).filter((v) => v.viewerId !== me && v.viewedId !== me);
  }
  res.json({ ok: true });
});

app.get('/blocks', auth, async (req, res) => {
  const me = req.user.userId;
  let blocks;
  if (prisma) {
    blocks = await prisma.block.findMany({ where: { blockerId: me } });
    const ids = blocks.map((b) => b.targetId);
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      include: { profile: true },
    });
    return res.json(
      blocks.map((b) => {
        const u = users.find((x) => x.id === b.targetId);
        return { id: b.id, targetId: b.targetId, createdAt: b.createdAt, fullName: u?.fullName || null, headline: u?.profile?.headline || null };
      }),
    );
  }
  blocks = mem.blocks.filter((b) => b.blockerId === me);
  const usersById = new Map(mem.users.map((x) => [x.id, x]));
  const profilesByUserId = new Map(mem.profiles.map((x) => [x.userId, x]));
  res.json(
    blocks.map((b) => {
      const u = usersById.get(b.targetId);
      const p = profilesByUserId.get(b.targetId);
      return { id: b.id, targetId: b.targetId, createdAt: b.createdAt, fullName: u?.fullName || null, headline: p?.headline || null };
    }),
  );
});

app.delete('/blocks/:targetId', auth, async (req, res) => {
  const me = req.user.userId;
  const targetId = req.params.targetId;
  if (prisma) {
    await prisma.block.deleteMany({ where: { blockerId: me, targetId } });
  } else {
    mem.blocks = mem.blocks.filter((b) => !(b.blockerId === me && b.targetId === targetId));
  }
  res.json({ ok: true });
});

// Minimal branded HTML shell for server-rendered standalone pages
// (unsubscribe confirmation, legal docs). Body is trusted/static here.
function staticPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · BusinessTinder</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg" />
<link rel="stylesheet" href="/styles.css" />
</head><body><div class="app-shell"><main class="glass pad legal-page">
${bodyHtml}
<p style="margin-top:24px;"><a class="primary" style="display:inline-block;padding:12px 20px;text-decoration:none;border-radius:12px;" href="/">← Back to BusinessTinder</a></p>
</main></div></body></html>`;
}

function unsubscribePage(message, ok) {
  return staticPage(ok ? 'Unsubscribed' : 'Unsubscribe', `<h1>${ok ? 'Unsubscribed' : 'Unsubscribe'}</h1><p>${escapeHtml(message)}</p>`);
}

const LEGAL_EFFECTIVE = '2026-05-24';
const LEGAL = {
  terms: { title: 'Terms of Service', html: `
    <h1>Terms of Service</h1>
    <p class="muted">Last updated ${LEGAL_EFFECTIVE}</p>
    <p>Welcome to BusinessTinder, a professional networking and matching service. By creating an account or using the service you agree to these terms.</p>
    <h3>1. Eligibility &amp; accounts</h3>
    <p>You must be at least 18 and provide accurate profile information. You are responsible for activity under your account and for keeping your credentials secure.</p>
    <h3>2. Acceptable use</h3>
    <p>No harassment, spam, fraud, impersonation, or unlawful, sexual, or abusive content. We may moderate, suspend, or remove accounts that violate these rules.</p>
    <h3>3. Content</h3>
    <p>You retain ownership of what you post but grant us a licence to display it within the service. Don't upload content you don't have the rights to.</p>
    <h3>4. Paid plans</h3>
    <p>Optional PRO features may be offered. Pricing and billing terms are presented at the point of purchase.</p>
    <h3>5. Disclaimers</h3>
    <p>The service is provided "as is". We don't guarantee matches, outcomes, or uninterrupted availability.</p>
    <h3>6. Termination</h3>
    <p>You may delete your account at any time in Settings. We may suspend access for violations of these terms.</p>
    <h3>7. Contact</h3>
    <p>Questions: <a href="mailto:support@businesstinder.app">support@businesstinder.app</a>.</p>
    <p class="muted">This is a general template and not legal advice; have counsel review before relying on it in production.</p>` },
  privacy: { title: 'Privacy Policy', html: `
    <h1>Privacy Policy</h1>
    <p class="muted">Last updated ${LEGAL_EFFECTIVE}</p>
    <p>This policy explains what BusinessTinder collects and how it's used.</p>
    <h3>1. Data we collect</h3>
    <p>Account details (name, email), profile content you provide (headline, bio, photos, links), and activity such as swipes, matches, and messages. We store approximate location only if you provide a location.</p>
    <h3>2. How we use it</h3>
    <p>To operate matching and chat, secure the service, prevent abuse, and send transactional emails (verification, password reset, and — unless you opt out — match/message notifications).</p>
    <h3>3. Sharing</h3>
    <p>Your profile is visible to other users as part of matching. We use processors for email delivery, image hosting, and (optionally) push notifications. We don't sell your personal data.</p>
    <h3>4. Your choices</h3>
    <p>You can edit your profile, opt out of activity emails (Settings or any email's unsubscribe link), and permanently delete your account and associated data from Settings.</p>
    <h3>5. Retention &amp; security</h3>
    <p>We keep data while your account is active and remove it on deletion. We apply reasonable safeguards but no system is perfectly secure.</p>
    <h3>6. Contact</h3>
    <p>Privacy questions: <a href="mailto:privacy@businesstinder.app">privacy@businesstinder.app</a>.</p>
    <p class="muted">This is a general template and not legal advice; have counsel review before relying on it in production.</p>` },
};
function serveLegal(key) {
  return (_req, res) => {
    const doc = LEGAL[key];
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(staticPage(doc.title, doc.html));
  };
}
app.get('/legal/terms', serveLegal('terms'));
app.get('/legal/privacy', serveLegal('privacy'));

// Public profile page (server-rendered, no auth)
app.get('/u/:slug', async (req, res) => {
  const p = await findProfileBySlug(req.params.slug);
  if (!p) return res.status(404).send('Not found');
  const user = await findUserById(p.userId);
  const safe = escapeHtml;
  const tags = (arr) => (arr || []).map((t) => `<li>${safe(t)}</li>`).join('');
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: user?.fullName,
    jobTitle: p.headline,
    address: { '@type': 'PostalAddress', addressLocality: p.location },
    image: p.photoUrl || user?.avatarUrl || undefined,
    sameAs: p.linkedinUrl ? [p.linkedinUrl] : undefined,
    description: p.bio,
  };
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safe(user?.fullName || 'BusinessTinder profile')} · BusinessTinder</title>
<link rel="icon" type="image/svg+xml" href="/icon.svg" />
<link rel="stylesheet" href="/styles.css" />
<meta name="description" content="${safe(p.headline)} — ${safe(p.bio).slice(0, 140)}" />
<meta property="og:type" content="profile" />
<meta property="og:title" content="${safe(user?.fullName)} · BusinessTinder" />
<meta property="og:description" content="${safe(p.headline)}" />
<meta property="og:image" content="${safe(p.photoUrl || user?.avatarUrl || '')}" />
<meta name="twitter:card" content="summary_large_image" />
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
</head><body><div class="app-shell"><main class="glass pad public-card center">
<img class="public-avatar" src="${safe(p.photoUrl || user?.avatarUrl || '')}" alt="" />
<h1>${safe(user?.fullName || '')}</h1>
<p class="role">${safe(p.headline)}</p>
<p class="meta">${safe(p.userType)} · ${safe(p.stage)} · ${safe(p.location)}${p.remoteOk ? ' · Remote OK' : ''}</p>
<p style="margin:14px 0;">${safe(p.bio)}</p>
<ul class="tags" style="justify-content:center;">${tags(p.industries)}</ul>
<ul class="tags" style="justify-content:center;">${tags(p.skills)}</ul>
<a class="primary" style="display:inline-block;margin-top:18px;padding:14px 22px;text-decoration:none;border-radius:14px;" href="/?invite=${safe(user?.referralCode || '')}">Connect with ${safe((user?.fullName || '').split(' ')[0] || 'them')} on BusinessTinder</a>
</main></div></body></html>`);
});

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
app.use(express.static(STATIC_ROOT, {
  index: 'index.html',
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (STATIC_MIME[ext]) res.setHeader('Content-Type', STATIC_MIME[ext]);
    // The HTML shell and core JS/CSS change in place on deploy (no content
    // hashing), so revalidate them every load via ETag (cheap 304s). Truly
    // static media can be cached for a day.
    if (['.html', '.js', '.css'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, no-cache');
    } else if (['.svg', '.png', '.ico', '.webmanifest'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  },
}));

// Final JSON 404 for any /api-shaped request that didn't match a route or a
// static file. Without this, unmatched POSTs return Express's text 404
// ("Cannot POST /...") which the client can't usefully parse.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
});

// JSON error handler. Must be the last middleware. Catches both sync throws
// and async rejections from the route handlers (Express 4 only forwards
// rejections to here when the route awaits with an explicit `next(err)`,
// but we also wire process-level catchers below for safety).
app.use((err, req, res, _next) => {
  console.error('[error]', req.id, req.method, req.path, '—', err?.stack || err);
  reportError(err, { requestId: req.id, method: req.method, path: req.path });
  if (res.headersSent) return;
  res.status(err.status || 500).json({
    error: err.publicMessage || err.message || 'Server error',
    requestId: req.id,
  });
});

// Last-ditch safety net. unhandledRejection is logged but tolerated (we want
// the server to keep serving other requests). uncaughtException leaves the
// process in an undefined state — log and exit so the orchestrator restarts
// us cleanly.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  reportError(err, { kind: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  reportError(err, { kind: 'uncaughtException' });
  process.exit(1);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  // Accept the URL-token form for backwards compat, but prefer an `auth` message handshake
  // so the token doesn't end up in proxy/access logs.
  const urlToken = new URL(req.url, 'http://localhost').searchParams.get('token');
  let payload = null;
  if (urlToken) {
    try {
      const p = jwt.verify(urlToken, JWT_SECRET);
      if (!p.purpose) payload = p; // reject step-up (mfa) tokens
    } catch { /* fall through to handshake */ }
  }
  if (payload) { addWsClient(payload.userId, ws); presenceAdd(payload.userId); }

  // If no URL token, give the client a brief window to send `{ type: 'auth', token }`.
  const handshakeTimer = setTimeout(() => {
    if (!payload) ws.close(1008, 'auth-timeout');
  }, 5000);

  ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      if (!payload && data.type === 'auth') {
        try {
          const p = jwt.verify(data.token, JWT_SECRET);
          if (p.purpose) { ws.close(1008, 'invalid-token'); return; } // reject step-up tokens
          payload = p;
          clearTimeout(handshakeTimer);
          addWsClient(payload.userId, ws);
          presenceAdd(payload.userId);
          ws.send(JSON.stringify({ type: 'auth_ok' }));
        } catch {
          ws.close(1008, 'invalid-token');
        }
        return;
      }
      if (!payload) return; // ignore everything pre-auth

      const userId = payload.userId;

      if (data.type === 'send_message') {
        const { conversationId, body, kind } = data;
        if (!body) return ws.send(JSON.stringify({ type: 'error', error: 'Empty message' }));
        const safeKind = ['text', 'image'].includes(kind) ? kind : 'text';
        if (safeKind === 'image') {
          const mod = moderateImage(body);
          if (!mod.ok) {
            return ws.send(JSON.stringify({ type: 'error', error: `Image rejected: ${mod.reason}` }));
          }
        } else {
          const mod = moderateText(body);
          if (!mod.ok) {
            return ws.send(JSON.stringify({ type: 'error', error: `Blocked: ${mod.reason}` }));
          }
        }
        const sender = await findUserById(userId);
        if (isBanned(sender)) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Account suspended' }));
        }
        if (!(await canAccessConversation(userId, conversationId))) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Forbidden conversation' }));
        }
        // Never trust a client-supplied recipient: derive the other party from
        // the conversation so a sender can't deliver/notify an arbitrary user.
        const toUserId = await otherUserInConversation(userId, conversationId);
        if (!toUserId) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Forbidden conversation' }));
        }
        if (await isBlocked(userId, toUserId)) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Blocked' }));
        }
        let saved;
        if (prisma) {
          saved = await prisma.message.create({
            data: { conversationId, senderId: userId, body, kind: safeKind, status: 'DELIVERED' },
          });
        } else {
          saved = {
            id: crypto.randomUUID(), conversationId, senderId: userId, body, kind: safeKind,
            status: 'DELIVERED', createdAt: new Date().toISOString(),
          };
          mem.messages.push(saved);
        }
        ws.send(JSON.stringify({ type: 'message_ack', messageId: saved.id, status: 'DELIVERED' }));
        const preview = safeKind === 'image' ? '📷 Photo' : String(body).slice(0, 80);
        sendToUser(toUserId, { type: 'message', message: saved });
        // Only fall back to push/email when the recipient isn't connected to
        // any instance (sendToUser already fanned out to remote nodes).
        if (!(await isUserConnected(toUserId))) {
          pushToUser(toUserId, { title: 'New message', body: preview });
          // Email digest fallback when recipient isn't online — throttled
          // per conversation so an active thread doesn't spam them.
          if (shouldEmailMessage(toUserId, conversationId)) {
            const recipient = await findUserById(toUserId);
            const sender = await findUserById(userId);
            if (recipient?.email && sender && wantsActivityEmail(recipient)) {
              sendMessageDigestEmail(recipient.email, recipient.fullName, sender.fullName, preview, unsubscribePath(recipient.id)).catch(() => {});
            }
          }
        }
      }

      if (data.type === 'typing') {
        const { conversationId, toUserId } = data;
        if (!(await canAccessConversation(userId, conversationId))) return;
        sendToUser(toUserId, { type: 'typing', conversationId, fromUserId: userId });
      }

      if (data.type === 'read_message') {
        const { messageId } = data;
        let senderId = null;
        let conversationId = null;
        if (prisma) {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg || !(await canAccessConversation(userId, msg.conversationId))) return;
          await prisma.message.update({ where: { id: messageId }, data: { status: 'READ' } });
          senderId = msg.senderId; conversationId = msg.conversationId;
        } else {
          const msg = mem.messages.find((m) => m.id === messageId);
          if (!msg || !(await canAccessConversation(userId, msg.conversationId))) return;
          msg.status = 'READ';
          senderId = msg.senderId; conversationId = msg.conversationId;
        }
        ws.send(JSON.stringify({ type: 'read_ack', messageId }));
        // Notify the author so their "Read" receipt updates live.
        if (senderId && senderId !== userId) {
          sendToUser(senderId, { type: 'read', conversationId, messageId, at: new Date().toISOString() });
        }
      }
    });

  ws.on('close', () => {
    clearTimeout(handshakeTimer);
    if (payload) {
      const wasLast = removeWsClient(payload.userId, ws);
      if (wasLast) presenceRemove(payload.userId);
    }
  });
});

// Bring up cross-instance fan-out (no-op unless REDIS_URL is set). Remote
// deliveries are handed to the local-only sender to avoid a publish loop.
initCluster((userId, payload) => localSendToUser(userId, payload)).catch((e) =>
  console.warn('[cluster] init error:', e?.message),
);

const PORT = process.env.PORT || 4000;
const isMain = (() => {
  try {
    return fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();
if (isMain) {
  server.listen(PORT, () =>
    console.log(`Backend running on :${PORT} (${prisma ? 'postgres' : 'memory'}${googleClient ? ', google' : ''}${webpush ? ', push' : ''})`),
  );
}

export { app, server };
