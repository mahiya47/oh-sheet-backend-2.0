const prisma = require("../lib/prisma");
const { checkContent } = require("../lib/moderation");
const { publicUserSelect } = require("../utils/format");
const { sendServerError } = require("../lib/errorLog");

const STORY_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_STORY_TEXT = 300;
// Same five swatches FeedCard.jsx cycles a post card through — see
// CARD_COLORS there. Keeping the palette in sync (both lists, not a
// shared import) is a small, deliberate duplication: this file is
// backend-only and has no access to the frontend's CARD_COLORS constant.
const STORY_COLORS = new Set(["green", "yellow", "pink", "blue", "purple"]);
const DEFAULT_STORY_COLOR = "yellow";

function storySummary(story, viewerId) {
  return {
    id: story.id,
    imageUrl: story.imageUrl,
    videoUrl: story.videoUrl,
    text: story.text,
    backgroundColor: story.backgroundColor,
    createdAt: story.createdAt,
    expiresAt: story.expiresAt,
    author: story.author,
    authorId: story.authorId,
    isOwnStory: viewerId ? story.authorId === viewerId : false,
    isViewedByMe: viewerId
      ? story.authorId === viewerId || (story.views || []).some((v) => v.viewerId === viewerId)
      : false,
    viewCount: story._count?.views ?? 0,
  };
}

// Opportunistic cleanup, same spirit as auth.controller.js's
// purgeExpiredDeletedAccounts — every query below also filters on
// expiresAt itself, so nothing depends on this actually running.
async function purgeExpiredStories() {
  try {
    await prisma.story.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  } catch {
    // ignore — opportunistic only
  }
}

async function getMutedAuthorIds(viewerId) {
  if (!viewerId) return new Set();
  const mutes = await prisma.mute.findMany({ where: { muterId: viewerId }, select: { mutedId: true } });
  return new Set(mutes.map((m) => m.mutedId));
}

// POST /api/stories — create a story. Exactly one of imageUrl/videoUrl/text.
async function createStory(req, res) {
  try {
    const { imageUrl, videoUrl, text, backgroundColor } = req.body;
    const trimmedText = typeof text === "string" ? text.trim() : "";

    const kinds = [imageUrl, videoUrl, trimmedText].filter(Boolean).length;
    if (kinds === 0) {
      return res.status(400).json({ message: "Add an image, a video, or some text" });
    }
    if (kinds > 1) {
      return res.status(400).json({ message: "A story can only have one of image, video, or text" });
    }

    if (trimmedText) {
      if (trimmedText.length > MAX_STORY_TEXT) {
        return res.status(400).json({ message: `Keep it under ${MAX_STORY_TEXT} characters` });
      }
      const moderationError = checkContent(trimmedText);
      if (moderationError) return res.status(400).json({ message: moderationError });
    }

    const story = await prisma.story.create({
      data: {
        authorId: req.userId,
        imageUrl: imageUrl || null,
        videoUrl: videoUrl || null,
        text: trimmedText || null,
        backgroundColor: trimmedText
          ? STORY_COLORS.has(backgroundColor)
            ? backgroundColor
            : DEFAULT_STORY_COLOR
          : null,
        expiresAt: new Date(Date.now() + STORY_TTL_MS),
      },
      include: { author: { select: publicUserSelect } },
    });

    return res.status(201).json(storySummary(story, req.userId));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/stories — the stories bar: one entry per author with at least
// one active story, own stories first (if any), then everyone else by
// most-recent story first. Each entry carries its author's full story
// list plus whether the viewer has any unseen ones (for the ring).
async function getStoriesFeed(req, res) {
  try {
    await purgeExpiredStories();
    const mutedIds = await getMutedAuthorIds(req.userId);

    const stories = await prisma.story.findMany({
      where: {
        expiresAt: { gt: new Date() },
        ...(mutedIds.size && { authorId: { notIn: [...mutedIds] } }),
      },
      include: {
        author: { select: publicUserSelect },
        views: req.userId ? { where: { viewerId: req.userId } } : false,
        _count: { select: { views: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    const byAuthor = new Map();
    for (const story of stories) {
      if (!byAuthor.has(story.authorId)) {
        byAuthor.set(story.authorId, { author: story.author, authorId: story.authorId, stories: [] });
      }
      byAuthor.get(story.authorId).stories.push(storySummary(story, req.userId));
    }

    const groups = [...byAuthor.values()].map((g) => ({
      ...g,
      hasUnseen: g.stories.some((s) => !s.isViewedByMe),
      latestAt: g.stories[g.stories.length - 1].createdAt,
    }));

    groups.sort((a, b) => {
      if (req.userId) {
        if (a.authorId === req.userId) return -1;
        if (b.authorId === req.userId) return 1;
      }
      return new Date(b.latestAt) - new Date(a.latestAt);
    });

    return res.json(groups.map(({ latestAt, ...g }) => g));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/stories/:authorId — one author's active stories, oldest first
// (chronological playback order for the story viewer).
async function getAuthorStories(req, res) {
  try {
    await purgeExpiredStories();
    const authorId = Number(req.params.authorId);

    const stories = await prisma.story.findMany({
      where: { authorId, expiresAt: { gt: new Date() } },
      include: {
        author: { select: publicUserSelect },
        views: req.userId ? { where: { viewerId: req.userId } } : false,
        _count: { select: { views: true } },
      },
      orderBy: { createdAt: "asc" },
    });

    return res.json(stories.map((s) => storySummary(s, req.userId)));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST /api/stories/:id/view — mark a story viewed by the current user.
// Never records the author viewing their own story. Idempotent — viewing
// the same story twice is a no-op the second time.
async function viewStory(req, res) {
  try {
    const storyId = Number(req.params.id);
    const story = await prisma.story.findUnique({ where: { id: storyId }, select: { authorId: true } });
    if (story && story.authorId !== req.userId) {
      await prisma.storyView.upsert({
        where: { storyId_viewerId: { storyId, viewerId: req.userId } },
        update: {},
        create: { storyId, viewerId: req.userId },
      });
    }
    return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
}

// DELETE /api/stories/:id — the author removing their own story early.
async function deleteStory(req, res) {
  try {
    const id = Number(req.params.id);
    const story = await prisma.story.findUnique({ where: { id } });
    if (!story) return res.status(404).json({ message: "Story not found" });
    if (story.authorId !== req.userId) {
      return res.status(403).json({ message: "You can only delete your own stories" });
    }
    await prisma.story.delete({ where: { id } });
    return res.json({ message: "Story deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = {
  createStory,
  getStoriesFeed,
  getAuthorStories,
  viewStory,
  deleteStory,
  STORY_COLORS,
};
