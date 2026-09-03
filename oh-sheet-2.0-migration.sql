-- Run this once against your production (Oracle VM) database before
-- deploying 2.0's backend. Safe to run even if some parts were already
-- applied — everything is guarded with IF NOT EXISTS.

-- 1. Password reset (resetToken/resetTokenExpiry) + session invalidation
--    (passwordChangedAt) on password reset.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetToken" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "resetTokenExpiry" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "User_resetToken_key" ON "User"("resetToken");

-- 2. Mutual-view message expiry (24h after both sides have seen it).
ALTER TABLE "DirectMessage" ADD COLUMN IF NOT EXISTS "senderSeenAt" TIMESTAMP(3);

-- 3. Reports on posts/comments/messages (not just users).
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "targetType" TEXT NOT NULL DEFAULT 'user';
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "postId" INTEGER;
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "commentId" INTEGER;
ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS "messageId" INTEGER;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_postId_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_commentId_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_commentId_fkey"
      FOREIGN KEY ("commentId") REFERENCES "Comment"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Report_messageId_fkey') THEN
    ALTER TABLE "Report" ADD CONSTRAINT "Report_messageId_fkey"
      FOREIGN KEY ("messageId") REFERENCES "DirectMessage"(id) ON UPDATE CASCADE ON DELETE SET NULL;
  END IF;
END $$;

