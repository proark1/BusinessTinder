import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Temporary in-memory storage; swap with Prisma/Postgres using schema in backend/prisma/schema.prisma
const db = {
  users: [],
  profiles: [],
  swipes: [],
  matches: [],
  conversations: [],
  messages: []
};

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

app.post('/auth/register', async (req, res) => {
  const { email, password, fullName } = req.body;
  if (!email || !password || !fullName) return res.status(400).json({ error: 'Missing fields' });
  if (db.users.find((u) => u.email === email)) return res.status(409).json({ error: 'Email already exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: crypto.randomUUID(), email, passwordHash, fullName };
  db.users.push(user);
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email, fullName } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.users.find((u) => u.email === email);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, fullName: user.fullName } });
});

app.post('/profiles', auth, (req, res) => {
  const profile = { id: crypto.randomUUID(), userId: req.user.userId, ...req.body };
  const existing = db.profiles.find((p) => p.userId === req.user.userId);
  if (existing) Object.assign(existing, profile);
  else db.profiles.push(profile);
  res.json(profile);
});

app.get('/discover', auth, (req, res) => {
  const mine = req.user.userId;
  const swiped = new Set(db.swipes.filter((s) => s.fromUserId === mine).map((s) => s.toUserId));
  const cards = db.profiles.filter((p) => p.userId !== mine && !swiped.has(p.userId));
  res.json(cards);
});

app.post('/swipes', auth, (req, res) => {
  const { toUserId, direction } = req.body;
  const fromUserId = req.user.userId;
  db.swipes = db.swipes.filter((s) => !(s.fromUserId === fromUserId && s.toUserId === toUserId));
  db.swipes.push({ id: crypto.randomUUID(), fromUserId, toUserId, direction });

  const reciprocal = db.swipes.find((s) => s.fromUserId === toUserId && s.toUserId === fromUserId && s.direction === 'RIGHT');
  if (direction === 'RIGHT' && reciprocal) {
    const [a, b] = [fromUserId, toUserId].sort();
    let match = db.matches.find((m) => m.userAId === a && m.userBId === b);
    if (!match) {
      match = { id: crypto.randomUUID(), userAId: a, userBId: b, createdAt: new Date().toISOString() };
      db.matches.push(match);
      const convo = { id: crypto.randomUUID(), matchId: match.id };
      db.conversations.push(convo);
    }
    return res.json({ matched: true, match });
  }

  res.json({ matched: false });
});

app.get('/matches', auth, (req, res) => {
  const userId = req.user.userId;
  const matches = db.matches.filter((m) => m.userAId === userId || m.userBId === userId);
  res.json(matches);
});

app.get('/messages/:conversationId', auth, (req, res) => {
  res.json(db.messages.filter((m) => m.conversationId === req.params.conversationId));
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Map();

wss.on('connection', (ws, req) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('token');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    clients.set(payload.userId, ws);
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const saved = { id: crypto.randomUUID(), status: 'DELIVERED', createdAt: new Date().toISOString(), ...msg };
      db.messages.push(saved);
      const target = clients.get(msg.toUserId);
      if (target) target.send(JSON.stringify(saved));
    });
    ws.on('close', () => clients.delete(payload.userId));
  } catch {
    ws.close();
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Backend running on :${PORT}`));
