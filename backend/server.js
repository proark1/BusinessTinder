import http from 'node:http';
import fs from 'node:fs';
import { hashPassword, verifyPassword, signToken, verifyToken } from './auth.js';

export function createServer(options = {}) {
  const dataFile = options.dataFile || process.env.BT_DB_FILE || null;
  const initialDb = { users: [], profiles: [], swipes: [], matches: [], messages: [], reports: [], blocks: [] };
  const db = dataFile && fs.existsSync(dataFile) ? { ...initialDb, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) } : initialDb;
  const flush = () => dataFile && fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
  const rate = new Map();

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  };

  const json = (res, code, body) => { res.writeHead(code, baseHeaders); res.end(JSON.stringify(body)); };

  const parseBody = async (req) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    if (!data) return {};
    try { return JSON.parse(data); } catch { const e = new Error('Invalid JSON'); e.status = 400; throw e; }
  };

  const requireAuth = (req) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const payload = verifyToken(token);
    if (!payload?.userId) {
      const e = new Error('Unauthorized');
      e.status = 401;
      throw e;
    }
    return payload;
  };



  const authUser = (req) => {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return verifyToken(token);
  };

  const checkRate = (req, limit = 120, windowMs = 60_000) => {
    const key = `${req.socket.remoteAddress}:${Math.floor(Date.now() / windowMs)}`;
    const count = (rate.get(key) || 0) + 1;
    rate.set(key, count);
    if (count > limit) {
      const e = new Error('Rate limit exceeded');
      e.status = 429;
      throw e;
    }
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      checkRate(req);
      if (req.method === 'OPTIONS') return res.writeHead(204, baseHeaders), res.end();
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

      if (req.method === 'GET' && url.pathname === '/metrics') {
        return json(res, 200, {
          users: db.users.length,
          profiles: db.profiles.length,
          swipes: db.swipes.length,
          matches: db.matches.length,
          messages: db.messages.length,
          reports: db.reports.length,
          blocks: db.blocks.length
        });
      }


      if (req.method === 'POST' && url.pathname === '/auth/signup') {
        const body = await parseBody(req);
        if (!body.email || !body.password) return json(res, 400, { error: 'email and password are required' });
        if (db.users.find((u) => u.email === body.email)) return json(res, 409, { error: 'email already exists' });
        const user = { id: String(db.users.length + 1), email: body.email, passwordHash: hashPassword(body.password) };
        db.users.push(user); flush();
        const token = signToken({ userId: user.id, email: user.email });
        return json(res, 201, { id: user.id, email: user.email, token });
      }

      if (req.method === 'POST' && url.pathname === '/auth/login') {
        const body = await parseBody(req);
        const user = db.users.find((u) => u.email === body.email);
        if (!user || !verifyPassword(body.password || '', user.passwordHash)) return json(res, 401, { error: 'invalid credentials' });
        const token = signToken({ userId: user.id, email: user.email });
        return json(res, 200, { id: user.id, email: user.email, token });
      }

      if (req.method === 'GET' && url.pathname === '/auth/me') {
        const auth = requireAuth(req);
        return json(res, 200, auth);
      }

      if (req.method === 'POST' && url.pathname === '/profiles') {
        const auth = requireAuth(req);
        const body = await parseBody(req);
        const profile = { id: String(db.profiles.length + 1), userId: auth.userId, ...body };
        db.profiles.push(profile); flush();
        return json(res, 201, profile);
      }

      if (req.method === 'GET' && url.pathname === '/profiles') return json(res, 200, db.profiles);

      if (req.method === 'GET' && url.pathname === '/profiles/me') {
        const auth = requireAuth(req);
        return json(res, 200, db.profiles.filter((p) => String(p.userId) === String(auth.userId)));
      }

      if (req.method === 'POST' && url.pathname === '/swipes') {
        const auth = requireAuth(req);
        const body = await parseBody(req);
        if (!body.toUserId || !body.direction) return json(res, 400, { error: 'toUserId,direction required' });
        const swipe = { id: String(db.swipes.length + 1), fromUserId: auth.userId, toUserId: String(body.toUserId), direction: body.direction };
        db.swipes.push(swipe); flush();
        if (body.direction === 'right') {
          const reciprocal = db.swipes.find((s) => s.fromUserId === swipe.toUserId && s.toUserId === swipe.fromUserId && s.direction === 'right');
          if (reciprocal && !db.matches.find((m) => (m.userA === swipe.fromUserId && m.userB === swipe.toUserId) || (m.userA === swipe.toUserId && m.userB === swipe.fromUserId))) {
            db.matches.push({ id: String(db.matches.length + 1), userA: swipe.fromUserId, userB: swipe.toUserId }); flush();
          }
        }
        return json(res, 201, swipe);
      }

      if (req.method === 'GET' && url.pathname === '/matches') {
        const auth = requireAuth(req);
        const matches = db.matches.filter((m) => m.userA === auth.userId || m.userB === auth.userId);
        return json(res, 200, matches);
      }

      if (req.method === 'POST' && url.pathname === '/reports') {
        const auth = requireAuth(req);
        const body = await parseBody(req);
        const report = { id: String(db.reports.length + 1), ts: Date.now(), fromUserId: auth.userId, ...body };
        db.reports.push(report); flush();
        return json(res, 201, report);
      }

      if (req.method === 'POST' && url.pathname === '/blocks') {
        const auth = requireAuth(req);
        const body = await parseBody(req);
        const block = { id: String(db.blocks.length + 1), ts: Date.now(), fromUserId: auth.userId, ...body };
        db.blocks.push(block); flush();
        return json(res, 201, block);
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const auth = requireAuth(req);
        const body = await parseBody(req);
        const msg = { id: String(db.messages.length + 1), ts: Date.now(), fromUserId: auth.userId, ...body };
        db.messages.push(msg); flush();
        return json(res, 201, msg);
      }

      if (req.method === 'GET' && url.pathname === '/messages') {
        requireAuth(req);
        const matchId = url.searchParams.get('matchId');
        return json(res, 200, db.messages.filter((m) => m.matchId === matchId));
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  });
}

if (process.argv[1].endsWith('server.js')) {
  const server = createServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`API running on ${port}`));
}
