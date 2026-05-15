import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OAuth2Client } from 'google-auth-library';
import { scoreProfile, rankProfiles, diversify } from './scoring.js';
import { moderateText } from './moderation.js';
import { suggestIcebreakers } from './icebreakers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_ROOT = path.resolve(__dirname, '..', '..');

let PrismaClient = null;
try {
  ({ PrismaClient } = await import('@prisma/client'));
} catch {
  // @prisma/client is optional; backend falls back to in-memory storage when missing.
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '4mb' })); // big enough for a small photo dataURL

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:noreply@businesstinder.app';
const FREE_DAILY_SWIPES = Number(process.env.FREE_DAILY_SWIPES || 30);
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
};
const wsClients = new Map();

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl || null,
    planTier: user.planTier || 'FREE',
    referralCode: user.referralCode || null,
  };
}

function sign(user, extra = {}) {
  return jwt.sign({ userId: user.id, email: user.email, ...extra }, JWT_SECRET, { expiresIn: '7d' });
}

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function randomCode(n = 8) {
  return crypto.randomBytes(n).toString('base64url').slice(0, n);
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

app.get('/auth/config', (_req, res) => {
  res.json({
    googleClientId: GOOGLE_CLIENT_ID || null,
    vapidPublicKey: VAPID_PUBLIC || null,
    freeDailySwipes: FREE_DAILY_SWIPES,
  });
});

app.post('/auth/register', async (req, res) => {
  const { email, password, fullName, referredBy } = req.body || {};
  if (!email || !password || !fullName) return res.status(400).json({ error: 'Missing fields' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const passwordHash = await bcrypt.hash(password, 10);
  const referralCode = randomCode(8);
  let user;
  if (prisma) {
    user = await prisma.user.create({ data: { email, passwordHash, fullName, referralCode, referredBy: referredBy || null } });
  } else {
    user = {
      id: crypto.randomUUID(), email, passwordHash, fullName, avatarUrl: null,
      planTier: 'FREE', referralCode, referredBy: referredBy || null,
      swipesToday: 0, lastSwipeDay: null,
    };
    mem.users.push(user);
  }
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Missing fields' });
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user), user: publicUser(user) });
});

app.post('/auth/google', async (req, res) => {
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
  res.json({ token: sign(user), user: publicUser(user) });
});

