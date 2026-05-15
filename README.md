# BusinessTinder — Mobile Web Prototype

A mobile-first prototype for business matching with swipe-based discovery, mutual-right matching, and lightweight in-app chat simulation.

## What is implemented

- Onboarding/profile creation flow
- Swipe deck with gesture + button actions
- Match rule: `right + right = match`; all other combinations = no match
- Matches inbox with unmatch/report actions
- Basic chat simulation per match
- Undo last swipe
- Industry filtering
- `localStorage` persistence for app state
- PWA basics (`manifest.webmanifest` + `sw.js`)
- Unit tests for core logic modules

## Run locally

```bash
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## Run tests

```bash
npm test
```

## Project structure

- `index.html`, `styles.css`, `script.js` — app UI and interaction wiring
- `src/matchEngine.js` — matching + completion utilities
- `src/discovery.js` — discover pool filtering logic
- `src/swipeState.js` — swipe apply/undo state transitions
- `sw.js`, `manifest.webmanifest` — offline/PWA assets
- `test/*.test.js` — node unit tests
- `.github/workflows/ci.yml` — CI test execution

## Current limitations

- Frontend-only prototype (no backend auth/DB/realtime services)
- No production moderation pipeline
- No server-side recommendation/ranking model

## Product plan

High-level roadmap/spec remains in `BUSINESS_TINDER_PLAN.md`.


## Backend foundation

A backend foundation now exists in `backend/` with auth, API routes, WebSocket chat transport, and a PostgreSQL Prisma schema. See `backend/README.md`.
