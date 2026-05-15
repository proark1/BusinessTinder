# BusinessTinder Backend (Auth + API + Realtime)

The production-direction backend lives in **`src/server.js`** — Express + WebSocket, Prisma against Postgres with an in-memory fallback for local demos, and it also serves the static frontend at `/` so the whole app runs from a single origin.

The legacy `server.js` (root of `backend/`) is kept only for the existing test suite and is no longer used at runtime.

## What's wired up

1. Email/password auth (`/auth/register`, `/auth/login`) — bcrypt + JWT
2. **Google Sign-In** at `/auth/google` — verifies the Google ID token server-side with `google-auth-library`
3. Profile CRUD (`/profiles`, `/profiles/me`, `/me`)
4. Swipes/matches/discover (`/swipes`, `/matches`, `/discover`)
5. Chat (`/messages/:conversationId` GET/POST + WebSocket `/ws`)
6. `/health` does a real DB round-trip when Postgres is configured
7. `/auth/config` returns the Google client ID for the frontend

## Required environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes in production | Postgres URL. `RAILWAY_DATABASE_URL` also accepted. Without it, dev falls back to in-memory and prod refuses to start. |
| `JWT_SECRET` | yes in production | Any strong random string. |
| `GOOGLE_CLIENT_ID` | optional | Without it, Google sign-in is hidden in the UI. The same value is read by the frontend. |
| `PORT` | optional | Defaults to 4000. |
| `NODE_ENV` | optional | Set to `production` to enable fail-fast on missing `DATABASE_URL`. |

## Run locally

```bash
cd backend
npm install
npm run dev
```

Then open `http://localhost:4000`.

## DB setup (Prisma)

```bash
cd backend
npx prisma generate
npx prisma migrate dev -n profile_fields
```

The `Profile` model captures the matching-relevant fields: `headline`, `userType`, `lookingFor[]`, `bio`, `stage`, `industries[]`, `skills[]`, `location`, `remoteOk`, `commitment`, `linkedinUrl`, `avatarUrl`.
