import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { PrismaClient } from '@prisma/client';

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL;
const prisma = DATABASE_URL ? new PrismaClient() : null;
const mem = { users: [], profiles: [], swipes: [], matches: [], conversations: [], messages: [] };
const clients = new Map();

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

app.get('/health', (_, res) => res.json({ ok: true, mode: prisma ? 'postgres' : 'memory' }));

app.post('/auth/register', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password || !fullName) return res.status(400).json({ error: 'Missing fields' });
  const passwordHash = await bcrypt.hash(password, 10);
  if (prisma) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already exists' });
    const user = await prisma.user.create({ data: { email, passwordHash, fullName } });
    return res.json({ token: sign(user), user: { id: user.id, email, fullName } });
  }
  if (mem.users.find((u) => u.email === email)) return res.status(409).json({ error: 'Email already exists' });
  const user = { id: crypto.randomUUID(), email, passwordHash, fullName };
  mem.users.push(user);
  res.json({ token: sign(user), user: { id: user.id, email, fullName } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = prisma ? await prisma.user.findUnique({ where: { email } }) : mem.users.find((u) => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: sign(user), user: { id: user.id, email: user.email, fullName: user.fullName } });
});

app.post('/auth/oauth/:provider', async (req, res) => {
  const { provider } = req.params;
  const { email, fullName, oauthToken } = req.body;
  if (!['google', 'linkedin'].includes(provider)) return res.status(400).json({ error: 'Unsupported provider' });
  if (!email || !fullName || !oauthToken) return res.status(400).json({ error: 'Missing email/fullName/oauthToken' });
  // TODO: verify oauthToken against provider APIs in production.
  let user;
  if (prisma) {
    user = await prisma.user.upsert({ where: { email }, update: { fullName }, create: { email, fullName, passwordHash: `oauth:${provider}` } });
  } else {
    user = mem.users.find((u) => u.email === email);
    if (!user) {
      user = { id: crypto.randomUUID(), email, fullName, passwordHash: `oauth:${provider}` };
      mem.users.push(user);
    }
  }
  res.json({ token: sign(user, { provider }), user: { id: user.id, email: user.email, fullName }, provider });
});

app.post('/profiles', auth, async (req, res) => {
  if (prisma) {
    const profile = await prisma.profile.upsert({ where: { userId: req.user.userId }, update: { ...req.body }, create: { userId: req.user.userId, ...req.body } });
    return res.json(profile);
  }
  const profile = { id: crypto.randomUUID(), userId: req.user.userId, ...req.body };
  const existing = mem.profiles.find((p) => p.userId === req.user.userId);
  if (existing) Object.assign(existing, profile); else mem.profiles.push(profile);
  res.json(profile);
});

app.get('/discover', auth, async (req, res) => {
  const mine = req.user.userId;
  if (prisma) {
    const swiped = await prisma.swipe.findMany({ where: { fromUserId: mine }, select: { toUserId: true } });
    const blocked = swiped.map((s) => s.toUserId);
    return res.json(await prisma.profile.findMany({ where: { userId: { notIn: [mine, ...blocked] } } }));
  }
  const swiped = new Set(mem.swipes.filter((s) => s.fromUserId === mine).map((s) => s.toUserId));
  res.json(mem.profiles.filter((p) => p.userId !== mine && !swiped.has(p.userId)));
});

app.post('/swipes', auth, async (req, res) => {
  const { toUserId, direction } = req.body;
  const fromUserId = req.user.userId;
  if (!['LEFT', 'RIGHT'].includes(direction)) return res.status(400).json({ error: 'Invalid direction' });

  if (prisma) {
    await prisma.swipe.upsert({ where: { fromUserId_toUserId: { fromUserId, toUserId } }, update: { direction }, create: { fromUserId, toUserId, direction } });
    const reciprocal = await prisma.swipe.findFirst({ where: { fromUserId: toUserId, toUserId: fromUserId, direction: 'RIGHT' } });
    if (direction === 'RIGHT' && reciprocal) {
      const [a, b] = [fromUserId, toUserId].sort();
      const match = await prisma.match.upsert({ where: { userAId_userBId: { userAId: a, userBId: b } }, update: {}, create: { userAId: a, userBId: b } });
      const conversation = await prisma.conversation.upsert({ where: { matchId: match.id }, update: {}, create: { matchId: match.id } });
      return res.json({ matched: true, match, conversation });
    }
    return res.json({ matched: false });
  }

  mem.swipes = mem.swipes.filter((s) => !(s.fromUserId === fromUserId && s.toUserId === toUserId));
  mem.swipes.push({ id: crypto.randomUUID(), fromUserId, toUserId, direction });
  const reciprocal = mem.swipes.find((s) => s.fromUserId === toUserId && s.toUserId === fromUserId && s.direction === 'RIGHT');
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
  if (prisma) return res.json(await prisma.match.findMany({ where: { OR: [{ userAId: userId }, { userBId: userId }] } }));
  res.json(mem.matches.filter((m) => m.userAId === userId || m.userBId === userId));
});

app.get('/messages/:conversationId', auth, async (req, res) => {
  const { conversationId } = req.params;
  if (!(await canAccessConversation(req.user.userId, conversationId))) return res.status(403).json({ error: 'Forbidden' });
  if (prisma) return res.json(await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' } }));
  res.json(mem.messages.filter((m) => m.conversationId === conversationId));
});

app.post('/messages/:id/read', auth, async (req, res) => {
  const { id } = req.params;
  if (prisma) {
    const msg = await prisma.message.findUnique({ where: { id } });
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (!(await canAccessConversation(req.user.userId, msg.conversationId))) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.message.update({ where: { id }, data: { status: 'READ' } });
    return res.json(updated);
  }
  const msg = mem.messages.find((m) => m.id === id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (!(await canAccessConversation(req.user.userId, msg.conversationId))) return res.status(403).json({ error: 'Forbidden' });
  msg.status = 'READ';
  res.json(msg);
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    clients.set(payload.userId, ws);

    ws.on('message', async (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'send_message') {
        const { conversationId, toUserId, body } = data;
        if (!(await canAccessConversation(payload.userId, conversationId))) {
          return ws.send(JSON.stringify({ type: 'error', error: 'Forbidden conversation' }));
        }
        let saved;
        if (prisma) {
          saved = await prisma.message.create({ data: { conversationId, senderId: payload.userId, body, status: 'DELIVERED' } });
        } else {
          saved = { id: crypto.randomUUID(), conversationId, senderId: payload.userId, body, status: 'DELIVERED', createdAt: new Date().toISOString() };
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
server.listen(PORT, () => console.log(`Backend running on :${PORT}`));
