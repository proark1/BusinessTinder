# BusinessTinder — Mobile Web App Prototype

This is an implemented mobile-first business matching web app prototype with:

- Profile onboarding
- Swipe deck with animated gestures
- Match logic (right+right = match, otherwise no match)
- Matches inbox
- In-app chat simulation
- Local persistence via `localStorage`

## Run

```bash
python3 -m http.server 4173
```

Open: `http://localhost:4173`

## Notes

This is still frontend-only and static. Next steps for production:
- backend auth
- persistent database
- real-time chat service
- moderation/reporting APIs
- recommendation engine


## Backend API (new)

Run lightweight MVP API server:

```bash
npm run start:api
```

Default: `http://localhost:8787` with endpoints for signup, profiles, swipes, matches, and messages.

## API contract and production database prep

- OpenAPI spec: `backend/openapi.yaml`
- SQL schema draft for Postgres: `backend/sql/schema.sql`

This repository still runs a lightweight Node API for local development, but the SQL schema is included to accelerate migration to managed Postgres in production.

## Security additions

- Token-based auth (`/auth/signup`, `/auth/login`, `/auth/me`)
- Protected endpoints for profile write/swipe/matches/messages/reports/blocks
- Basic API rate limiting (per-IP, per-minute) to reduce abuse in demo deployments
