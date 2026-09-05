const prisma = require("./prisma");

// Every feed-style listing (main feed, trending, tag pages, search) needs
// to leave out posts from private accounts the viewer doesn't already
// follow — same idea as getMutedAuthorIds/getBlockedUserIds in
// post.controller.js, and meant to be unioned into the same "hidden
// author ids" set those already build. A private account's own owner
// always sees their own posts, of course.
async function getHiddenPrivateAuthorIds(viewerId) {
  const privateUsers = await prisma.user.findMany({
    where: { isPrivate: true },
    select: { id: true },
  });
  const privateIds = privateUsers.map((u) => u.id).filter((id) => id !== viewerId);
  if (!privateIds.length) return new Set();
  if (!viewerId) return new Set(privateIds);

  const following = await prisma.follow.findMany({
    where: { followerId: viewerId, followingId: { in: privateIds } },
    select: { followingId: true },
  });
  const followedSet = new Set(following.map((f) => f.followingId));
  return new Set(privateIds.filter((id) => !followedSet.has(id)));
}

// Used by single-post/single-profile lookups (getPostById,
// getPostsByUsername) — is this one author's private account hidden from
// this one viewer?
async function isPrivateAndHidden(author, viewerId) {
  if (!author?.isPrivate) return false;
  if (viewerId && viewerId === author.id) return false;
  if (!viewerId) return true;
  const rel = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: viewerId, followingId: author.id } },
  });
  return !rel;
}

module.exports = { getHiddenPrivateAuthorIds, isPrivateAndHidden };
