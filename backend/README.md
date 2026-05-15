# BusinessTinder Backend (Auth + API + Realtime)

Backend foundation now includes:

1. Real auth (email/password JWT)
2. OAuth onboarding endpoints (`google`, `linkedin`) for client integration scaffolding
3. API layer for profiles/swipes/matches/messages
4. Realtime chat transport (WebSocket)
5. PostgreSQL data model definition via Prisma schema

## Endpoints

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

- If `DATABASE_URL` is set, server uses Prisma client with PostgreSQL.
- If `DATABASE_URL` is not set, server falls back to in-memory storage for quick local demos.

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
