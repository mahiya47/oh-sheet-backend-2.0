const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const passport = require("../lib/passport");
const { authLimiter } = require("../middleware/rateLimit");
const {
  register,
  login,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  getMe,
  deleteAccount,
  signToken,
  verifyLogin2FA,
  setup2FA,
  enable2FA,
  disable2FA,
  getSessions,
  revokeSession,
  issueSession,
  getOAuthLinkNonce,
} = require("../controllers/auth.controller");
const {
  listPasskeys,
  generateRegisterOptions,
  verifyRegister,
  deletePasskey,
  generateLoginOptions,
  verifyLogin: verifyPasskeyLogin,
} = require("../controllers/passkey.controller");

router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/2fa/verify-login", authLimiter, verifyLogin2FA);
router.get("/me", authMiddleware, getMe);
router.delete("/me", authMiddleware, deleteAccount);

router.post("/2fa/setup", authMiddleware, setup2FA);
router.post("/2fa/enable", authMiddleware, enable2FA);
router.post("/2fa/disable", authMiddleware, disable2FA);

router.get("/sessions", authMiddleware, getSessions);
router.delete("/sessions/:id", authMiddleware, revokeSession);

// Issues the short-lived, one-time nonce the frontend uses to start an
// OAuth account-link flow (see the /google/link and /github/link routes
// below, and getOAuthLinkNonce's own comment) instead of putting the
// real session JWT in that URL.
router.post("/link-nonce", authMiddleware, getOAuthLinkNonce);

// Passkeys — registering one requires being logged in already (Settings >
// Account); logging in WITH one is, by definition, the opposite.
router.get("/passkeys", authMiddleware, listPasskeys);
router.post("/passkeys/register-options", authMiddleware, generateRegisterOptions);
router.post("/passkeys/register-verify", authMiddleware, verifyRegister);
router.delete("/passkeys/:id", authMiddleware, deletePasskey);
router.post("/passkeys/login-options", authLimiter, generateLoginOptions);
router.post("/passkeys/login-verify", authLimiter, verifyPasskeyLogin);

router.get("/verify/:token", verifyEmail);
router.post("/resend-verification", authMiddleware, resendVerification);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password/:token", authLimiter, resetPassword);

const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5174";

async function issueTokenAndRedirect(req, res) {
  const token = await issueSession(req.user, req);
  const isNew = req.user.isNewUser ? 1 : 0;
  res.redirect(`${FRONTEND_URL}/oauth-callback?token=${token}&isNew=${isNew}`);
}

function notConfigured(provider) {
  return (req, res) =>
    res
      .status(503)
      .json({ message: `${provider} login isn't configured on this server yet.` });
}

// Custom (err, user, info) authenticate callback shared by both providers'
// /callback routes. Unlike the `failureRedirect` shorthand, this form lets
// us read the `info.code` a strategy attaches via `done(null, false, info)`
// — specifically "no_account", set when someone clicked "Log in with
// Google/GitHub" on the Login page and no Oh Sheet account matched. That
// case redirects back to Login with a query flag so it can show a message
// and offer a link to Signup, instead of silently creating an account or
// showing passport's generic failure redirect.
function oauthCallback(provider) {
  return (req, res, next) => {
    passport.authenticate(provider, { session: false }, (err, user, info) => {
      if (err) return next(err);
      if (!user) {
        if (info?.code === "no_account") {
          return res.redirect(`${FRONTEND_URL}/login?oauthError=no_account&provider=${provider}`);
        }
        return res.redirect(`${FRONTEND_URL}/login`);
      }
      req.user = user;
      return issueTokenAndRedirect(req, res).catch(next);
    })(req, res, next);
  };
}

// Builds the `state` param carrying the initiating page's intent (see
// passport.js's parseOAuthState) — set only when the button that started
// this flow was specifically "Log in with ..." on the Login page, so the
// strategy knows not to auto-create an account on a miss. Signup-page OAuth
// omits `intent` entirely and keeps auto-creating, unchanged.
function withIntentState(req) {
  return req.query.intent === "login" ? JSON.stringify({ intent: "login" }) : undefined;
}

// ---- Google ----
if (passport.googleEnabled) {
  router.get("/google", (req, res, next) => {
    passport.authenticate("google", { scope: ["profile", "email"], session: false, state: withIntentState(req) })(
      req,
      res,
      next,
    );
  });
  router.get("/google/callback", oauthCallback("google"));
  router.get("/google/link", (req, res, next) => {
    const state = JSON.stringify({ link: true, nonce: req.query.nonce });
    passport.authenticate("google", { scope: ["profile", "email"], session: false, state })(req, res, next);
  });
} else {
  router.get("/google", notConfigured("Google"));
  router.get("/google/link", notConfigured("Google"));
}

// ---- GitHub ----
if (passport.githubEnabled) {
  router.get("/github", (req, res, next) => {
    passport.authenticate("github", { scope: ["user:email"], session: false, state: withIntentState(req) })(
      req,
      res,
      next,
    );
  });
  router.get("/github/callback", oauthCallback("github"));
  router.get("/github/link", (req, res, next) => {
    const state = JSON.stringify({ link: true, nonce: req.query.nonce });
    passport.authenticate("github", { scope: ["user:email"], session: false, state })(req, res, next);
  });
} else {
  router.get("/github", notConfigured("GitHub"));
  router.get("/github/link", notConfigured("GitHub"));
}

module.exports = router;
