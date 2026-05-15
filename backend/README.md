# BusinessTinder Backend (Auth + API + Realtime)

This directory contains two coexisting backend implementations:

- `server.js` (root of `backend/`) — lightweight vanilla-Node HTTP server wired into the root test suite (`backend/auth.js` helpers, file-backed persistence option, static asset serving).
- `src/server.js` — the production-direction Express + WebSocket variant described below.

The Express variant adds:

1. Real auth (email/password JWT)
2. OAuth onboarding endpoints (`google`, `linkedin`) for client integration scaffolding
3. API layer for profiles/swipes/matches/messages
4. Realtime chat transport (WebSocket) with `send_message` / `read_message` typed protocol
5. PostgreSQL data model definition via Prisma schema in `prisma/schema.prisma`
6. In-memory fallback when `DATABASE_URL` (or `@prisma/client`) is unavailable

## Endpoints

- `GET /health`
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/oauth/:provider` (`provider` = `google|linkedin`)
- `POST /profiles` (auth)
- `GET /discover` (auth)
- `POST /swipes` (auth)
- `GET /matches` (auth)
- `GET /messages/:conversationId` (auth)
- `POST /messages/:id/read` (auth)
- `WS /ws?token=...`

## Runtime modes

- If `DATABASE_URL` is set and `@prisma/client` is installed, the server uses Prisma against PostgreSQL.
- Otherwise it falls back to in-memory storage for quick local demos.

## Run

```bash
cd backend
npm install
npm run dev
```

Server defaults to `http://localhost:4000`.

## DB setup (Prisma)

```bash
cd backend
npx prisma generate
npx prisma migrate dev -n init
```

## Client helper

`src/clientApi.js` exposes a tiny browser-side helper (`api.register`, `api.login`, …, `connectWs`) that reads/writes the JWT from `localStorage` under `bt_token` and talks to `window.__BT_API__` (default `http://localhost:4000`).
