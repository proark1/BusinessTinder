# BusinessTinder Backend (Auth + API + Realtime)

The production-direction backend lives in **`src/server.js`** — Express + WebSocket (`ws`), Prisma against Postgres with an in-memory fallback for local demos, and it also serves the static frontend at `/` so the whole app runs from a single origin.

`src/start.js` is the production entrypoint: it runs `prisma migrate deploy` (and, when `PRISMA_DB_PUSH=1`, `prisma db push`) before booting Express.

The legacy `server.js` (root of `backend/`) is kept only for the older test suite and is no longer used at runtime.

The full HTTP + WebSocket contract is documented in [`openapi.yaml`](openapi.yaml).

## What's wired up

1. **Auth** — email/password (`/auth/register`, `/auth/login`) with bcrypt + JWT, Google Sign-In (`/auth/google`, ID token verified server-side), email verification (`/auth/verify`, `/auth/resend-verify`), and password reset (`/auth/forgot`, `/auth/reset`)
2. **Two-factor (TOTP)** — `/me/2fa/setup|enable|disable` for enrollment + recovery codes; `/auth/login` returns an `mfaToken` exchanged at `/auth/2fa`
3. **Account security** — password policy, login lockout, disposable-email rejection, GDPR export (`/me/export`), and account deletion (`DELETE /me`)
4. **Profiles** — CRUD (`/profiles`, `/profiles/me`, `/me`), image upload (`/upload`), prompts catalog (`/prompts`), and public profile pages (`/u/:slug`)
5. **Discovery** — scored/filtered/diversified deck (`/discover`), keyword search (`/search`), swipes + matches (`/swipes`, `/matches`), likes (`/likes/incoming`, `/likes/reveal`), and profile views (`/profile-views/*`)
6. **Chat** — `/messages/:conversationId` GET/POST, `/conversations/:id/read`, plus the WebSocket `/ws` (typing, read receipts, image messages, offline push/email fallback)
7. **Trust & safety** — blocks/reports (`/blocks`, `/reports`), keyword + image moderation, and admin tools (`/admin/verify|ban|unban|reports/:id/resolve|seed-fakes|queue`, gated by `ADMIN_EMAILS`)
8. **Monetization** — plan gating, boosts (`/boost`, `/boost/status`), referral redemption (`/referrals/redeem`), and `/plan/upgrade` (501 in prod until payments are wired up)
9. **Compliance & trust** — legal pages (`/legal/terms`, `/legal/privacy`), email unsubscribe (`/unsubscribe`), notification prefs (`/me/notifications`), and company-email verification (`/me/company-email`, `/company/verify`)
10. **Ops** — `/health` (real DB round-trip when Postgres is configured), `/ops/readiness` (full checklist), `/auth/config` (frontend config), per-request IDs + structured logging, pluggable error webhook, and optional Redis fan-out for multi-node WebSocket delivery

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes in production | Postgres URL. `RAILWAY_DATABASE_URL` also accepted. Without it, dev falls back to in-memory and prod refuses to start. |
| `JWT_SECRET` | yes in production | Strong random string; prod refuses to boot on the dev default. |
| `ALLOWED_ORIGINS` | recommended | Comma-separated CORS allow-list. Empty in production = all cross-origin requests rejected. |
| `GOOGLE_CLIENT_ID` | optional | Enables Google Sign-In; the same value is surfaced to the frontend via `/auth/config`. |
| `RESEND_API_KEY` / `EMAIL_FROM` | optional | Transactional email (verify/reset/digests). Without it, emails are logged to the console. |
| `CLOUDINARY_URL` | optional | Cloud image hosting; otherwise uploads fall back to inline base64. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | optional | Web-push notifications. |
| `APP_URL` | optional | Base URL used when building links in emails. |
| `ADMIN_EMAILS` | optional | Comma-separated emails granted `/admin/*` access (read live; no restart needed). |
| `REDIS_URL` | optional | Enables multi-node WebSocket fan-out + cross-instance presence, and a shared cross-instance rate-limit counter (falls back to per-process in-memory when unset/unreachable). |
| `REFERRAL_REWARD_CAP` | optional | Max signups a single inviter earns referral rewards for (default 25; anti-farming). |
| `ERROR_WEBHOOK_URL` / `SERVICE_NAME` | optional | Pluggable error reporting + log tagging. |
| `LOG_REQUESTS` | optional | Toggle structured per-request logging. |
| `FREE_DAILY_SWIPES` / `FREE_DAILY_LIKE_REVEALS` | optional | Free-tier limits (default 30 / 1). |
| `DISCOVER_LIMIT` / `SEARCH_LIMIT` | optional | Result caps (default 200 / 50). |
| `LOGIN_MAX_FAILS` / `LOGIN_FAIL_WINDOW_MS` / `LOGIN_LOCK_MS` | optional | Login-lockout tuning. |
| `DISPOSABLE_EMAIL_DOMAINS` | optional | Extra disposable domains to reject. |
| `NOMINATIM_URL` / `GEOCODE_USER_AGENT` | optional | Geocoding for distance scoring. |
| `ALLOW_DEV_PLAN_UPGRADE` | opt-in | Re-enables `POST /plan/upgrade` (501 in prod otherwise). |
| `PRISMA_DB_PUSH` | opt-in | `1` runs `prisma db push --accept-data-loss` on boot (destructive). |
| `PORT` | optional | Defaults to 4000. |
| `NODE_ENV` | optional | `production` enables fail-fast on missing `DATABASE_URL`/`JWT_SECRET`. |

## Run locally

```bash
cd backend
npm install
npm run dev        # node src/server.js (in-memory unless DATABASE_URL is set)
```

Then open `http://localhost:4000`.

## DB setup (Prisma)

```bash
cd backend
npm run prisma:generate          # prisma generate
npm run prisma:migrate           # prisma migrate dev (local)
npm run prisma:deploy            # prisma migrate deploy (production)
```

`src/start.js` (used by `npm start`) runs `migrate deploy` automatically on boot.

### Data model

`backend/prisma/schema.prisma` is the source of truth (`backend/sql/schema.sql` is a generated mirror guarded by a parity test). Models:

- **User** — auth + plan + referral + trust/safety + 2FA fields (`email`, `passwordHash`, `googleSub`, `planTier`/`planExpiresAt`, `referralCode`/`referredBy`, daily swipe/like-reveal counters, `emailVerified`/`verified`, ban fields, `companyDomain`/`companyVerifiedAt`, `totpSecret`/`totpEnabled`/`recoveryCodes`, …)
- **Profile** — matching fields: `headline`, `userType`, `lookingFor[]`, `bio`, `stage`, `industries[]`, `skills[]`, `location` (+ `latitude`/`longitude`), `remoteOk`, `commitment`, `linkedinUrl`, `avatarUrl`, `photoUrl`/`photos[]`, `pastCompanies[]`, `hoursPerWeek`, `calLink`, `pitchDeckUrl`, `promptIds[]`/`promptAnswers[]`, `slug`, `lastActiveAt`
- **ProfileView**, **Swipe** (`SwipeDirection`: LEFT/RIGHT/SUPER_LIKE), **Match**, **Conversation**, **Message** (`MessageStatus`: SENT/DELIVERED/READ), **SavedProfile**, **Report**, **Block**, **PushSubscription**
