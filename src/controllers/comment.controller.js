const prisma = require("../lib/prisma");
const { publicUserSelect, buildCommentTree } = require("../utils/format");
const { createNotification } = require("../utils/notify");
const { checkContent } = require("../lib/moderation");
const { resolveMentionedUsers } = require("../lib/mentions");
const { isBlockedEitherWay } = require("../lib/blocks");
const { sendServerError } = require("../lib/errorLog");

// Unlike the old backend, replies are NOT flattened to one level here —
// a reply to a reply keeps its own place in the tree, matching the
// already-shipped recursive comment UI in the new frontend.

// POST /api/posts/:postId/comments  { content, parentId? }
async function createComment(req, res) {
  try {
    const postId = Number(req.params.postId);
    const { content, parentId } = req.body;

    if (!content?.trim()) {
      return res.status(400).json({ message: "Comment content is required" });
    }

    const moderationError = checkContent(content);
    if (moderationError) {
      return res.status(400).json({ message: moderationError });
    }

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (await isBlockedEitherWay(req.userId, post.authorId)) {
      return res.status(403).json({ message: "You can't do that" });
    }

    let parent = null;
    if (parentId) {
      parent = await prisma.comment.findUnique({ where: { id: Number(parentId) } });
      if (!parent || parent.postId !== postId) {
        return res.status(400).json({ message: "Invalid parent comment" });
      }
      // Replying to a specific comment is also an interaction with whoever
      // wrote it, not just the post's author — same block check applies.
      if (await isBlockedEitherWay(req.userId, parent.userId)) {
        return res.status(403).json({ message: "You can't do that" });
      }
    }

    const comment = await prisma.comment.create({
      data: {
        content: content.trim(),
        postId,
        userId: req.userId,
        ...(parent && { parentId: parent.id }),
      },
      include: { user: { select: publicUserSelect } },
    });

    await prisma.user.update({
      where: { id: req.userId },
      data: { score: { increment: 1 } },
    });
    if (post.authorId !== req.userId) {
      await prisma.user.update({
        where: { id: post.authorId },
        data: { score: { increment: 3 } },
      });
    }

    const alreadyNotified = new Set();
    if (parent) {
      // A reply notifies the comment it's replying to, not the post author.
      await createNotification({
        recipientId: parent.userId,
        actorId: req.userId,
        type: "reply",
        postId,
      });
      alreadyNotified.add(parent.userId);
    } else {
      await createNotification({
        recipientId: post.authorId,
        actorId: req.userId,
        type: "comment",
        postId,
      });
      alreadyNotified.add(post.authorId);
    }

    const mentionedIds = await resolveMentionedUsers(content, req.userId);
    for (const recipientId of mentionedIds) {
      if (alreadyNotified.has(recipientId)) continue;
      await createNotification({ recipientId, actorId: req.userId, type: "mention", postId });
    }

    return res.status(201).json({ ...comment, replies: [] });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/posts/:postId/comments — the full thread, nested.
async function getCommentsByPost(req, res) {
  try {
    const postId = Number(req.params.postId);

    const flat = await prisma.comment.findMany({
      where: { postId },
      orderBy: { createdAt: "asc" },
      include: { user: { select: publicUserSelect } },
    });

    return res.json(buildCommentTree(flat));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/posts/:postId/comments/:id
async function deleteComment(req, res) {
  try {
    const id = Number(req.params.id);
    const comment = await prisma.comment.findUnique({ where: { id } });
    if (!comment) return res.status(404).json({ message: "Comment not found" });
    if (comment.userId !== req.userId) {
      return res.status(403).json({ message: "You can only delete your own comments" });
    }

    // Cascade delete removes any nested replies too (see schema's onDelete: Cascade).
    await prisma.comment.delete({ where: { id } });
    return res.json({ message: "Comment deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { createComment, getCommentsByPost, deleteComment };
