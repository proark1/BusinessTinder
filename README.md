# BusinessTinder

BusinessTinder is a mobile-first matching platform for founders, operators, investors, advisors, and other professionals to discover each other, match, and start conversations.

## What is implemented

- **Auth** — email/password + Google Sign-In, email verification, password reset, and optional TOTP two-factor (with recovery codes)
- **Account security** — password policy, login lockout after repeated failures, disposable-email rejection, and GDPR data export / account deletion
- **Onboarding & profiles** — multi-step wizard with rich fields (headline, type, looking-for, stage, industries, skills, prompts, links, location/remote, availability), image upload, and shareable public profile pages at `/u/:slug`
- **Discover & search** — scored, filtered, diversified candidate deck plus keyword search; super-likes and PRO boosts surface to the top
- **Swipes & matches** — mutual right/super-like creates a match + conversation; matches inbox with unread counts
- **Realtime chat** — WebSocket messaging with typing indicators, read receipts, image messages, and offline fallback to web push + throttled email digests
- **Likes & profile views** — "who liked you" and "who viewed you", gated by plan (FREE silhouettes + daily reveals, PRO full access)
- **Trust & safety** — block/report, keyword + image moderation, admin ban/suspend, and a moderation queue
- **Monetization** — FREE/PRO plan gating, 30-minute boosts, and referral rewards (both sides get PRO time)
- **Compliance** — terms/privacy pages, one-click email unsubscribe, and notification preferences
- **Trust signals** — admin "verified" badge and self-serve company-email verification
- **Observability** — per-request IDs, structured request logs, and a pluggable error webhook
- **Scale** — optional Redis pub/sub fan-out so WebSocket delivery works across multiple server instances
- **PWA** — installable manifest, service worker, and optional web-push notifications

## Architecture

- **Frontend** — static SPA (`index.html`, `script.js`, `styles.css`, `sw.js`) with a few ES modules in `src/`
- **Backend (runtime)** — `backend/src/server.js`: Express + `ws`, Prisma against Postgres, and it serves the static frontend at `/` so the whole app runs from a single origin
- **Production entrypoint** — `backend/src/start.js` runs `prisma migrate deploy` (and optional `db push`) before booting
- **Local/dev fallback** — in-memory storage when `DATABASE_URL` is unset (data does not persist; the server refuses this in production)
- **Legacy** — `backend/server.js` is kept only for an older test suite and is not used at runtime

See [`backend/README.md`](backend/README.md) for backend details and [`backend/openapi.yaml`](backend/openapi.yaml) for the full HTTP + WebSocket API reference.

## Run

```bash
npm install
cd backend && npm install && npx prisma generate && cd ..
npm start          # production entrypoint (runs migrations, then serves)
# or, for a no-database local demo (in-memory storage):
npm run start:api
```

Then open `http://localhost:4000`.

## Test

```bash
npm test
```

## Environment

For production, configure at minimum:

- `DATABASE_URL` — Postgres connection string (`RAILWAY_DATABASE_URL` is also accepted). Without it the server runs in-memory in dev and **refuses to start in production**.
- `JWT_SECRET` — the server refuses to start in production if this is unset or left at the dev default.
- `BT_TOKEN_SECRET` — same enforcement for the lightweight HMAC tokens used by the legacy `backend/server.js`.
- `ALLOWED_ORIGINS` — comma-separated CORS allow-list. In production an empty list locks the API down; dev/test keeps open CORS when unset.

Recommended for full functionality:

- `GOOGLE_CLIENT_ID` — enables Google Sign-In (also surfaced to the frontend via `/auth/config`)
- `RESEND_API_KEY`, `EMAIL_FROM` — transactional email (verification, reset, digests). Without it, emails are logged to the console.
- `CLOUDINARY_URL` — cloud image hosting. Without it, uploads fall back to inline base64.
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` — web-push notifications
- `APP_URL` — base URL used to build links in emails
- `ADMIN_EMAILS` — comma-separated emails granted access to `/admin/*` (read live, no restart needed)

Scale & observability (optional):

- `REDIS_URL` — enables multi-node WebSocket fan-out + cross-instance presence
- `ERROR_WEBHOOK_URL`, `SERVICE_NAME` — pluggable error reporting and log tagging
- `LOG_REQUESTS` — toggle structured per-request logging

Tunable limits (optional, with sensible defaults):

- `FREE_DAILY_SWIPES` (30), `FREE_DAILY_LIKE_REVEALS` (1)
- `DISCOVER_LIMIT` (200), `SEARCH_LIMIT` (50)
- `LOGIN_MAX_FAILS`, `LOGIN_FAIL_WINDOW_MS`, `LOGIN_LOCK_MS` — login lockout tuning
- `DISPOSABLE_EMAIL_DOMAINS` — extra disposable domains to reject
- `NOMINATIM_URL`, `GEOCODE_USER_AGENT` — geocoding for distance scoring

Opt-in only (avoid in production):

- `ALLOW_DEV_PLAN_UPGRADE=true` — re-enables `POST /plan/upgrade` for staging/QA. Without it the endpoint returns 501 in production (no real payment integration yet). Even when enabled the grant is finite (`planExpiresAt = +30 days`).
- `PRISMA_DB_PUSH=1` — runs `prisma db push --accept-data-loss` on boot to reconcile schema drift (destructive; gated behind this flag).

Runtime readiness:

- `GET /health` — liveness + DB round-trip
- `GET /ops/readiness` — detailed checklist (DB, JWT secret, Google, email, upload, push, error reporting, multi-node)
