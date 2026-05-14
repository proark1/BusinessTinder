import http from 'node:http';
import fs from 'node:fs';

export function createServer(options = {}) {
  const dataFile = options.dataFile || process.env.BT_DB_FILE || null;
  const initialDb = {
    users: [],
    profiles: [],
    swipes: [],
    matches: [],
    messages: [],
    reports: [],
    blocks: []
  };
  const db = dataFile && fs.existsSync(dataFile)
    ? { ...initialDb, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }
    : initialDb;

  const flush = () => {
    if (!dataFile) return;
    fs.writeFileSync(dataFile, JSON.stringify(db, null, 2));
  };

  const baseHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };

  const json = (res, code, body) => {
    res.writeHead(code, baseHeaders);
    res.end(JSON.stringify(body));
  };

  const parseBody = async (req) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    if (!data) return {};
    try {
      return JSON.parse(data);
    } catch {
      const err = new Error('Invalid JSON');
      err.status = 400;
      throw err;
    }
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, baseHeaders);
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/auth/signup') {
        const body = await parseBody(req);
        if (!body.email) return json(res, 400, { error: 'email is required' });
        const user = { id: String(db.users.length + 1), email: body.email };
        db.users.push(user);
        flush();
        return json(res, 201, user);
      }

      if (req.method === 'POST' && url.pathname === '/profiles') {
        const body = await parseBody(req);
        const profile = { id: String(db.profiles.length + 1), ...body };
        db.profiles.push(profile);
        flush();
        return json(res, 201, profile);
      }

      if (req.method === 'GET' && url.pathname === '/profiles') {
        return json(res, 200, db.profiles);
      }

      if (req.method === 'POST' && url.pathname === '/swipes') {
        const body = await parseBody(req);
        if (!body.fromUserId || !body.toUserId || !body.direction) {
          return json(res, 400, { error: 'fromUserId,toUserId,direction required' });
        }
        const swipe = { id: String(db.swipes.length + 1), ...body };
        db.swipes.push(swipe);
        flush();

        if (body.direction === 'right') {
          const reciprocal = db.swipes.find(
            (s) => s.fromUserId === body.toUserId && s.toUserId === body.fromUserId && s.direction === 'right'
          );
          if (reciprocal) {
            const exists = db.matches.find(
              (m) =>
                (m.userA === body.fromUserId && m.userB === body.toUserId) ||
                (m.userA === body.toUserId && m.userB === body.fromUserId)
            );
            if (!exists) {
              db.matches.push({ id: String(db.matches.length + 1), userA: body.fromUserId, userB: body.toUserId });
              flush();
            }
          }
        }

        return json(res, 201, swipe);
      }

      if (req.method === 'GET' && url.pathname === '/matches') {
        const userId = url.searchParams.get('userId');
        const matches = db.matches.filter((m) => m.userA === userId || m.userB === userId);
        return json(res, 200, matches);
      }

      if (req.method === 'POST' && url.pathname === '/reports') {
        const body = await parseBody(req);
        const report = { id: String(db.reports.length + 1), ts: Date.now(), ...body };
        db.reports.push(report);
        flush();
        return json(res, 201, report);
      }

      if (req.method === 'POST' && url.pathname === '/blocks') {
        const body = await parseBody(req);
        const block = { id: String(db.blocks.length + 1), ts: Date.now(), ...body };
        db.blocks.push(block);
        flush();
        return json(res, 201, block);
      }

      if (req.method === 'POST' && url.pathname === '/messages') {
        const body = await parseBody(req);
        const msg = { id: String(db.messages.length + 1), ts: Date.now(), ...body };
        db.messages.push(msg);
        flush();
        return json(res, 201, msg);
      }

      if (req.method === 'GET' && url.pathname === '/messages') {
        const matchId = url.searchParams.get('matchId');
        return json(res, 200, db.messages.filter((m) => m.matchId === matchId));
      }

      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      return json(res, err.status || 500, { error: err.message || 'Server error' });
    }
  });
}

if (process.argv[1] && process.argv[1].endsWith('server.js')) {
  const server = createServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`API running on ${port}`));
}