app.get('/me', auth, async (req, res) => {
  const user = await findUserById(req.user.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const updated = await ensureReferralCode(user);
  const profile = await findProfileByUserId(user.id);
  res.json({ user: publicUser(updated), profile: profile || null });
});

const PROFILE_FIELDS = [
  'headline', 'userType', 'lookingFor', 'bio', 'stage', 'industries', 'skills',
  'location', 'remoteOk', 'commitment', 'linkedinUrl', 'avatarUrl', 'photoUrl',
  'videoIntroUrl', 'pastCompanies', 'hoursPerWeek', 'calLink', 'pitchDeckUrl',
];
function sanitizeProfile(body) {
  const out = {};
  for (const k of PROFILE_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  if (Array.isArray(out.lookingFor)) out.lookingFor = out.lookingFor.slice(0, 5);
  if (Array.isArray(out.industries)) out.industries = out.industries.slice(0, 6);
  if (Array.isArray(out.skills)) out.skills = out.skills.slice(0, 8);
  if (Array.isArray(out.pastCompanies)) out.pastCompanies = out.pastCompanies.slice(0, 6);
  if (out.hoursPerWeek != null) out.hoursPerWeek = Math.max(0, Math.min(80, Number(out.hoursPerWeek) || 0));
  if (typeof out.bio === 'string') {
    const mod = moderateText(out.bio);
    if (!mod.ok) return { error: `Bio rejected: ${mod.reason}` };
  }
  return out;
}

app.post('/profiles', auth, async (req, res) => {
  const result = sanitizeProfile(req.body || {});
  if (result.error) return res.status(400).json({ error: result.error });
  const data = result;
  if (!data.userType) return res.status(400).json({ error: 'userType is required' });
  if (!data.headline) return res.status(400).json({ error: 'headline is required' });
  const user = await findUserById(req.user.userId);
  const existing = await findProfileByUserId(req.user.userId);
  const slug = existing?.slug || (await uniqueSlug(slugify(user.fullName)));

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
  const profile = { id: crypto.randomUUID(), userId: req.user.userId, slug, ...data, lastActiveAt: new Date().toISOString() };
  mem.profiles.push(profile);
  res.json(profile);
});

app.get('/profiles/me', auth, async (req, res) => {
  res.json((await findProfileByUserId(req.user.userId)) || null);
});

app.get('/discover', auth, async (req, res) => {
  const mine = req.user.userId;
  const meProfile = await findProfileByUserId(mine);
  const filters = {
    stage: req.query.stage || null,
    lookingFor: req.query.lookingFor || null,
    location: req.query.location ? String(req.query.location).toLowerCase() : null,
    industry: req.query.industry && req.query.industry !== 'all' ? req.query.industry : null,
  };

  let candidates;
  if (prisma) {
    const swiped = await prisma.swipe.findMany({ where: { fromUserId: mine }, select: { toUserId: true } });
    const blocks = await prisma.block.findMany({
      where: { OR: [{ blockerId: mine }, { targetId: mine }] },
    });
    const excludeIds = [mine, ...swiped.map((s) => s.toUserId), ...blocks.map((b) => (b.blockerId === mine ? b.targetId : b.blockerId))];
    candidates = await prisma.profile.findMany({
      where: { userId: { notIn: excludeIds } },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
  } else {
    const swiped = new Set(mem.swipes.filter((s) => s.fromUserId === mine).map((s) => s.toUserId));
    const blocked = new Set();
    for (const b of mem.blocks) {
      if (b.blockerId === mine) blocked.add(b.targetId);
      if (b.targetId === mine) blocked.add(b.blockerId);
    }
    candidates = mem.profiles
      .filter((p) => p.userId !== mine && !swiped.has(p.userId) && !blocked.has(p.userId))
      .map((p) => {
        const u = mem.users.find((u) => u.id === p.userId);
        return { ...p, user: { fullName: u?.fullName, avatarUrl: u?.avatarUrl } };
      });
  }

  let filtered = candidates;
  if (filters.stage) filtered = filtered.filter((p) => p.stage === filters.stage);
  if (filters.lookingFor) filtered = filtered.filter((p) => (p.lookingFor || []).includes(filters.lookingFor));
  if (filters.industry) filtered = filtered.filter((p) => (p.industries || []).includes(filters.industry));
  if (filters.location) filtered = filtered.filter((p) => (p.location || '').toLowerCase().includes(filters.location));

  const ranked = diversify(rankProfiles(meProfile, filtered));
  const out = ranked.map(({ profile, score, reasons }) => ({
    ...profile,
    fullName: profile.user?.fullName,
    avatarUrl: profile.photoUrl || profile.avatarUrl || profile.user?.avatarUrl,
    matchScore: score,
    matchReasons: reasons,
  }));
  res.json(out);
});

app.get('/search', auth, async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const matches = (arr) =>
    arr.filter((p) => {
      const hay = [
        p.headline, p.bio, p.location, p.user?.fullName,
        (p.industries || []).join(' '),
        (p.skills || []).join(' '),
        (p.pastCompanies || []).join(' '),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });

  let pool;
  if (prisma) {
    pool = await prisma.profile.findMany({
      where: { userId: { not: req.user.userId } },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
  } else {
    pool = mem.profiles
      .filter((p) => p.userId !== req.user.userId)
      .map((p) => ({ ...p, user: { fullName: mem.users.find((u) => u.id === p.userId)?.fullName } }));
  }
  res.json(
    matches(pool).slice(0, 50).map((p) => ({
      ...p,
      fullName: p.user?.fullName,
      avatarUrl: p.photoUrl || p.avatarUrl || p.user?.avatarUrl,
    })),
  );
});

app.post('/swipes', auth, async (req, res) => {
  const { toUserId, direction } = req.body || {};
  const fromUserId = req.user.userId;
  if (!['LEFT', 'RIGHT'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });
  if (await isBlocked(fromUserId, toUserId)) return res.status(403).json({ error: 'Blocked' });

  // Daily quota for FREE plan.
  const user = await findUserById(fromUserId);
  if (user?.planTier !== 'PRO') {
    const today = todayKey();
    const day = user.lastSwipeDay || null;
    const count = day === today ? user.swipesToday || 0 : 0;
    if (count >= FREE_DAILY_SWIPES) {
      return res.status(429).json({ error: 'Daily free swipe limit reached. Upgrade to Pro.', limit: FREE_DAILY_SWIPES });
    }
    if (prisma) {
      await prisma.user.update({ where: { id: fromUserId }, data: { swipesToday: count + 1, lastSwipeDay: today } });
    } else {
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
      where: { fromUserId: toUserId, toUserId: fromUserId, direction: 'RIGHT' },
    });
    if (direction === 'RIGHT' && reciprocal) {
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
      return res.json({ matched: true, match, conversation, icebreakers: suggestIcebreakers(theirProfile), theirIcebreakers: suggestIcebreakers(myProfile) });
    }
    return res.json({ matched: false });
  }

  mem.swipes = mem.swipes.filter((s) => !(s.fromUserId === fromUserId && s.toUserId === toUserId));
  mem.swipes.push({ id: crypto.randomUUID(), fromUserId, toUserId, direction });
  const reciprocal = mem.swipes.find(
    (s) => s.fromUserId === toUserId && s.toUserId === fromUserId && s.direction === 'RIGHT',
  );
  if (direction === 'RIGHT' && reciprocal) {
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
  const isPro = user?.planTier === 'PRO';
  if (!isPro) return res.json({ count: likers.length, profiles: null, locked: true });

  let profiles;
  if (prisma) {
    profiles = await prisma.profile.findMany({
      where: { userId: { in: likers.map((l) => l.fromUserId) } },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
  } else {
    profiles = mem.profiles
      .filter((p) => likers.some((l) => l.fromUserId === p.userId))
      .map((p) => ({ ...p, user: { fullName: mem.users.find((u) => u.id === p.userId)?.fullName } }));
  }
  res.json({
    count: likers.length,
    locked: false,
    profiles: profiles.map((p) => ({ ...p, fullName: p.user?.fullName, avatarUrl: p.photoUrl || p.avatarUrl || p.user?.avatarUrl })),
  });
});

app.get('/matches', auth, async (req, res) => {
  const userId = req.user.userId;
  if (prisma) {
    const matches = await prisma.match.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } });
    const otherIds = matches.map((m) => (m.userAId === userId ? m.userBId : m.userAId));
    const others = await prisma.user.findMany({ where: { id: { in: otherIds } }, include: { profile: true } });
    const convs = await prisma.conversation.findMany({ where: { matchId: { in: matches.map((m) => m.id) } } });
    return res.json(
      matches.map((m) => {
        const otherId = m.userAId === userId ? m.userBId : m.userAId;
        const other = others.find((u) => u.id === otherId);
        return {
          ...m,
          other: other
            ? { id: other.id, fullName: other.fullName, avatarUrl: other.profile?.photoUrl || other.avatarUrl, profile: other.profile }
            : null,
          conversation: convs.find((c) => c.matchId === m.id) || null,
        };
      }),
    );
  }
  const matches = mem.matches.filter((m) => m.userAId === userId || m.userBId === userId);
  res.json(
    matches.map((m) => {
      const otherId = m.userAId === userId ? m.userBId : m.userAId;
      const user = mem.users.find((u) => u.id === otherId);
      const profile = mem.profiles.find((p) => p.userId === otherId);
      const conversation = mem.conversations.find((c) => c.matchId === m.id);
      return {
        ...m,
        other: user ? { id: user.id, fullName: user.fullName, avatarUrl: profile?.photoUrl || user.avatarUrl, profile } : null,
        conversation,
      };
    }),
  );
});

app.get('/messages/:conversationId', auth, async (req, res) => {
  const { conversationId } = req.params;
  if (!(await canAccessConversation(req.user.userId, conversationId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (prisma) return res.json(await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }));
  res.json(mem.messages.filter((m) => m.conversationId === conversationId));
});

app.post('/messages/:conversationId', auth, async (req, res) => {
  const { conversationId } = req.params;
  const { body, kind } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Missing body' });
  const mod = moderateText(body);
  if (!mod.ok) return res.status(400).json({ error: `Message blocked: ${mod.reason}` });
  if (!(await canAccessConversation(req.user.userId, conversationId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  let saved;
  if (prisma) {
    saved = await prisma.message.create({
      data: { conversationId, senderId: req.user.userId, body, kind: kind || 'text', status: 'SENT' },
    });
  } else {
    saved = {
      id: crypto.randomUUID(), conversationId, senderId: req.user.userId, body, kind: kind || 'text',
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
    profiles = mem.profiles
      .filter((p) => ids.includes(p.userId))
      .map((p) => ({ ...p, user: { fullName: mem.users.find((u) => u.id === p.userId)?.fullName } }));
  }
  res.json(profiles.map((p) => ({ ...p, fullName: p.user?.fullName, avatarUrl: p.photoUrl || p.avatarUrl || p.user?.avatarUrl })));
});

app.post('/blocks', auth, async (req, res) => {
  const meId = req.user.userId;
  const target = req.body?.targetId;
  if (!target) return res.status(400).json({ error: 'targetId required' });
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
  if (prisma) {
    await prisma.report.create({ data: { reporterId: meId, targetId, reason: reason || null } });
    await prisma.block.upsert({
      where: { blockerId_targetId: { blockerId: meId, targetId } },
      update: {}, create: { blockerId: meId, targetId },
    });
  } else {
    mem.reports.push({ id: crypto.randomUUID(), reporterId: meId, targetId, reason: reason || null, createdAt: new Date().toISOString() });
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

app.post('/plan/upgrade', auth, async (req, res) => {
  // Real Stripe wiring goes here. For now, flip the flag.
  if (prisma) await prisma.user.update({ where: { id: req.user.userId }, data: { planTier: 'PRO' } });
  else {
    const u = mem.users.find((u) => u.id === req.user.userId);
    if (u) u.planTier = 'PRO';
  }
  res.json({ ok: true, planTier: 'PRO' });
});

app.post('/referrals/redeem', auth, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code required' });
  let inviter;
  if (prisma) inviter = await prisma.user.findUnique({ where: { referralCode: code } });
  else inviter = mem.users.find((u) => u.referralCode === code);
  if (!inviter) return res.status(404).json({ error: 'Invalid code' });
  if (inviter.id === req.user.userId) return res.status(400).json({ error: 'Cannot redeem your own code' });
  if (prisma) await prisma.user.update({ where: { id: req.user.userId }, data: { referredBy: inviter.id } });
  else {
    const me = mem.users.find((u) => u.id === req.user.userId);
    if (me) me.referredBy = inviter.id;
  }
  res.json({ ok: true, inviter: { fullName: inviter.fullName } });
});

app.get('/icebreakers', auth, async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const them = await findProfileByUserId(userId);
  res.json({ prompts: suggestIcebreakers(them) });
});

// Public profile page (server-rendered, no auth)
app.get('/u/:slug', async (req, res) => {
  const p = await findProfileBySlug(req.params.slug);
  if (!p) return res.status(404).send('Not found');
  const user = await findUserById(p.userId);
  const safe = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tags = (arr) => (arr || []).map((t) => `<li>${safe(t)}</li>`).join('');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safe(user?.fullName || 'BusinessTinder profile')}</title>
<link rel="stylesheet" href="/styles.css" />
<meta property="og:title" content="${safe(user?.fullName)} · BusinessTinder" />
<meta property="og:description" content="${safe(p.headline)}" />
</head><body><div class="app-shell"><main class="glass pad public-card">
<img class="public-avatar" src="${safe(p.photoUrl || user?.avatarUrl || '')}" alt="" />
<h1>${safe(user?.fullName || '')}</h1>
<p class="role">${safe(p.headline)}</p>
<p class="meta">${safe(p.userType)} · ${safe(p.stage)} · ${safe(p.location)}${p.remoteOk ? ' · Remote OK' : ''}</p>
<p>${safe(p.bio)}</p>
<ul class="tags">${tags(p.industries)}</ul>
<ul class="tags">${tags(p.skills)}</ul>
<p><a class="primary" href="/">Join BusinessTinder to connect</a></p>
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
  },
}));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    wsClients.set(payload.userId, ws);

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      const userId = payload.userId;

      if (data.type === 'send_message') {
        const { conversationId, toUserId, body, kind } = data;
        const mod = moderateText(body);
        if (!mod.ok) {
          return ws.send(JSON.stringify({ type: 'error', error: `Blocked: ${mod.reason}` }));
        }
        if (!(await canAccessConversation(userId, conversationId))) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Forbidden conversation' }));
        }
        let saved;
        if (prisma) {
          saved = await prisma.message.create({
            data: { conversationId, senderId: userId, body, kind: kind || 'text', status: 'DELIVERED' },
          });
        } else {
          saved = {
            id: crypto.randomUUID(), conversationId, senderId: userId, body, kind: kind || 'text',
            status: 'DELIVERED', createdAt: new Date().toISOString(),
          };
          mem.messages.push(saved);
        }
        ws.send(JSON.stringify({ type: 'message_ack', messageId: saved.id, status: 'DELIVERED' }));
        const target = wsClients.get(toUserId);
        if (target) target.send(JSON.stringify({ type: 'message', message: saved }));
        else pushToUser(toUserId, { title: 'New message', body: body.slice(0, 80) });
      }

      if (data.type === 'typing') {
        const { conversationId, toUserId } = data;
        if (!(await canAccessConversation(userId, conversationId))) return;
        const target = wsClients.get(toUserId);
        if (target) target.send(JSON.stringify({ type: 'typing', conversationId, fromUserId: userId }));
      }

      if (data.type === 'read_message') {
        const { messageId } = data;
        if (prisma) {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg || !(await canAccessConversation(userId, msg.conversationId))) return;
          await prisma.message.update({ where: { id: messageId }, data: { status: 'READ' } });
        } else {
          const msg = mem.messages.find((m) => m.id === messageId);
          if (!msg || !(await canAccessConversation(userId, msg.conversationId))) return;
          msg.status = 'READ';
        }
        ws.send(JSON.stringify({ type: 'read_ack', messageId }));
      }
    });

    ws.on('close', () => wsClients.delete(payload.userId));
  } catch {
    ws.close();
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () =>
  console.log(`Backend running on :${PORT} (${prisma ? 'postgres' : 'memory'}${googleClient ? ', google' : ''}${webpush ? ', push' : ''})`),
);

export { app, server };
