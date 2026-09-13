const prisma = require("../lib/prisma");
const { formatPost, postIncludeForFormat, publicUserSelect } = require("../utils/format");
const { createNotification } = require("../utils/notify");
const { getBotIds, randomBotCommentDelayMs } = require("../lib/bots");
const { generateCatNoise } = require("../lib/pikku");
const { generateComment } = require("../lib/groq");
const { checkContent } = require("../lib/moderation");
const { resolveMentionedUsers } = require("../lib/mentions");
const { generateOgImageBuffer } = require("../lib/ogImage");
const { sanitizeContentHtml } = require("../lib/richText");
const { normalizeTemplate } = require("../lib/postTemplates");
const { extractFirstUrl, fetchLinkPreview } = require("../lib/linkPreview");
const { mediaUrl } = require("./media.controller");
const { getBlockedUserIds } = require("../lib/blocks");
const { getHiddenPrivateAuthorIds, isPrivateAndHidden } = require("../lib/privacy");
const { sendServerError } = require("../lib/errorLog");

// Text-only posts (no imageUrl/videoUrl) get a generated branded preview
// card so link shares still show a preview image — see lib/ogImage.js.
// Posts that already have their own image/video just use that instead, so
// this is skipped entirely for those. Best-effort: a failure here should
// never block creating or editing a post.
async function generateAndAttachOgImage(post, req) {
  if (post.imageUrl || post.videoUrl || !post.content?.trim()) return;
  try {
    const authorLabel = `@${post.author?.username || "someone"} on Oh Sheet!`;
    const buffer = await generateOgImageBuffer(post, authorLabel);
    const media = await prisma.media.create({
      data: { data: buffer, mimeType: "image/png", byteSize: buffer.length, uploadedBy: post.authorId },
      select: { id: true },
    });
    await prisma.post.update({
      where: { id: post.id },
      data: { ogImageUrl: mediaUrl(req, media.id) },
    });
    post.ogImageUrl = mediaUrl(req, media.id);
  } catch (error) {
    console.error("OG image generation failed:", error.message);
  }
}

// Shared by createPost/updatePost — finds the first link in a post's
// plain-text content and, if there is one, scrapes it for an Open Graph
// preview card (see lib/linkPreview.js). Best-effort: no link, or a
// failed/timed-out scrape, both just mean no preview — never blocks
// posting or editing.
async function resolveLinkPreview(content) {
  const url = extractFirstUrl(content);
  if (!url) return null;
  return fetchLinkPreview(url);
}

// Shared by createPost/updatePost — notifies anyone @mentioned in the
// content, excluding the author and anyone already notified as a tagged
// person (avoids double-notifying the same person for the same post).
async function notifyMentions(content, postId, authorId, alreadyNotifiedIds = []) {
  const mentionedIds = await resolveMentionedUsers(content, authorId);
  const skip = new Set(alreadyNotifiedIds);
  for (const recipientId of mentionedIds) {
    if (skip.has(recipientId)) continue;
    await createNotification({ recipientId, actorId: authorId, type: "mention", postId });
  }
}

// Bot companions react to every new sheet a few minutes after it's
// posted — Pikku with a meow, Tonald with a (Groq-generated, or
// canned-fallback) reaction. Fire-and-forget: never awaited by the
// route handler, and each bot's own failure never affects the other's.
function scheduleBotComments(post) {
  const bots = getBotIds();
  if (!bots) return; // server started before bot accounts finished setting up

  const jobs = [];
  if (bots.pikku && bots.pikku !== post.authorId) {
    jobs.push({ botId: bots.pikku, getText: () => Promise.resolve(generateCatNoise()) });
  }
  if (bots.tonald && bots.tonald !== post.authorId) {
    jobs.push({ botId: bots.tonald, getText: () => generateComment(post.content) });
  }

  for (const job of jobs) {
    setTimeout(async () => {
      try {
        await prisma.comment.create({
          data: { content: await job.getText(), postId: post.id, userId: job.botId },
        });
        await createNotification({
          recipientId: post.authorId,
          actorId: job.botId,
          type: "comment",
          postId: post.id,
        });
      } catch (error) {
        console.error("Bot comment failed:", error.message);
      }
    }, randomBotCommentDelayMs());
  }
}

