# BusinessTinder Backend (Auth + API + Realtime)

This directory contains two coexisting backend implementations:

- `server.js` (root of `backend/`) — the lightweight vanilla-Node HTTP server already wired into the root test suite (`backend/auth.js` for password/token helpers, file-backed persistence option, static asset serving).
- `src/server.js` (this Express/WebSocket variant) — a foundation for the production-style backend: email/password JWT auth, REST profiles/swipes/matches/messages, WebSocket chat transport, and a Postgres data model expressed in `prisma/schema.prisma`.

The Express variant is **not** wired into root CI yet; it has its own `package.json` with external dependencies (`express`, `bcryptjs`, `jsonwebtoken`, `cors`, `ws`). Install separately before running it.

## Express variant — endpoints

- `POST /auth/register`
- `POST /auth/login`
- `POST /profiles` (auth)
- `GET /discover` (auth)
- `POST /swipes` (auth)
- `GET /matches` (auth)
- `GET /messages/:conversationId` (auth)
- `WS /ws?token=...`

## Run the Express variant

```bash
cd backend
npm install
npm run dev
```

Server defaults to `http://localhost:4000`.

## Notes

- Current runtime persistence is in-memory for immediate development.
- Production persistence model is defined in `prisma/schema.prisma` for PostgreSQL.
- Next step: wire Prisma client + migrations into route handlers.
