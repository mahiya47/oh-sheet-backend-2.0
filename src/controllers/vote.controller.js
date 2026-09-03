const prisma = require("../lib/prisma");
const { createNotification } = require("../utils/notify");
const { isBlockedEitherWay } = require("../lib/blocks");
const { sendServerError } = require("../lib/errorLog");

// This reuses the existing `Like` table — same one your old backend used
// for heart/laugh/etc reactions — just with `type` now holding "up" or
// "down" instead of an emoji name. Nothing about the table changes; old
// rows with the old reaction types are simply never matched by this code.

// POST /api/posts/:id/vote  { type: "up" | "down" }
// Clicking your current vote again clears it; clicking the other one
// switches it — matching the toggle behavior already built into the
// frontend's upvote/downvote buttons.
async function votePost(req, res) {
  try {
    const postId = Number(req.params.id);
    const { type } = req.body;

    if (type !== "up" && type !== "down") {
      return res.status(400).json({ message: 'type must be "up" or "down"' });
    }

    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) return res.status(404).json({ message: "Post not found" });

    if (await isBlockedEitherWay(req.userId, post.authorId)) {
      return res.status(403).json({ message: "You can't do that" });
    }

    const existing = await prisma.like.findUnique({
      where: { userId_postId: { userId: req.userId, postId } },
    });

    if (existing && existing.type === type) {
      await prisma.like.delete({ where: { userId_postId: { userId: req.userId, postId } } });
    } else if (existing) {
      await prisma.like.update({
        where: { userId_postId: { userId: req.userId, postId } },
        data: { type },
      });
    } else {
      await prisma.like.create({
        data: { type, userId: req.userId, postId },
      });
    }

    // Only notify on a fresh upvote (not a toggle-off, and not a downvote) —
    // matches the familiar "someone liked your post" pattern.
    if (type === "up" && (!existing || existing.type !== "up")) {
      await createNotification({
        recipientId: post.authorId,
        actorId: req.userId,
        type: "upvote",
        postId: post.id,
      });
    }

    const [upvotes, downvotes] = await Promise.all([
      prisma.like.count({ where: { postId, type: "up" } }),
      prisma.like.count({ where: { postId, type: "down" } }),
    ]);

    const mine = await prisma.like.findUnique({
      where: { userId_postId: { userId: req.userId, postId } },
    });

    return res.json({ upvotes, downvotes, myVote: mine ? mine.type : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { votePost };