// Looks up which of a viewer's authors they follow + which posts they've
// bookmarked + which authors they've muted, for a batch of posts — shared
// by every feed-listing endpoint below so formatPost() can fill in
// isFollowedByMe / isBookmarked / isMutedByMe.
async function getViewerContext(viewerId, posts) {
  let followedAuthorIds = new Set();
  let bookmarkedPostIds = new Set();
  let mutedAuthorIds = new Set();
  if (!viewerId) return { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds };

  const authorIds = [...new Set(posts.map((p) => p.authorId))];
  const postIds = posts.map((p) => p.id);

  const [follows, bookmarks, mutes] = await Promise.all([
    authorIds.length
      ? prisma.follow.findMany({
          where: { followerId: viewerId, followingId: { in: authorIds } },
          select: { followingId: true },
        })
      : [],
    postIds.length
      ? prisma.bookmark.findMany({
          where: { userId: viewerId, postId: { in: postIds } },
          select: { postId: true },
        })
      : [],
    authorIds.length
      ? prisma.mute.findMany({
          where: { muterId: viewerId, mutedId: { in: authorIds } },
          select: { mutedId: true },
        })
      : [],
  ]);

  followedAuthorIds = new Set(follows.map((f) => f.followingId));
  bookmarkedPostIds = new Set(bookmarks.map((b) => b.postId));
  mutedAuthorIds = new Set(mutes.map((m) => m.mutedId));
  return { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds };
}

// Fetches just this viewer's full muted-authors set (not scoped to a batch
// of posts) — used by the main/following/trending feeds to filter muted
// authors OUT before the page is even built, unlike getViewerContext above
// which is for flagging isMutedByMe on posts that stay visible.
async function getMutedAuthorIds(viewerId) {
  if (!viewerId) return new Set();
  const mutes = await prisma.mute.findMany({ where: { muterId: viewerId }, select: { mutedId: true } });
  return new Set(mutes.map((m) => m.mutedId));
}

// Normalizes whatever the client sent for hashtags into a deduped list of
// lowercase, symbol-free tag names (max 15 per post, max 40 chars each).
function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  const seen = new Set();
  for (const raw of rawTags) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/^#/, "").toLowerCase().slice(0, 40);
    if (name && /^[a-z0-9_]+$/i.test(name)) seen.add(name);
    if (seen.size >= 15) break;
  }
  return [...seen];
}

