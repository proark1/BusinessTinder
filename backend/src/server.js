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
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL || process.env.RAILWAY_DATABASE_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
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
if (!googleClient) console.warn('[warn] GOOGLE_CLIENT_ID not set — Google login will be disabled.');

const mem = { users: [], profiles: [], swipes: [], matches: [], conversations: [], messages: [] };
const clients = new Map();

function publicUser(user) {
  return { id: user.id, email: user.email, fullName: user.fullName, avatarUrl: user.avatarUrl || null };
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

app.get('/health', async (_req, res) => {
  let dbOk = !prisma; // memory mode counts as ok
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
  });
});

app.get('/auth/config', (_req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

app.post('/auth/register', async (req, res) => {
  const { email, password, fullName } = req.body || {};
  if (!email || !password || !fullName) return res.status(400).json({ error: 'Missing fields' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password too short (min 6)' });
  const existing = await findUserByEmail(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });
  const passwordHash = await bcrypt.hash(password, 10);
  let user;
  if (prisma) {
    user = await prisma.user.create({ data: { email, passwordHash, fullName } });
  } else {
    user = { id: crypto.randomUUID(), email, passwordHash, fullName, avatarUrl: null };
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
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Missing credential' });
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
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
        data: { email, fullName, googleSub, avatarUrl, passwordHash: '' },
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
      user = { id: crypto.randomUUID(), email, fullName, googleSub, avatarUrl, passwordHash: '' };
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
  const profile = await findProfileByUserId(user.id);
  res.json({ user: publicUser(user), profile: profile || null });
});

const PROFILE_FIELDS = [
  'headline', 'userType', 'lookingFor', 'bio', 'stage',
  'industries', 'skills', 'location', 'remoteOk', 'commitment', 'linkedinUrl', 'avatarUrl',
];

function sanitizeProfile(body) {
  const out = {};
  for (const k of PROFILE_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (Array.isArray(out.lookingFor)) out.lookingFor = out.lookingFor.slice(0, 5);
  if (Array.isArray(out.industries)) out.industries = out.industries.slice(0, 6);
  if (Array.isArray(out.skills)) out.skills = out.skills.slice(0, 8);
  return out;
}

app.post('/profiles', auth, async (req, res) => {
  const data = sanitizeProfile(req.body || {});
  if (!data.userType) return res.status(400).json({ error: 'userType is required' });
  if (!data.headline) return res.status(400).json({ error: 'headline is required' });
  if (prisma) {
    const profile = await prisma.profile.upsert({
      where: { userId: req.user.userId },
      update: data,
      create: { userId: req.user.userId, ...data },
    });
    return res.json(profile);
  }
  const existing = mem.profiles.find((p) => p.userId === req.user.userId);
  if (existing) {
    Object.assign(existing, data);
    return res.json(existing);
  }
  const profile = { id: crypto.randomUUID(), userId: req.user.userId, ...data };
  mem.profiles.push(profile);
  res.json(profile);
});

app.get('/profiles/me', auth, async (req, res) => {
  const profile = await findProfileByUserId(req.user.userId);
  res.json(profile || null);
});

app.get('/discover', auth, async (req, res) => {
  const mine = req.user.userId;
  if (prisma) {
    const swiped = await prisma.swipe.findMany({ where: { fromUserId: mine }, select: { toUserId: true } });
    const blocked = swiped.map((s) => s.toUserId);
    const profiles = await prisma.profile.findMany({
      where: { userId: { notIn: [mine, ...blocked] } },
      include: { user: { select: { fullName: true, avatarUrl: true } } },
    });
    return res.json(profiles.map((p) => ({ ...p, fullName: p.user.fullName, avatarUrl: p.avatarUrl || p.user.avatarUrl })));
  }
  const swiped = new Set(mem.swipes.filter((s) => s.fromUserId === mine).map((s) => s.toUserId));
  const profiles = mem.profiles
    .filter((p) => p.userId !== mine && !swiped.has(p.userId))
    .map((p) => {
      const u = mem.users.find((u) => u.id === p.userId);
      return { ...p, fullName: u?.fullName, avatarUrl: p.avatarUrl || u?.avatarUrl || null };
    });
  res.json(profiles);
});

app.post('/swipes', auth, async (req, res) => {
  const { toUserId, direction } = req.body || {};
  const fromUserId = req.user.userId;
  if (!['LEFT', 'RIGHT'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });

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
        update: {},
        create: { userAId: a, userBId: b },
      });
      const conversation = await prisma.conversation.upsert({
        where: { matchId: match.id },
        update: {},
        create: { matchId: match.id },
      });
      return res.json({ matched: true, match, conversation });
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
    return res.json({ matched: true, match, conversation });
  }
  res.json({ matched: false });
});

app.get('/matches', auth, async (req, res) => {
  const userId = req.user.userId;
  if (prisma) {
    const matches = await prisma.match.findMany({
      where: { OR: [{ userAId: userId }, { userBId: userId }] },
    });
    const otherIds = matches.map((m) => (m.userAId === userId ? m.userBId : m.userAId));
    const others = await prisma.user.findMany({
      where: { id: { in: otherIds } },
      include: { profile: true },
    });
    return res.json(
      matches.map((m) => {
        const otherId = m.userAId === userId ? m.userBId : m.userAId;
        const other = others.find((u) => u.id === otherId);
        const conv = null;
        return {
          ...m,
          other: other ? { id: other.id, fullName: other.fullName, avatarUrl: other.avatarUrl, profile: other.profile } : null,
          conversation: conv,
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
        other: user ? { id: user.id, fullName: user.fullName, avatarUrl: user.avatarUrl, profile } : null,
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
  if (prisma) {
    return res.json(await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }));
  }
  res.json(mem.messages.filter((m) => m.conversationId === conversationId));
});

app.post('/messages/:conversationId', auth, async (req, res) => {
  const { conversationId } = req.params;
  const { body } = req.body || {};
  if (!body) return res.status(400).json({ error: 'Missing body' });
  if (!(await canAccessConversation(req.user.userId, conversationId))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  let saved;
  if (prisma) {
    saved = await prisma.message.create({
      data: { conversationId, senderId: req.user.userId, body, status: 'SENT' },
    });
  } else {
    saved = {
      id: crypto.randomUUID(),
      conversationId,
      senderId: req.user.userId,
      body,
      status: 'SENT',
      createdAt: new Date().toISOString(),
    };
    mem.messages.push(saved);
  }
  res.json(saved);
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
app.use(
  express.static(STATIC_ROOT, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (STATIC_MIME[ext]) res.setHeader('Content-Type', STATIC_MIME[ext]);
    },
  }),
);

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    clients.set(payload.userId, ws);

    ws.on('message', async (raw) => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.type === 'send_message') {
        const { conversationId, toUserId, body } = data;
        if (!(await canAccessConversation(payload.userId, conversationId))) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Forbidden conversation' }));
        }
        let saved;
        if (prisma) {
          saved = await prisma.message.create({
            data: { conversationId, senderId: payload.userId, body, status: 'DELIVERED' },
          });
        } else {
          saved = {
            id: crypto.randomUUID(),
            conversationId,
            senderId: payload.userId,
            body,
            status: 'DELIVERED',
            createdAt: new Date().toISOString(),
          };
          mem.messages.push(saved);
        }
        ws.send(JSON.stringify({ type: 'message_ack', messageId: saved.id, status: 'DELIVERED' }));
        const target = clients.get(toUserId);
        if (target) target.send(JSON.stringify({ type: 'message', message: saved }));
      }

      if (data.type === 'read_message') {
        const { messageId } = data;
        if (prisma) {
          const msg = await prisma.message.findUnique({ where: { id: messageId } });
          if (!msg || !(await canAccessConversation(payload.userId, msg.conversationId))) return;
          await prisma.message.update({ where: { id: messageId }, data: { status: 'READ' } });
        } else {
          const msg = mem.messages.find((m) => m.id === messageId);
          if (!msg || !(await canAccessConversation(payload.userId, msg.conversationId))) return;
          msg.status = 'READ';
        }
        ws.send(JSON.stringify({ type: 'read_ack', messageId }));
      }
    });

    ws.on('close', () => clients.delete(payload.userId));
  } catch {
    ws.close();
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () =>
  console.log(`Backend running on :${PORT} (${prisma ? 'postgres' : 'memory'}${googleClient ? ', google' : ''})`),
);

export { app, server };
