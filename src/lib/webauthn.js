const prisma = require("./prisma");

// Same domain-resolution pattern as seo.controller.js / feed.controller.js.
const SITE_URL = (process.env.SITE_URL || process.env.FRONTEND_URL || "http://localhost:5174").replace(/\/$/, "");

const RP_NAME = "Oh Sheet!";
const RP_ID = new URL(SITE_URL).hostname; // e.g. "ohsheet.blog" or "localhost" — no scheme/port

// WebAuthn checks the request's Origin header against this exact list.
// Locally the frontend gets started on whichever port is free (5173, 5174,
// the vite-preview 4173, ...) same as the CORS setup in app.js — so on
// localhost every common dev port is accepted rather than just one.
const EXPECTED_ORIGIN =
  RP_ID === "localhost"
    ? ["http://localhost:5173", "http://localhost:5174", "http://localhost:4173", SITE_URL]
    : [SITE_URL];

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

// Registration challenges are keyed by the (already-authenticated) user's
// id — only one registration can be in flight per user at a time, and
// starting a new one simply replaces the last. Login challenges are keyed
// by a random id handed to the client, since the user isn't known yet
// (that's the point of a discoverable/usernameless passkey login).
function registrationChallengeKey(userId) {
  return `reg:${userId}`;
}

async function saveChallenge(id, challenge) {
  await prisma.webAuthnChallenge.upsert({
    where: { id },
    create: { id, challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
    update: { challenge, expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS) },
  });
}

// Single-use: returns the challenge and deletes the row, or null if it
// never existed or has expired (also deleted, since it's stale either way).
async function consumeChallenge(id) {
  const row = await prisma.webAuthnChallenge.findUnique({ where: { id } });
  if (!row) return null;
  await prisma.webAuthnChallenge.delete({ where: { id } }).catch(() => {});
  if (row.expiresAt < new Date()) return null;
  return row.challenge;
}

module.exports = {
  RP_NAME,
  RP_ID,
  EXPECTED_ORIGIN,
  registrationChallengeKey,
  saveChallenge,
  consumeChallenge,
};
