# BusinessTinder

BusinessTinder is a mobile-first matching platform for founders, operators, investors, advisors, and other professionals to discover each other, match, and start conversations.

## What is implemented

- Email/password auth + Google sign-in
- Email verification + password reset
- Multi-step onboarding with rich profile fields
- Discover feed with scoring, filters, and swipe actions (left/right/super-like)
- Matches inbox + realtime chat (WebSocket)
- Trust controls: block/report + lightweight moderation
- Referral rewards + FREE/PRO feature gating
- PWA assets and optional web-push notifications

## Architecture

- Frontend: static SPA (`index.html`, `script.js`, `styles.css`)
- Backend API/runtime: `backend/src/server.js` (Express + optional Prisma/Postgres)
- Local/dev fallback: in-memory storage when DB is not configured

## Run

```bash
npm install
npm start
```

Then open `http://localhost:4000`.

## Test

```bash
npm test
```

## Important environment notes

For production, configure at minimum:

- `DATABASE_URL`
- `JWT_SECRET` — the server refuses to start in production if this is unset or left at the dev default.
- `BT_TOKEN_SECRET` — same enforcement for the lightweight HMAC tokens used by `backend/server.js`.
- `ALLOWED_ORIGINS` — comma-separated list of origins allowed by CORS. In production an empty list locks the API down (no cross-origin requests accepted). Dev/test keeps the old open-CORS behavior when this is unset.

Recommended for full functionality:

- `GOOGLE_CLIENT_ID`
- `RESEND_API_KEY`
- `CLOUDINARY_URL`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

Opt-in only (avoid in production):

- `ALLOW_DEV_PLAN_UPGRADE=true` — re-enables `POST /plan/upgrade` for staging/QA. Without this flag, the endpoint returns 501 in production because real payment integration is not yet wired up. Even when enabled, the grant is finite (`planExpiresAt = +30 days`).

You can also check runtime readiness via:

- `GET /health`
- `GET /ops/readiness`
