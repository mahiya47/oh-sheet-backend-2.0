const rateLimit = require("express-rate-limit");

// Shared JSON error shape so the frontend's existing error handling (which
// reads `message` off the response body) shows something sensible instead
// of the library's default plain-text response.
function handler(req, res) {
  res.status(429).json({ message: "Too many requests — please slow down and try again shortly." });
}

// Broad safety net on every /api route.
// Limits were raised well above what any real single user could hit —
// the app is brand new post-launch and a false-positive lockout (which is
// exactly what caused real, non-abusive users to get 429'd and bounced
// while the site was still shaking out — see AuthContext.jsx) is worse
// right now than being a little more lenient toward actual abuse. Worth
// dialing back down once traffic/abuse patterns are better understood.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Tighter limit for login/register/password-reset — these are the routes
// worth protecting against brute-force and mass-account creation.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Reports are cheap to spam and only need to happen a handful of times per
// user in normal use.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Analytics pings fire on every route change — generous, but still capped
// so the endpoint can't be used to flood the database.
const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

module.exports = { generalLimiter, authLimiter, reportLimiter, analyticsLimiter };
