const prisma = require("./prisma");

// The one account every new signup auto-follows — matches
// middleware/admin.js's ADMIN_USERNAME by username, not id (ids aren't
// stable between a fresh database and production).
//
// Case-insensitive on purpose: the real account's stored username is
// "SourabhMahiya", not all lower-case. A plain equality match against
// this constant silently found nothing for every single signup (Postgres
// string comparison is case-sensitive by default) and nobody ever got
// auto-followed — caught by the try/catch below, so it never even
// logged an error. Fixed by matching case-insensitively, the same way
// admin.js already compares it.
const CREATOR_USERNAME = "sourabhmahiya";

async function followCreatorIfNew(userId) {
  try {
    const creator = await prisma.user.findFirst({
      where: { username: { equals: CREATOR_USERNAME, mode: "insensitive" } },
    });
    if (creator && creator.id !== userId) {
      await prisma.follow.create({ data: { followerId: userId, followingId: creator.id } });
    }
  } catch {
    // Already following, creator account doesn't exist in this DB, etc. —
    // never let this block account creation.
  }
}

module.exports = { CREATOR_USERNAME, followCreatorIfNew };
