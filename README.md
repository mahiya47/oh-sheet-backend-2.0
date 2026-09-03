# Oh Sheet! API (backend 2.0)

A brand-new Express + Prisma backend for the new "Oh Sheet!" frontend. It
connects to your **existing PostgreSQL database** — same tables, same users,
same posts. Nothing is migrated or deleted; this is a new server, not a new
database.

## What's included (Phase 1)

- Auth: register, login, JWT tokens, "who am I"
- Posts: create, edit, delete, feed (all / following / saved), repost
- Votes: upvote / downvote (reuses the old `Like` table — `type` is now
  `"up"` / `"down"` instead of the old emoji reaction names; old reaction
  rows are simply ignored, not deleted)
- Comments: unlimited-depth threaded replies
- Follow / unfollow, follower & following lists
- Bookmarks (Save)
- Block / unblock, report a user
- Profile: view by username, edit your own, search, "people to follow"

## Not included yet (from the old site, deferred to a later phase)

Email verification, Google/GitHub login, direct messages, notifications,
live chat, the arcade games, image/video uploads (post an already-hosted
image/video URL for now), and the welcome-bot / auto-comment bot behavior.
None of these touch your data — they can be added on top later without
another rewrite.

## Setup

```bash
npm install
```

Copy `.env.example` to `.env` and fill in:
- `DATABASE_URL` — your existing database's connection string
- `JWT_SECRET` — any long random string
- `FRONTEND_URL` — where your frontend runs (for CORS)

Then generate the Prisma client (this does **not** touch your database,
it just builds the query client from `prisma/schema.prisma`):

```bash
npx prisma generate
```

Run it:

```bash
npm run dev     # auto-restarts on changes
# or
npm start
```

By default it listens on `http://localhost:4000`.

## Sanity-checking your database connection

```bash
npx prisma db pull --print
```

This reads your real database's schema and prints it — if it matches
`prisma/schema.prisma`, you're wired up correctly. It does not change
anything.

## API overview

All routes are prefixed `/api`. Send `Authorization: Bearer <token>` for
anything marked (auth).

- `POST /auth/register` `{ name, username, email, password }`
- `POST /auth/login` `{ identifier, password }` → `{ token }`
- `GET /auth/me` (auth)
- `GET /posts` `?cursor=&limit=` — main feed
- `GET /posts/following` (auth)
- `GET /posts/saved/me` (auth)
- `GET /posts/user/:username`
- `POST /posts` (auth) `{ content, imageUrl?, videoUrl?, repostOfId? }`
- `GET /posts/:id`
- `PUT /posts/:id` (auth) `{ content }`
- `DELETE /posts/:id` (auth)
- `POST /posts/:id/vote` (auth) `{ type: "up" | "down" }`
- `GET /posts/:id/voters` → `{ upvoters: [...], downvoters: [...] }`
- `POST /posts/:id/bookmark` / `DELETE /posts/:id/bookmark` (auth)
- `GET /posts/:postId/comments`
- `POST /posts/:postId/comments` (auth) `{ content, parentId? }`
- `DELETE /posts/:postId/comments/:id` (auth)
- `GET /users/:username`
- `PUT /users/me` (auth) `{ name, bio, username, avatarUrl, coverUrl }`
- `GET /users/search?q=`
- `GET /users/suggestions`
- `GET /users/check-username/:username`
- `POST /follows/:userId` / `DELETE /follows/:userId` (auth)
- `GET /follows/:userId`, `/followers`, `/following`
- `POST /blocks/:userId` / `DELETE /blocks/:userId` (auth)
- `GET /blocks`, `/blocks/:userId/status`
- `POST /reports` (auth) `{ reportedUserId, reason }`
