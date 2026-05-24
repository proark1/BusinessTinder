-- Postgres schema mirroring backend/prisma/schema.prisma.
--
-- IMPORTANT: schema.prisma is the source of truth. This file exists so that
-- operators who don't run Prisma migrations can still spin up a compatible
-- database, and so that schema reviews can happen in plain SQL.
--
-- When you change schema.prisma, update this file in the same commit. The
-- test in test/schema-parity.test.js will fail if the two drift.

CREATE TYPE "SwipeDirection" AS ENUM ('LEFT', 'RIGHT', 'SUPER_LIKE');
CREATE TYPE "MessageStatus" AS ENUM ('SENT', 'DELIVERED', 'READ');

CREATE TABLE IF NOT EXISTS "User" (
  "id"                    TEXT PRIMARY KEY,
  "email"                 TEXT UNIQUE NOT NULL,
  "passwordHash"          TEXT NOT NULL,
  "fullName"              TEXT NOT NULL,
  "googleSub"             TEXT UNIQUE,
  "avatarUrl"             TEXT,
  "planTier"              TEXT NOT NULL DEFAULT 'FREE',
  "planExpiresAt"         TIMESTAMPTZ,
  "referralCode"          TEXT UNIQUE,
  "referredBy"            TEXT,
  "lastSwipeDay"          TEXT,
  "swipesToday"           INTEGER NOT NULL DEFAULT 0,
  "notifPushOptIn"        BOOLEAN NOT NULL DEFAULT FALSE,
  "emailVerified"         BOOLEAN NOT NULL DEFAULT FALSE,
  "verificationToken"     TEXT UNIQUE,
  "resetToken"            TEXT UNIQUE,
  "resetTokenExpiresAt"   TIMESTAMPTZ,
  "verified"              BOOLEAN NOT NULL DEFAULT FALSE,
  "lastLikeRevealDay"     TEXT,
  "likeRevealsToday"      INTEGER NOT NULL DEFAULT 0,
  "revealedLikerIds"      TEXT[] NOT NULL DEFAULT '{}',
  "boostUntil"            TIMESTAMPTZ,
  "lastBoostDay"          TEXT,
  "bannedAt"              TIMESTAMPTZ,
  "bannedUntil"           TIMESTAMPTZ,
  "banReason"             TEXT,
  "createdAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Profile" (
  "id"             TEXT PRIMARY KEY,
  "userId"         TEXT UNIQUE NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "slug"           TEXT UNIQUE NOT NULL,
  "headline"       TEXT NOT NULL,
  "userType"       TEXT NOT NULL,
  "lookingFor"     TEXT[] NOT NULL DEFAULT '{}',
  "bio"            TEXT NOT NULL,
  "stage"          TEXT NOT NULL,
  "industries"     TEXT[] NOT NULL DEFAULT '{}',
  "skills"         TEXT[] NOT NULL DEFAULT '{}',
  "location"       TEXT NOT NULL,
  "latitude"       DOUBLE PRECISION,
  "longitude"      DOUBLE PRECISION,
  "remoteOk"       BOOLEAN NOT NULL DEFAULT FALSE,
  "commitment"     TEXT,
  "linkedinUrl"    TEXT,
  "avatarUrl"      TEXT,
  "photoUrl"       TEXT,
  "photos"         TEXT[] NOT NULL DEFAULT '{}',
  "pastCompanies"  TEXT[] NOT NULL DEFAULT '{}',
  "hoursPerWeek"   INTEGER,
  "calLink"        TEXT,
  "pitchDeckUrl"   TEXT,
  "promptIds"      TEXT[] NOT NULL DEFAULT '{}',
  "promptAnswers"  TEXT[] NOT NULL DEFAULT '{}',
  "lastActiveAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "ProfileView" (
  "id"        TEXT PRIMARY KEY,
  "viewerId"  TEXT NOT NULL,
  "viewedId"  TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "ProfileView_viewedId_createdAt_idx" ON "ProfileView" ("viewedId", "createdAt");
CREATE INDEX IF NOT EXISTS "ProfileView_viewerId_viewedId_idx" ON "ProfileView" ("viewerId", "viewedId");

CREATE TABLE IF NOT EXISTS "Swipe" (
  "id"         TEXT PRIMARY KEY,
  "fromUserId" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "toUserId"   TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "direction"  "SwipeDirection" NOT NULL,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("fromUserId", "toUserId")
);
CREATE INDEX IF NOT EXISTS "Swipe_toUserId_direction_idx" ON "Swipe" ("toUserId", "direction");

CREATE TABLE IF NOT EXISTS "Match" (
  "id"        TEXT PRIMARY KEY,
  "userAId"   TEXT NOT NULL,
  "userBId"   TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("userAId", "userBId")
);
CREATE INDEX IF NOT EXISTS "Match_userBId_idx" ON "Match" ("userBId");

CREATE TABLE IF NOT EXISTS "Conversation" (
  "id"        TEXT PRIMARY KEY,
  "matchId"   TEXT UNIQUE NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "Message" (
  "id"             TEXT PRIMARY KEY,
  "conversationId" TEXT NOT NULL REFERENCES "Conversation"("id") ON DELETE CASCADE,
  "senderId"       TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "body"           TEXT NOT NULL,
  "status"         "MessageStatus" NOT NULL DEFAULT 'SENT',
  "kind"           TEXT NOT NULL DEFAULT 'text',
  "createdAt"      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message" ("conversationId", "createdAt");

CREATE TABLE IF NOT EXISTS "SavedProfile" (
  "id"            TEXT PRIMARY KEY,
  "userId"        TEXT NOT NULL,
  "profileUserId" TEXT NOT NULL,
  "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("userId", "profileUserId")
);

CREATE TABLE IF NOT EXISTS "Report" (
  "id"           TEXT PRIMARY KEY,
  "reporterId"   TEXT NOT NULL,
  "targetId"     TEXT NOT NULL,
  "reason"       TEXT,
  "status"       TEXT NOT NULL DEFAULT 'OPEN',
  "reviewedAt"   TIMESTAMPTZ,
  "reviewedById" TEXT,
  "createdAt"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "Report_status_createdAt_idx" ON "Report" ("status", "createdAt");

CREATE TABLE IF NOT EXISTS "Block" (
  "id"        TEXT PRIMARY KEY,
  "blockerId" TEXT NOT NULL,
  "targetId"  TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("blockerId", "targetId")
);
CREATE INDEX IF NOT EXISTS "Block_targetId_idx" ON "Block" ("targetId");

CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"        TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "endpoint"  TEXT UNIQUE NOT NULL,
  "p256dh"    TEXT NOT NULL,
  "auth"      TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription" ("userId");
