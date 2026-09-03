const prisma = require("../lib/prisma");
const { sendServerError } = require("../lib/errorLog");

const VALID_TARGET_TYPES = new Set(["user", "post", "comment", "message"]);

// POST /api/reports
// Body shapes:
//   { targetType: "user",    reportedUserId, reason }
//   { targetType: "post",    postId,         reason }
//   { targetType: "comment", commentId,      reason }
//   { targetType: "message", messageId,      reason }
//
// reportedUserId is never trusted from the client for the last three —
// it's always resolved server-side from the actual content's author/
// sender, so a report can't be filed "against" the wrong person.
async function createReport(req, res) {
  try {
    const reporterId = req.userId;
    const { reason } = req.body;
    const targetType = VALID_TARGET_TYPES.has(req.body.targetType) ? req.body.targetType : "user";

    if (!reason?.trim()) {
      return res.status(400).json({ message: "A reason is required" });
    }

    const data = { reporterId, reason: reason.trim(), targetType };

    if (targetType === "post") {
      const post = await prisma.post.findUnique({ where: { id: Number(req.body.postId) } });
      if (!post) return res.status(404).json({ message: "Post not found" });
      data.postId = post.id;
      data.reportedUserId = post.authorId;
    } else if (targetType === "comment") {
      const comment = await prisma.comment.findUnique({ where: { id: Number(req.body.commentId) } });
      if (!comment) return res.status(404).json({ message: "Comment not found" });
      data.commentId = comment.id;
      data.reportedUserId = comment.userId;
    } else if (targetType === "message") {
      const message = await prisma.directMessage.findUnique({
        where: { id: Number(req.body.messageId) },
      });
      if (!message) return res.status(404).json({ message: "Message not found" });
      // Only the person who received it can report it.
      if (message.receiverId !== reporterId) {
        return res.status(403).json({ message: "You can only report messages sent to you" });
      }
      data.messageId = message.id;
      data.reportedUserId = message.senderId;
    } else {
      const reportedUserId = Number(req.body.reportedUserId);
      if (!reportedUserId) {
        return res.status(400).json({ message: "Missing reportedUserId" });
      }
      data.reportedUserId = reportedUserId;
    }

    if (data.reportedUserId === reporterId) {
      return res.status(400).json({ message: "You can't report yourself" });
    }

    const report = await prisma.report.create({ data });
    return res.status(201).json(report);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { createReport };
