# BusinessTinder Backend (Auth + API + Realtime)

This backend implements the requested foundation for:

1. Real authentication (email/password JWT)
2. API layer for profiles/swipes/matches/messages
3. Realtime chat transport (WebSocket)
4. Postgres data model definition via Prisma schema

## Endpoints

- `POST /auth/register`
- `POST /auth/login`
- `POST /profiles` (auth)
- `GET /discover` (auth)
- `POST /swipes` (auth)
- `GET /matches` (auth)
- `GET /messages/:conversationId` (auth)
- `WS /ws?token=...`

## Run

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
