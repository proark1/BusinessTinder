# Business Tinder — Product & Build Plan (Mobile Web First)

## 1) Product Vision
Build the best mobile-first business matching platform where founders, operators, investors, freelancers, and domain experts discover each other through fast, high-signal swiping and high-quality profile context.

**Core promise:**
- Fast discovery (swipe UX)
- High-quality intent matching (interests + goals + constraints)
- Smooth delightful experience (animations, haptics-like feedback, loading polish)

## 2) MVP Scope (v1)

### User roles
- Professional user (default): creates profile, swipes, matches, chats.
- Admin (internal): moderation + reports + flagged content review.

### Core user stories
1. As a user, I can sign up quickly with email/Google/LinkedIn.
2. As a user, I can create a profile with:
   - who I am
   - what I’m building / looking for
   - interests / industries
   - goals (co-founder, advisor, investor, first clients, partnerships)
   - location / remote preference
3. As a user, I can swipe right or left on suggested profiles.
4. As a user:
   - right + right = match
   - right + left = no match
   - left + left = no match
5. As a user, I can see matches and chat.
6. As a user, I can unmatch or report.

## 3) Experience Principles ("Wow" UX)
- **Minimal UI:** clear typography, large touch targets, clean cards.
- **Motion-first polish:** 60fps gestures, spring physics, responsive card stacks.
- **Micro-interactions:** subtle scale/fade/glow on actions.
- **Instant feedback:** skeleton loaders, optimistic updates, smooth transitions.
- **Consistency:** one coherent design language (spacing, color, motion timing).

## 4) Feature Prioritization

### Must-have for launch
- Auth + onboarding flow
- Profile creation/edit
- Swipe deck + match logic
- Matches list
- 1:1 chat
- Basic moderation (block/report)

### Should-have (v1.1)
- Filters (industry, stage, location)
- Smart recommendations
- Push notifications (PWA)
- LinkedIn import

### Later (v2)
- AI profile improvement suggestions
- Icebreaker prompts
- Verified badges
- Team/company profiles
- Paid plans (boosts, advanced filters)

## 5) Product Architecture (Recommended)

### Frontend (mobile web, PWA-ready)
- **Framework:** Next.js (App Router) + TypeScript
- **Styling:** Tailwind CSS + design tokens
- **Animation:** Framer Motion + gesture handling
- **State/data:** TanStack Query + Zustand (UI state)

### Backend
- **API:** Next.js API routes or NestJS/Fastify
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Realtime chat:** WebSockets (Socket.IO) or Supabase Realtime
- **Auth:** Clerk/Auth.js/Supabase Auth
- **Storage:** S3-compatible for profile assets

### Infrastructure
- Vercel for frontend
- Managed Postgres (Neon/Supabase/RDS)
- Redis for ephemeral queues/cache
- Monitoring: Sentry + PostHog + OpenTelemetry

## 6) Data Model (MVP)
- `users`
- `profiles`
- `interests`
- `profile_interests` (many-to-many)
- `swipes` (from_user, to_user, direction)
- `matches` (user_a, user_b, matched_at)
- `conversations`
- `messages`
- `reports`
- `blocks`

**Match logic:** create match only when opposite swipe exists and both directions are `right`.

## 7) Matching & Ranking Strategy
Start simple and reliable:
1. Candidate pool by availability + block/report constraints.
2. Score by overlap:
   - interests
   - goal compatibility
   - location compatibility
   - activity recency
3. Diversity rule to avoid repetitive profile types.

Later, add learning-to-rank from engagement outcomes.

## 8) UI/UX System Plan

### Visual direction
- Neutral base colors + one strong brand accent.
- High contrast for readability.
- Card-centric layout optimized for thumb reach.

### Motion language
- Swipe threshold + velocity-based fling.
- Spring-based card return when swipe canceled.
- Match moment animation (confetti-lite, glow pulses).
- Transitions capped to ~200–350ms for responsiveness.

### Performance goals
- Time-to-interactive < 2.5s on mid-tier devices.
- Steady 55–60fps on swipe interactions.
- Avoid layout shifts; preload next card images.

## 9) Security, Trust & Safety
- Rate limiting, bot detection, abuse monitoring.
- Reporting flow with moderation queue.
- Privacy controls (hide company, hide location details).
- GDPR/CCPA-aligned data controls.

## 10) Analytics & KPIs

### Product KPIs
- Profile completion rate
- Swipes/day per active user
- Match rate (right-right / total right swipes)
- Conversation start rate after match
- 7-day and 30-day retention

### Quality KPIs
- Swipe latency
- Crash-free sessions
- Median API latency
- Chat message delivery success

## 11) Delivery Roadmap

### Phase 0 (1 week): Discovery + specification
- Brand direction
- UX wireframes + prototype
- Technical spec and data model

### Phase 1 (2–3 weeks): MVP foundation
- Auth, onboarding, profile creation
- Core DB schema + APIs
- Swipe UI shell with placeholder cards

### Phase 2 (2–3 weeks): Core matching product
- Real swipe persistence + match engine
- Matches screen + basic chat
- Reporting/blocking

### Phase 3 (1–2 weeks): Polish + launch prep
- Motion polish, performance optimization
- QA, analytics instrumentation
- Beta launch + feedback loop

## 12) Immediate Next Steps (Before Coding)
1. Finalize target persona(s): founder/investor/freelancer mix.
2. Lock brand + design system tokens.
3. Define exact onboarding questions and profile schema.
4. Approve MVP scope boundaries.
5. Draft clickable prototype for swipe, match, and chat flows.
6. Create sprint backlog from this plan.

---
If you want, the next step can be a **full clickable product specification** (screen-by-screen + API contracts + user flows + acceptance criteria) so implementation can start with minimal ambiguity.