// Normalizes whatever the client sent for tagged-people ids into a deduped
// list of positive integers (max 20 per post), excluding the poster.
function normalizeTaggedUserIds(rawIds, authorId) {
  if (!Array.isArray(rawIds)) return [];
  const seen = new Set();
  for (const raw of rawIds) {
    const id = Number(raw);
    if (Number.isInteger(id) && id > 0 && id !== authorId) seen.add(id);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

const MAX_POST_IMAGES = 4;

// Carousel images (see Post.images in schema.prisma). Returns `undefined`
// when the client didn't send this field at all — meaning "leave whatever
// images this post already has alone" on an edit, same convention as
// imageUrl/videoUrl below. An explicit (possibly empty) array means "this
// is the new full set" — capped at 4, silently dropping anything past
// that and any non-string/blank entry, same style as normalizeTags.
function normalizeImageUrls(raw) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return [];
  return raw.filter((u) => typeof u === "string" && u.trim()).slice(0, MAX_POST_IMAGES);
}

// POST /api/posts — create a new post.
async function createPost(req, res) {
  try {
    const { content, contentHtml, imageUrl, videoUrl } = req.body;
    const images = normalizeImageUrls(req.body.images);
    const tagNames = normalizeTags(req.body.tags);
    const taggedUserIds = normalizeTaggedUserIds(req.body.taggedUserIds, req.userId);
    const { templateType, templateData } = normalizeTemplate(
      req.body.templateType,
      req.body.templateData,
    );

    if (!content?.trim() && !imageUrl && !videoUrl && !images?.length && !templateData) {
      return res.status(400).json({ message: "Add some text, an image, or a video" });
    }

    const moderationError = checkContent(content);
    if (moderationError) {
      return res.status(400).json({ message: moderationError });
    }

    // Only tag people who actually exist (and aren't deleted) — silently
    // drop anything else rather than letting a bad id 500 the whole post.
    let validTaggedUserIds = [];
    if (taggedUserIds.length) {
      const validUsers = await prisma.user.findMany({
        where: { id: { in: taggedUserIds }, deletedAt: null },
        select: { id: true },
      });
      validTaggedUserIds = validUsers.map((u) => u.id);
    }

    const titleSource = (content && content.trim()) || "sheet";
    const slug =
      titleSource
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 60) +
      "-" +
      Date.now();

    const linkPreview = await resolveLinkPreview(content);

    const post = await prisma.post.create({
      data: {
        title: titleSource.slice(0, 120),
        content: content || "",
        contentHtml: sanitizeContentHtml(contentHtml),
        // A carousel (images.length) takes over imageUrl too — its first
        // image is what every single-image consumer (OG-skip check,
        // notification previews, RSS, older clients) sees.
        imageUrl: images?.length ? images[0] : imageUrl || null,
        videoUrl: videoUrl || null,
        published: true,
        authorId: req.userId,
        slug,
        templateType,
        templateData: templateData || undefined,
        linkPreview: linkPreview || undefined,
        ...(images?.length && {
          images: { create: images.map((url, position) => ({ url, position })) },
        }),
        ...(tagNames.length && {
          tags: {
            create: tagNames.map((name) => ({
              tag: { connectOrCreate: { where: { name }, create: { name } } },
            })),
          },
        }),
        ...(validTaggedUserIds.length && {
          taggedUsers: { create: validTaggedUserIds.map((userId) => ({ userId })) },
        }),
      },
      include: postIncludeForFormat,
    });

    await prisma.user.update({
      where: { id: req.userId },
      data: { score: { increment: 10 } },
    });

    for (const taggedId of validTaggedUserIds) {
      await createNotification({
        recipientId: taggedId,
        actorId: req.userId,
        type: "tagged",
        postId: post.id,
      });
    }

    scheduleBotComments(post);
    notifyMentions(content, post.id, req.userId, validTaggedUserIds);
    await generateAndAttachOgImage(post, req);

    return res.status(201).json(formatPost(post, req.userId));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts — the main feed, cursor-paginated (newest first).
async function getAllPosts(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const [mutedIds, blockedIds, privateIds] = await Promise.all([
      getMutedAuthorIds(req.userId),
      getBlockedUserIds(req.userId),
      getHiddenPrivateAuthorIds(req.userId),
    ]);
    const hiddenIds = new Set([...mutedIds, ...blockedIds, ...privateIds]);

    const posts = await prisma.post.findMany({
      where: {
        repostOfId: null,
        ...(hiddenIds.size && { authorId: { notIn: [...hiddenIds] } }),
      },
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { createdAt: "desc" },
      include: postIncludeForFormat,
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, page);
    const formatted = page.map((p) => formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));

    return res.json({ posts: formatted, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/following — only posts from people you follow.
async function getFollowingFeed(req, res) {
  try {
    const follows = await prisma.follow.findMany({
      where: { followerId: req.userId },
      select: { followingId: true },
    });
    const followingIds = follows.map((f) => f.followingId);
    const [mutedIds, blockedIds] = await Promise.all([
      getMutedAuthorIds(req.userId),
      getBlockedUserIds(req.userId),
    ]);
    const hiddenIds = new Set([...mutedIds, ...blockedIds]);
    const visibleFollowingIds = hiddenIds.size ? followingIds.filter((id) => !hiddenIds.has(id)) : followingIds;

    const posts = await prisma.post.findMany({
      where: { authorId: { in: visibleFollowingIds }, repostOfId: null },
      orderBy: { createdAt: "desc" },
      include: postIncludeForFormat,
    });

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, posts);
    const formatted = posts.map((p) => formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
    return res.json(formatted);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/saved/me — your bookmarked posts (the Save feature).
async function getSavedPosts(req, res) {
  try {
    const bookmarks = await prisma.bookmark.findMany({
      where: { userId: req.userId, post: { repostOfId: null } },
      include: { post: { include: postIncludeForFormat } },
      orderBy: { postId: "desc" },
    });
    const posts = bookmarks.map((b) => b.post);

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, posts);
    const formatted = posts.map((p) => formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
    return res.json(formatted);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/user/:username — a profile page's post list.
async function getPostsByUsername(req, res) {
  try {
    const author = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!author) return res.status(404).json({ message: "User not found" });

    if (await isPrivateAndHidden(author, req.userId)) {
      return res.status(403).json({ message: "This account is private", isPrivate: true });
    }

    const posts = await prisma.post.findMany({
      where: { authorId: author.id, repostOfId: null },
      orderBy: { createdAt: "desc" },
      include: postIncludeForFormat,
    });

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, posts);
    const formatted = posts.map((p) => formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
    return res.json(formatted);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/:id
async function getPostById(req, res) {
  try {
    const id = Number(req.params.id);
    const post = await prisma.post.findUnique({ where: { id }, include: postIncludeForFormat });
    if (!post || post.repostOfId) return res.status(404).json({ message: "Post not found" });

    // A private account's post is treated as not existing to anyone who
    // isn't the author or an accepted follower — same as visiting their
    // profile directly.
    if (await isPrivateAndHidden(post.author, req.userId)) {
      return res.status(404).json({ message: "Post not found" });
    }

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, [post]);
    return res.json(formatPost(post, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// PUT /api/posts/:id — edit your own post's text (the "Edit post" menu item).
async function updatePost(req, res) {
  try {
    const id = Number(req.params.id);
    const { content, contentHtml, imageUrl, videoUrl } = req.body;
    const images = normalizeImageUrls(req.body.images);

    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Post not found" });
    if (existing.authorId !== req.userId) {
      return res.status(403).json({ message: "You can only edit your own posts" });
    }

    // templateType/templateData are only touched when the client actually
    // sent one of them — omitting both from an edit (e.g. a plain caption
    // tweak from FeedCard's inline editor, which knows nothing about
    // templates) leaves whatever template the post already had alone.
    const touchesTemplate = req.body.templateType !== undefined || req.body.templateData !== undefined;
    const { templateType, templateData } = touchesTemplate
      ? normalizeTemplate(req.body.templateType, req.body.templateData)
      : { templateType: undefined, templateData: undefined };

    const moderationError = checkContent(content);
    if (moderationError) {
      return res.status(400).json({ message: moderationError });
    }

    // contentHtml sent -> use it (sanitized), whatever it resolves to.
    // contentHtml omitted but the plain text changed -> the edit came from
    // the plain-text edit form (FeedCard), which has no idea about the old
    // formatting, so clear it rather than risk showing stale rich HTML
    // that no longer matches the edited text. contentHtml omitted AND the
    // text is unchanged (e.g. only the attachment changed) -> leave
    // whatever rich formatting was already there alone.
    const nextContentHtml =
      contentHtml !== undefined
        ? sanitizeContentHtml(contentHtml)
        : content !== existing.content
          ? null
          : undefined;

    const nextLinkPreview =
      content !== undefined && content !== existing.content
        ? await resolveLinkPreview(content)
        : undefined;

    const updated = await prisma.post.update({
      where: { id },
      data: {
        content,
        contentHtml: nextContentHtml,
        templateType,
        templateData,
        linkPreview: nextLinkPreview,
        // undefined = leave unchanged; null = explicitly clear (attachment removed).
        // `images` sent (even []) overrides imageUrl with its first entry —
        // see normalizeImageUrls above.
        imageUrl:
          images !== undefined
            ? images[0] || null
            : imageUrl === undefined
              ? undefined
              : imageUrl || null,
        videoUrl: videoUrl === undefined ? undefined : videoUrl || null,
        ...(images !== undefined && {
          // Replace the whole carousel set rather than trying to diff it —
          // simplest correct behavior, and this only ever fires from the
          // composer/edit form sending its current full image list.
          images: { deleteMany: {}, create: images.map((url, position) => ({ url, position })) },
        }),
      },
      include: postIncludeForFormat,
    });

    // Regenerate the card when the text changed, or generate one for the
    // first time if an attached image/video was just removed — but don't
    // bother re-rendering on every trivial edit (e.g. just retagging).
    if (content !== existing.content || !updated.ogImageUrl) {
      await generateAndAttachOgImage(updated, req);
    }

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, [updated]);
    return res.json(formatPost(updated, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/posts/:id
async function deletePost(req, res) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Post not found" });
    if (existing.authorId !== req.userId) {
      return res.status(403).json({ message: "You can only delete your own posts" });
    }

    await prisma.post.delete({ where: { id } });
    return res.json({ message: "Post deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/:id/voters — who upvoted / who downvoted (the expanded
// post's "see who upvoted or downvoted" panel).
async function getPostVoters(req, res) {
  try {
    const id = Number(req.params.id);
    const likes = await prisma.like.findMany({
      where: { postId: id },
      include: { user: { select: publicUserSelect } },
    });

    const upvoters = likes.filter((l) => l.type === "up").map((l) => l.user);
    const downvoters = likes.filter((l) => l.type === "down").map((l) => l.user);
    return res.json({ upvoters, downvoters });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST/DELETE /api/posts/:id/bookmark — toggle Save.
async function toggleBookmark(req, res) {
  try {
    const postId = Number(req.params.id);
    const userId = req.userId;

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) return res.status(404).json({ message: "Post not found" });

    const existing = await prisma.bookmark.findUnique({
      where: { userId_postId: { userId, postId } },
    });

    if (existing) {
      await prisma.bookmark.delete({ where: { userId_postId: { userId, postId } } });
      return res.json({ message: "Bookmark removed", isBookmarked: false });
    }
    await prisma.bookmark.create({ data: { userId, postId } });
    return res.json({ message: "Bookmark added", isBookmarked: true });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/posts/:id/untag — a tagged person removing themselves from a
// post's "tagged" list. Anyone can only untag themselves, never someone else.
async function untagSelf(req, res) {
  try {
    const postId = Number(req.params.id);
    await prisma.postTaggedUser.deleteMany({
      where: { postId, userId: req.userId },
    });
    return res.json({ message: "Removed from tagged people" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// Trending only ranks posts from the last this-many days — without a
// bound, getTrendingPosts pulled every non-repost post ever made (with its
// full likes/comments/author/images include) into memory on every request,
// so the query and its memory footprint grew without limit as the app
// accumulated history. A rolling window keeps the query's size proportional
// to recent activity instead of total lifetime posts, which also happens
// to match what "trending" means to a reader — nobody expects a post from
// a year ago to still be duking it out for the trending spot.
const TRENDING_WINDOW_DAYS = 30;

// GET /api/posts/trending — posts ranked by engagement (upvotes + downvotes
// + comments) within the last TRENDING_WINDOW_DAYS days, most-engaged
// first. Still ranked in JS rather than a raw-SQL aggregate — the date
// filter above is what keeps this bounded, not the ranking step itself —
// so this still avoids hand-written SQL against the live database.
async function getTrendingPosts(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const [mutedIds, blockedIds, privateIds] = await Promise.all([
      getMutedAuthorIds(req.userId),
      getBlockedUserIds(req.userId),
      getHiddenPrivateAuthorIds(req.userId),
    ]);
    const hiddenIds = new Set([...mutedIds, ...blockedIds, ...privateIds]);
    const since = new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const posts = await prisma.post.findMany({
      where: {
        repostOfId: null,
        createdAt: { gte: since },
        ...(hiddenIds.size && { authorId: { notIn: [...hiddenIds] } }),
      },
      include: postIncludeForFormat,
    });

    const ranked = posts
      .map((p) => ({
        post: p,
        engagement: (p.likes?.length ?? 0) + (p._count?.comments ?? 0),
      }))
      .sort((a, b) => b.engagement - a.engagement || b.post.createdAt - a.post.createdAt)
      .slice(0, limit)
      .map((r) => r.post);

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, ranked);
    const formatted = ranked.map((p) => formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
    return res.json(formatted);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/tag/:name — every post carrying a given hashtag, newest first.
async function getPostsByTag(req, res) {
  try {
    const name = (req.params.name || "").trim().replace(/^#/, "").toLowerCase();
    if (!name) return res.json([]);

    const tag = await prisma.tag.findUnique({ where: { name } });
    if (!tag) return res.json([]);

    const [mutedIds, blockedIds, privateIds] = await Promise.all([
      getMutedAuthorIds(req.userId),
      getBlockedUserIds(req.userId),
      getHiddenPrivateAuthorIds(req.userId),
    ]);
    const hiddenIds = new Set([...mutedIds, ...blockedIds, ...privateIds]);

    const postTags = await prisma.postTag.findMany({
      where: {
        tagId: tag.id,
        post: {
          repostOfId: null,
          ...(hiddenIds.size && { authorId: { notIn: [...hiddenIds] } }),
        },
      },
      include: { post: { include: postIncludeForFormat } },
      orderBy: { post: { createdAt: "desc" } },
    });
    const posts = postTags.map((pt) => pt.post);

    const { followedAuthorIds, bookmarkedPostIds, mutedAuthorIds } = await getViewerContext(req.userId, posts);
    const formatted = posts.map((p) => formatPost(p, req.userId, followedAuthorIds, bookmarkedPostIds, mutedAuthorIds));
    return res.json(formatted);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST /api/posts/:id/view — records one view. Fired once per page load
// when a post is actually opened/expanded (see FeedCard.jsx), not on
// every feed-scroll impression. Works logged-out (optionalAuth) — those
// just get a null viewerId. The post's own author viewing their own post
// is never counted, so opening your own post to check on it doesn't
// inflate your own stats. Best-effort: never blocks or errors out loud,
// same spirit as generateAndAttachOgImage above.
async function recordPostView(req, res) {
  try {
    const postId = Number(req.params.id);
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { authorId: true } });
    if (post && post.authorId !== req.userId) {
      await prisma.postView.create({ data: { postId, viewerId: req.userId || null } });
    }
    return res.status(204).end();
  } catch {
    // Never let a view-tracking hiccup surface to the viewer.
    return res.status(204).end();
  }
}

const ANALYTICS_TREND_DAYS = 30;

// GET /api/posts/:id/analytics — lifetime totals plus a day-by-day view
// trend for the last ANALYTICS_TREND_DAYS days, for the post's own
// author only (see PostAnalytics.jsx on the frontend).
async function getPostAnalytics(req, res) {
  try {
    const postId = Number(req.params.id);
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) return res.status(404).json({ message: "Post not found" });
    if (post.authorId !== req.userId) {
      return res.status(403).json({ message: "You can only view analytics for your own posts" });
    }

    const since = new Date();
    since.setDate(since.getDate() - (ANALYTICS_TREND_DAYS - 1));
    since.setHours(0, 0, 0, 0);

    const [viewCount, likes, commentCount, bookmarkCount, recentViews] = await Promise.all([
      prisma.postView.count({ where: { postId } }),
      prisma.like.findMany({ where: { postId }, select: { type: true } }),
      prisma.comment.count({ where: { postId } }),
      prisma.bookmark.count({ where: { postId } }),
      prisma.postView.findMany({ where: { postId, createdAt: { gte: since } }, select: { createdAt: true } }),
    ]);

    // Zero-filled day-by-day bucket so the trend chart has a real X axis
    // (a day with no views is a real 0, not a gap) — cheap in JS at this
    // app's scale rather than a raw-SQL date_trunc/generate_series query.
    const buckets = new Map();
    for (let i = 0; i < ANALYTICS_TREND_DAYS; i++) {
      const d = new Date(since);
      d.setDate(d.getDate() + i);
      buckets.set(d.toISOString().slice(0, 10), 0);
    }
    for (const v of recentViews) {
      const key = v.createdAt.toISOString().slice(0, 10);
      if (buckets.has(key)) buckets.set(key, buckets.get(key) + 1);
    }

    return res.json({
      viewCount,
      upvotes: likes.filter((l) => l.type === "up").length,
      downvotes: likes.filter((l) => l.type === "down").length,
      commentCount,
      bookmarkCount,
      dailyViews: [...buckets.entries()].map(([date, count]) => ({ date, count })),
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = {
  createPost,
  getAllPosts,
  getFollowingFeed,
  getSavedPosts,
  getPostsByUsername,
  getPostById,
  updatePost,
  deletePost,
  getPostVoters,
  toggleBookmark,
  untagSelf,
  getPostsByTag,
  recordPostView,
  getPostAnalytics,
  getTrendingPosts,
  // Exported for search.controller.js — same "did I vote/follow/bookmark
  // this" flags on search results as everywhere else posts render.
  getViewerContext,
};
