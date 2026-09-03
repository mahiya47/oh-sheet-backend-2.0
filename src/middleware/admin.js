const prisma = require("../lib/prisma");
const { sendServerError } = require("../lib/errorLog");

// The one account allowed into the admin panel — Sourabh, the creator.
// Matched by username rather than a hardcoded id: ids aren't stable across
// databases/environments, and getting this wrong would either lock the
// creator out or (worse) hand admin access to whoever happens to hold that
// id. Case-insensitive so "SourabhMahiya", "sourabhmahiya", etc. all work.
const ADMIN_USERNAME = "sourabhmahiya";

// Must run after authMiddleware (needs req.userId already set).
async function adminMiddleware(req, res, next) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { username: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      return res.status(403).json({ message: "Admin access only" });
    }
    if ((user.username || "").toLowerCase() !== ADMIN_USERNAME) {
      return res.status(403).json({ message: "Admin access only" });
    }

    next();
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = adminMiddleware;
module.exports.ADMIN_USERNAME = ADMIN_USERNAME;