-- 4. Built-in error logging (admin Errors tab).
CREATE TABLE IF NOT EXISTS "ErrorLog" (
  "id" SERIAL PRIMARY KEY,
  "message" TEXT NOT NULL,
  "stack" TEXT,
  "path" TEXT,
  "method" TEXT,
  "statusCode" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "ErrorLog_createdAt_idx" ON "ErrorLog"("createdAt");

-- 5. Built-in analytics (admin Analytics tab).
CREATE TABLE IF NOT EXISTS "PageView" (
  "id" SERIAL PRIMARY KEY,
  "path" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PageView_createdAt_idx" ON "PageView"("createdAt");

-- 6. Two-factor authentication (authenticator app + backup codes).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoFactorSecret" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "twoFactorBackupCodes" TEXT;

-- 7. Mute (feed-only mute, separate from Block).
CREATE TABLE IF NOT EXISTS "Mute" (
  "id"        SERIAL PRIMARY KEY,
  "muterId"   INTEGER NOT NULL,
  "mutedId"   INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "Mute_muterId_mutedId_key" ON "Mute"("muterId", "mutedId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Mute_muterId_fkey') THEN
    ALTER TABLE "Mute" ADD CONSTRAINT "Mute_muterId_fkey"
      FOREIGN KEY ("muterId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Mute_mutedId_fkey') THEN
    ALTER TABLE "Mute" ADD CONSTRAINT "Mute_mutedId_fkey"
      FOREIGN KEY ("mutedId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 8. Per-login session tracking (Settings > Account > Sessions: see who's
--    logged in, log out a specific device remotely).
CREATE TABLE IF NOT EXISTS "Session" (
  "id"           SERIAL PRIMARY KEY,
  "userId"       INTEGER NOT NULL,
  "jti"          TEXT NOT NULL,
  "userAgent"    TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt"    TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "Session_jti_key" ON "Session"("jti");
CREATE INDEX IF NOT EXISTS "Session_userId_idx" ON "Session"("userId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Session_userId_fkey') THEN
    ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 9. Auto-generated preview (OG) image for text-only posts.
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "ogImageUrl" TEXT;

-- 10. Full-text search (GET /api/search) — expression indexes, not backed
--     by a Prisma model since they index a computed to_tsvector() over
--     existing columns rather than a stored column of their own.
CREATE INDEX IF NOT EXISTS post_fts_idx ON "Post"
  USING GIN (to_tsvector('english', title || ' ' || content));
CREATE INDEX IF NOT EXISTS user_fts_idx ON "User"
  USING GIN (to_tsvector('english', username || ' ' || name || ' ' || coalesce(bio, '')));

-- 11. Browser push notification subscriptions (Settings > Appearance >
--     Push notifications).
CREATE TABLE IF NOT EXISTS "PushSubscription" (
  "id"        SERIAL PRIMARY KEY,
  "userId"    INTEGER NOT NULL,
  "endpoint"  TEXT NOT NULL,
  "p256dh"    TEXT NOT NULL,
  "auth"      TEXT NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PushSubscription_userId_fkey') THEN
    ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 12. Passkeys (Settings > Account > Passkeys) — WebAuthn credentials plus
--     the short-lived challenge table a registration/login ceremony parks
--     its random challenge in between "generate options" and "verify".
CREATE TABLE IF NOT EXISTS "Authenticator" (
  "id"           SERIAL PRIMARY KEY,
  "userId"       INTEGER NOT NULL,
  "credentialId" TEXT NOT NULL,
  "publicKey"    BYTEA NOT NULL,
  "counter"      BIGINT NOT NULL DEFAULT 0,
  "transports"   TEXT,
  "deviceLabel"  TEXT,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt"   TIMESTAMP(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS "Authenticator_credentialId_key" ON "Authenticator"("credentialId");
CREATE INDEX IF NOT EXISTS "Authenticator_userId_idx" ON "Authenticator"("userId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Authenticator_userId_fkey') THEN
    ALTER TABLE "Authenticator" ADD CONSTRAINT "Authenticator_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "WebAuthnChallenge" (
  "id"        TEXT PRIMARY KEY,
  "challenge" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);

-- 13. Rich text formatting (bold/italic/strikethrough/code/links) from the
--     post composer's toolbar. `content` keeps being the plain text.
ALTER TABLE "Post" ADD COLUMN IF NOT EXISTS "contentHtml" TEXT;

-- 14. Multi-image carousel posts (up to 4 images). `imageUrl` on Post
--     stays the first image for every existing single-image consumer;
--     this table holds the full ordered set only when there's more than one.
CREATE TABLE IF NOT EXISTS "PostImage" (
  "id"       SERIAL PRIMARY KEY,
  "postId"   INTEGER NOT NULL,
  "url"      TEXT NOT NULL,
  "position" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "PostImage_postId_idx" ON "PostImage"("postId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostImage_postId_fkey') THEN
    ALTER TABLE "PostImage" ADD CONSTRAINT "PostImage_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 15. Per-post view tracking, for the author-only "Post analytics" panel
--     (lifetime totals + a day-by-day trend). The post's own author's
--     views are never recorded (see post.controller.js's recordPostView).
CREATE TABLE IF NOT EXISTS "PostView" (
  "id"        SERIAL PRIMARY KEY,
  "postId"    INTEGER NOT NULL,
  "viewerId"  INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PostView_postId_createdAt_idx" ON "PostView"("postId", "createdAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PostView_postId_fkey') THEN
    ALTER TABLE "PostView" ADD CONSTRAINT "PostView_postId_fkey"
      FOREIGN KEY ("postId") REFERENCES "Post"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 16. Stories — an image, video, or text card that disappears 24h after
--     posting. Visible to the same audience as a normal post (this app has
--     no private-account concept). `expiresAt` is the source of truth for
--     visibility; the app also does opportunistic best-effort cleanup of
--     expired rows, but nothing depends on that actually running.
CREATE TABLE IF NOT EXISTS "Story" (
  "id"              SERIAL PRIMARY KEY,
  "authorId"        INTEGER NOT NULL,
  "imageUrl"        TEXT,
  "videoUrl"        TEXT,
  "text"            TEXT,
  "backgroundColor" TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"       TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "Story_authorId_createdAt_idx" ON "Story"("authorId", "createdAt");
CREATE INDEX IF NOT EXISTS "Story_expiresAt_idx" ON "Story"("expiresAt");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Story_authorId_fkey') THEN
    ALTER TABLE "Story" ADD CONSTRAINT "Story_authorId_fkey"
      FOREIGN KEY ("authorId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 17. One row per (story, viewer) — the story-viewer "seen" ring and the
--     author's view count on their own story.
CREATE TABLE IF NOT EXISTS "StoryView" (
  "id"        SERIAL PRIMARY KEY,
  "storyId"   INTEGER NOT NULL,
  "viewerId"  INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "StoryView_storyId_viewerId_key" ON "StoryView"("storyId", "viewerId");
CREATE INDEX IF NOT EXISTS "StoryView_storyId_idx" ON "StoryView"("storyId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StoryView_storyId_fkey') THEN
    ALTER TABLE "StoryView" ADD CONSTRAINT "StoryView_storyId_fkey"
      FOREIGN KEY ("storyId") REFERENCES "Story"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StoryView_viewerId_fkey') THEN
    ALTER TABLE "StoryView" ADD CONSTRAINT "StoryView_viewerId_fkey"
      FOREIGN KEY ("viewerId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;

-- 18. Uploaded images/videos (Media) — stored directly in this database,
--     no third-party storage. A post/profile's imageUrl/videoUrl/
--     avatarUrl/coverUrl field just points at "/api/media/<id>"; nothing
--     about those existing columns changes. This table was missing from
--     this file even though it's new-in-2.0 — every image/video upload,
--     avatar/cover change, and auto-generated OG preview card 500s
--     against the live database without it.
CREATE TABLE IF NOT EXISTS "Media" (
  "id"         SERIAL PRIMARY KEY,
  "data"       BYTEA NOT NULL,
  "mimeType"   TEXT NOT NULL,
  "byteSize"   INTEGER NOT NULL,
  "uploadedBy" INTEGER NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Media_uploadedBy_fkey') THEN
    ALTER TABLE "Media" ADD CONSTRAINT "Media_uploadedBy_fkey"
      FOREIGN KEY ("uploadedBy") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE;
  END IF;
END $$;
