const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");

// Rejects a token issued before the user's last password reset (so
// resetting your password logs out every other device). One extra DB
// lookup per authenticated request, but it's the only way to invalidate an
// already-issued JWT — a fair trade for what this is protecting.
async function isTokenStale(decoded) {
  if (!decoded.iat) return false;
  const user = await prisma.user.findUnique({
    where: { id: decoded.userId },
    select: { passwordChangedAt: true },
  });
  if (!user || !user.passwordChangedAt) return false;
  return decoded.iat * 1000 < user.passwordChangedAt.getTime();
}

// Backs the Settings > Account > Sessions list — a revoked (or deleted)
// Session row means someone logged this device out remotely, so the token
// stops working immediately instead of riding out its full JWT expiry.
// Tokens issued before this feature shipped carry no `jti` at all — those
// have no Session row to check and are treated as still valid, same as
// before this existed.
const SESSION_ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;
async function isSessionRevoked(decoded) {
  if (!decoded.jti) return false;
  const session = await prisma.session.findUnique({ where: { jti: decoded.jti } });
  if (!session || session.revokedAt) return true;
  // Cheap "last active" bump, throttled so it isn't a write on every
  // single request — fire-and-forget, a missed update here doesn't matter.
  if (Date.now() - session.lastActiveAt.getTime() > SESSION_ACTIVITY_THROTTLE_MS) {
    prisma.session
      .update({ where: { id: session.id }, data: { lastActiveAt: new Date() } })
      .catch(() => {});
  }
  return false;
}

// Requires a valid "Authorization: Bearer <token>" header. Sets req.userId.
async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "No token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [stale, revoked] = await Promise.all([isTokenStale(decoded), isSessionRevoked(decoded)]);
    if (stale || revoked) {
      return res.status(401).json({ message: "Session expired — please log in again" });
    }
    req.userId = decoded.userId;
    req.sessionJti = decoded.jti || null;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

// Same as above, but never blocks the request — just leaves req.userId
// undefined when there's no/invalid token. Used on public endpoints that
// personalize their response when the caller happens to be logged in
// (e.g. "did I upvote this post already?").
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    try {
      const decoded = jwt.verify(
        authHeader.split(" ")[1],
        process.env.JWT_SECRET,
      );
      req.userId = decoded.userId;
    } catch {
      // ignore bad token, just treat as logged out
    }
  }
  next();
}

module.exports = authMiddleware;
module.exports.optionalAuth = optionalAuth;
