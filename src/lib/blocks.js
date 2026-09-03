const prisma = require("./prisma");

// Blocking is symmetric in effect even though the Block row is one-directional
// (blockerId -> blockedId): if A blocks B, B should be just as unable to see,
// vote on, comment on, or follow A as A is unable to see/interact with B.
// These two helpers are the single source of truth for that "either direction
// counts" rule — every feed listing and every write endpoint that touches a
// specific other user should go through one of them rather than querying the
// Block table directly.

// Whole-feed filtering: every id the viewer has blocked OR that has blocked
// the viewer, in one Set — subtract this from a feed's authorId list the
// same way getMutedAuthorIds() already does for mutes.
async function getBlockedUserIds(viewerId) {
  if (!viewerId) return new Set();
  const blocks = await prisma.block.findMany({
    where: { OR: [{ blockerId: viewerId }, { blockedId: viewerId }] },
    select: { blockerId: true, blockedId: true },
  });
  const ids = new Set();
  for (const b of blocks) {
    ids.add(b.blockerId === viewerId ? b.blockedId : b.blockerId);
  }
  return ids;
}

// Single-pair check for a write action between two specific users (voting on
// a post, commenting on it, following someone) — true if either has blocked
// the other.
async function isBlockedEitherWay(userIdA, userIdB) {
  if (!userIdA || !userIdB || userIdA === userIdB) return false;
  const block = await prisma.block.findFirst({
    where: {
      OR: [
        { blockerId: userIdA, blockedId: userIdB },
        { blockerId: userIdB, blockedId: userIdA },
      ],
    },
    select: { id: true },
  });
  return !!block;
}

module.exports = { getBlockedUserIds, isBlockedEitherWay };
