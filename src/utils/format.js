// Shared shaping helpers so every controller sends the frontend the same
// consistent shapes.

// Public-safe fields for a user shown inside a post/comment/follow list.
// (No email/password — email is only ever returned on the "who am I" route.)
const publicUserSelect = {
  id: true,
  name: true,
  username: true,
  bio: true,
  avatarUrl: true,
  coverUrl: true,
  emailVerified: true,
  currentStreak: true,
};

const postIncludeForFormat = {
  author: { select: publicUserSelect },
  _count: { select: { comments: true } },
  likes: { select: { userId: true, type: true } },
  tags: { include: { tag: true } },
  taggedUsers: { include: { user: { select: publicUserSelect } } },
  images: { orderBy: { position: "asc" } },
};

// Turns a raw Prisma Post (with the includes above) into the shape the
// frontend actually wants: vote counts + "did I vote" instead of the raw
// likes array, a bookmark flag, and a follow flag for the author.
function formatPost(post, viewerId, followedAuthorIds = new Set(), bookmarkedPostIds = new Set(), mutedAuthorIds = new Set()) {
  if (!post) return post;

  const likes = post.likes || [];
  const upvotes = likes.filter((l) => l.type === "up").length;
  const downvotes = likes.filter((l) => l.type === "down").length;
  const mine = viewerId ? likes.find((l) => l.userId === viewerId) : null;

  return {
    id: post.id,
    title: post.title,
    slug: post.slug,
    content: post.content,
    // Sanitized, hashtag/mention-linked rich HTML from the composer's
    // toolbar — null for plain-text posts (or a plain-text edit), which
    // render from `content` above instead. See lib/richText.js.
    contentHtml: post.contentHtml,
    imageUrl: post.imageUrl,
    // Full ordered image set for a carousel post (up to 4); empty for a
    // single-image or text/video post — those just use imageUrl above.
    // See Post.images in schema.prisma.
    images: (post.images || []).map((img) => img.url),
    videoUrl: post.videoUrl,
    // Only meaningful when imageUrl/videoUrl are both empty — see
    // lib/ogImage.js. The frontend's <meta property="og:image"> falls back
    // to this for text-only posts.
    ogImageUrl: post.ogImageUrl,
    published: post.published,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    author: post.author,
    authorId: post.authorId,
    commentCount: post._count?.comments ?? 0,
    upvotes,
    downvotes,
    myVote: mine ? mine.type : null,
    isBookmarked: viewerId ? bookmarkedPostIds.has(post.id) : false,
    isFollowedByMe: viewerId
      ? post.authorId === viewerId || followedAuthorIds.has(post.authorId)
      : false,
    isOwnPost: viewerId ? post.authorId === viewerId : false,
    tags: (post.tags || []).map((pt) => pt.tag.name),
    taggedUsers: (post.taggedUsers || []).map((tu) => tu.user),
    isTaggedInThis: viewerId
      ? (post.taggedUsers || []).some((tu) => tu.userId === viewerId)
      : false,
    isMutedByMe: viewerId ? mutedAuthorIds.has(post.authorId) : false,
  };
}

// Nests a flat list of comments (each with parentId) into a tree of
// { ...comment, replies: [...] }. Supports unlimited depth — unlike the
// previous backend, replies-to-replies keep their own place in the tree
// instead of being flattened onto the top-level comment.
function buildCommentTree(flatComments) {
  const byId = new Map();
  for (const c of flatComments) {
    byId.set(c.id, { ...c, replies: [] });
  }

  const roots = [];
  for (const c of flatComments) {
    const node = byId.get(c.id);
    if (c.parentId && byId.has(c.parentId)) {
      byId.get(c.parentId).replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

module.exports = {
  publicUserSelect,
  postIncludeForFormat,
  formatPost,
  buildCommentTree,
};
