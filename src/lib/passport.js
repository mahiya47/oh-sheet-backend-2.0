// Google / GitHub OAuth login — ported from the old backend's passport.js,
// with two adjustments for 2.0:
//  1. Strategies only register when their client id/secret are actually
//     present in the environment, so a dev machine without OAuth
//     credentials configured yet doesn't crash the whole server on boot.
//     `googleEnabled` / `githubEnabled` below tell the routes whether a
//     given provider is actually wired up.
//  2. The old app auto-followed the creator account by a hardcoded id
//     (CREATOR_ID = 5). 2.0's own codebase deliberately avoids hardcoded
//     ids for this (see middleware/admin.js, user.controller.js's
//     leaderboard exclusion) since ids aren't stable between the old
//     database and a fresh/local one — so this matches by username
//     instead, the same convention already used elsewhere in 2.0.
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const GitHubStrategy = require("passport-github2").Strategy;
const jwt = require("jsonwebtoken");
const prisma = require("./prisma");
const { followCreatorIfNew } = require("./creator");
const { sendBotWelcomeDms } = require("./bots");

// The one `state` blob carries two independent, optional signals set by
// auth.routes.js: `link` (an existing logged-in user attaching this OAuth
// account to their own, from Settings) and `intent` ("login" when the
// button that started this flow was specifically "Log in with Google/
// GitHub" on the Login page, as opposed to Signup). Neither implies the
// other, so they're parsed separately.
function parseOAuthState(req) {
  if (!req.query.state) return {};
  try {
    return JSON.parse(req.query.state) || {};
  } catch {
    return {};
  }
}

// Nonces already redeemed by an OAuth callback — see signLinkNonce() in
// auth.controller.js. Small and in-memory is fine: entries live at most
// LINK_NONCE_TTL (5 minutes) before the JWT itself would refuse them
// anyway, so this never grows unbounded, and losing it on a restart just
// means an in-flight link redirect has to be started over.
const consumedLinkNonces = new Set();

function parseLinkUserId(state) {
  try {
    if (!state.link || !state.nonce) return null;
    const decoded = jwt.verify(state.nonce, process.env.JWT_SECRET);
    // Deliberately a distinct, narrowly-scoped token from the real session
    // JWT (see signLinkNonce's comment) — never accept a real session token
    // here even if one is passed in this shape.
    if (decoded.purpose !== "oauth-link" || !decoded.jti) return null;
    if (consumedLinkNonces.has(decoded.jti)) return null; // one-time use
    consumedLinkNonces.add(decoded.jti);
    return decoded.userId;
  } catch {
    return null;
  }
}

async function uniqueUsername(base) {
  const cleaned = (base || "user").toLowerCase().replace(/[^a-z0-9_]/g, "") || "user";
  let username = cleaned;
  let suffix = 0;
  while (await prisma.user.findUnique({ where: { username } })) {
    suffix += 1;
    username = `${cleaned}${suffix}`;
  }
  return username;
}

const googleEnabled = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const githubEnabled = !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

if (googleEnabled) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: `${BACKEND_URL}/api/auth/google/callback`,
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value;
          if (!email) return done(new Error("No email from Google"));

          const state = parseOAuthState(req);
          const linkUserId = parseLinkUserId(state);

          if (linkUserId) {
            const already = await prisma.user.findUnique({ where: { googleId: profile.id } });
            if (already && already.id !== linkUserId) {
              return done(new Error("This Google account is already linked to another user"));
            }
            const user = await prisma.user.update({
              where: { id: linkUserId },
              data: { googleId: profile.id, emailVerified: true },
            });
            return done(null, user);
          }

          let user = await prisma.user.findUnique({ where: { googleId: profile.id } });

          if (!user) {
            user = await prisma.user.findUnique({ where: { email } });
            if (user) {
              user = await prisma.user.update({
                where: { id: user.id },
                data: { googleId: profile.id, emailVerified: true },
              });
            } else if (state.intent === "login") {
              // Someone clicked "Log in with Google" specifically — not
              // "Sign up" — and no Oh Sheet account is tied to this Google
              // account yet. Don't silently create one behind their back;
              // send them back to the login page to make that choice
              // themselves (it offers a link to sign up instead).
              return done(null, false, { code: "no_account" });
            } else {
              const username = await uniqueUsername(email.split("@")[0]);
              user = await prisma.user.create({
                data: {
                  name: profile.displayName || username,
                  username,
                  email,
                  googleId: profile.id,
                  avatarUrl: profile.photos?.[0]?.value || null,
                  emailVerified: true,
                },
              });
              user.isNewUser = true;
              await followCreatorIfNew(user.id);
              sendBotWelcomeDms(user);
            }
          }

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      },
    ),
  );
} else {
  console.warn("GOOGLE_CLIENT_ID/SECRET not set — Google login is disabled.");
}

if (githubEnabled) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET,
        callbackURL: `${BACKEND_URL}/api/auth/github/callback`,
        scope: ["user:email"],
        passReqToCallback: true,
      },
      async (req, accessToken, refreshToken, profile, done) => {
        try {
          const email = profile.emails?.[0]?.value || `${profile.username}@github.local`;

          const state = parseOAuthState(req);
          const linkUserId = parseLinkUserId(state);

          if (linkUserId) {
            const already = await prisma.user.findUnique({ where: { githubId: String(profile.id) } });
            if (already && already.id !== linkUserId) {
              return done(new Error("This GitHub account is already linked to another user"));
            }
            const user = await prisma.user.update({
              where: { id: linkUserId },
              data: { githubId: String(profile.id), emailVerified: true },
            });
            return done(null, user);
          }

          let user = await prisma.user.findUnique({ where: { githubId: String(profile.id) } });

          if (!user) {
            user = await prisma.user.findUnique({ where: { email } });
            if (user) {
              user = await prisma.user.update({
                where: { id: user.id },
                data: { githubId: String(profile.id), emailVerified: true },
              });
            } else if (state.intent === "login") {
              // Same reasoning as the Google strategy above: "Log in with
              // GitHub" on the Login page shouldn't silently create a new
              // account when this GitHub account isn't tied to one yet.
              return done(null, false, { code: "no_account" });
            } else {
              const username = await uniqueUsername(profile.username || email.split("@")[0]);
              user = await prisma.user.create({
                data: {
                  name: profile.displayName || username,
                  username,
                  email,
                  githubId: String(profile.id),
                  avatarUrl: profile.photos?.[0]?.value || null,
                  emailVerified: true,
                },
              });
              user.isNewUser = true;
              await followCreatorIfNew(user.id);
              sendBotWelcomeDms(user);
            }
          }

          return done(null, user);
        } catch (err) {
          return done(err);
        }
      },
    ),
  );
} else {
  console.warn("GITHUB_CLIENT_ID/SECRET not set — GitHub login is disabled.");
}

module.exports = passport;
module.exports.googleEnabled = googleEnabled;
module.exports.githubEnabled = githubEnabled;
