const prisma = require("./prisma");

// Same charset/length rule as the frontend's mention-highlighting regex
// (src/lib/hashtags.js's MENTION_PATTERN) — kept in sync manually since
// this is plain string parsing, not a shared package.
const MENTION_PATTERN = /@([a-zA-Z0-9_]{3,30})/g;

function extractMentionedUsernames(text) {
  if (!text) return [];
  const found = [...text.matchAll(MENTION_PATTERN)].map((m) => m[1]);
  return [...new Set(found)];
}

// Looks up which of the mentioned usernames are real, non-deleted accounts
// (other than the author themselves) — silently drops anything else,
// same "don't 500 on a bad mention" approach as tagged-people lookups.
async function resolveMentionedUsers(text, authorId) {
  const usernames = extractMentionedUsernames(text);
  if (!usernames.length) return [];
  const users = await prisma.user.findMany({
    where: { username: { in: usernames }, deletedAt: null, id: { not: authorId } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

module.exports = { extractMentionedUsernames, resolveMentionedUsers };
