const rateLimit = require("express-rate-limit");

// Shared JSON error shape so the frontend's existing error handling (which
// reads `message` off the response body) shows something sensible instead
// of the library's default plain-text response.
function handler(req, res) {
  res.status(429).json({ message: "Too many requests — please slow down and try again shortly." });
}

// Broad safety net on every /api route.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Tighter limit for login/register/password-reset — these are the routes
// worth protecting against brute-force and mass-account creation.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Reports are cheap to spam and only need to happen a handful of times per
// user in normal use.
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

// Analytics pings fire on every route change — generous, but still capped
// so the endpoint can't be used to flood the database.
const analyticsLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler,
});

module.exports = { generalLimiter, authLimiter, reportLimiter, analyticsLimiter };
