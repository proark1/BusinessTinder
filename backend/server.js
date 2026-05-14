import http from 'node:http';

export function createServer() {
  const db = {
    users: [],
    profiles: [],
    swipes: [],
    matches: [],
    messages: []
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const parseBody = async (req) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    return data ? JSON.parse(data) : {};
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/auth/signup') {
      const body = await parseBody(req);
      const user = { id: String(db.users.length + 1), email: body.email };
      db.users.push(user);
      return json(res, 201, user);
    }

    if (req.method === 'POST' && url.pathname === '/profiles') {
      const body = await parseBody(req);
      const profile = { id: String(db.profiles.length + 1), ...body };
      db.profiles.push(profile);
      return json(res, 201, profile);
    }

    if (req.method === 'GET' && url.pathname === '/profiles') {
      return json(res, 200, db.profiles);
    }

    if (req.method === 'POST' && url.pathname === '/swipes') {
      const body = await parseBody(req);
      const swipe = { id: String(db.swipes.length + 1), ...body };
      db.swipes.push(swipe);

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

    if (req.method === 'POST' && url.pathname === '/messages') {
      const body = await parseBody(req);
      const msg = { id: String(db.messages.length + 1), ts: Date.now(), ...body };
      db.messages.push(msg);
      return json(res, 201, msg);
    }

    if (req.method === 'GET' && url.pathname === '/messages') {
      const matchId = url.searchParams.get('matchId');
      return json(res, 200, db.messages.filter((m) => m.matchId === matchId));
    }

    return json(res, 404, { error: 'Not found' });
  });
}

if (process.argv[1].endsWith('server.js')) {
  const server = createServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`API running on ${port}`));
}
