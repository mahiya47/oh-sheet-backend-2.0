const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { sendServerError } = require("../lib/errorLog");

const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours after being read

// Deletes this user's own read notifications once they're more than 24
// hours old, so old, already-seen notifications don't pile up in the
// database forever. Called lazily whenever notifications are read, rather
// than running as a separate scheduled job.
async function expireOldNotifications(recipientId) {
  await prisma.notification.deleteMany({
    where: {
      recipientId,
      read: true,
      readAt: { lt: new Date(Date.now() - EXPIRY_MS) },
    },
  });
}

function formatNotification(n, postById) {
  const post = n.postId ? postById.get(n.postId) : null;
  return {
    id: n.id,
    type: n.type,
    read: n.read,
    createdAt: n.createdAt,
    actor: n.actor,
    postId: n.postId,
    postSnippet: post ? (post.content || "").slice(0, 100) : null,
    // Only set for "system" notification types (report_reply, support_reply)
    // — the admin's reply text. See admin.controller.js.
    message: n.message || null,
  };
}

// GET /api/notifications — most recent 50, newest first.
//
// Notification.postId is a plain int column on your existing database
// (no foreign-key relation defined on it there), so instead of adding a
// Prisma relation — which would require altering that live table — this
// just batch-fetches the handful of posts it needs separately. Purely a
// backend-side join; nothing about your database changes.
async function getNotifications(req, res) {
  try {
    await expireOldNotifications(req.userId);

    const rows = await prisma.notification.findMany({
      where: { recipientId: req.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        actor: { select: publicUserSelect },
      },
    });

    const postIds = [...new Set(rows.map((n) => n.postId).filter(Boolean))];
    const posts = postIds.length
      ? await prisma.post.findMany({
          where: { id: { in: postIds } },
          select: { id: true, content: true },
        })
      : [];
    const postById = new Map(posts.map((p) => [p.id, p]));

    return res.json(rows.map((n) => formatNotification(n, postById)));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/notifications/unread-count — for the bell badge.
async function getUnreadCount(req, res) {
  try {
    const count = await prisma.notification.count({
      where: { recipientId: req.userId, read: false },
    });
    return res.json({ count });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST /api/notifications/:id/read
async function markRead(req, res) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.notification.findUnique({ where: { id } });
    if (!existing || existing.recipientId !== req.userId) {
      return res.status(404).json({ message: "Notification not found" });
    }
    await prisma.notification.update({
      where: { id },
      data: { read: true, readAt: new Date() },
    });
    return res.json({ message: "Marked as read" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST /api/notifications/read-all
async function markAllRead(req, res) {
  try {
    await prisma.notification.updateMany({
      where: { recipientId: req.userId, read: false },
      data: { read: true, readAt: new Date() },
    });
    return res.json({ message: "All marked as read" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/notifications/:id — manual remove, any time (read or not).
async function deleteNotification(req, res) {
  try {
    const id = Number(req.params.id);
    await prisma.notification.deleteMany({
      where: { id, recipientId: req.userId },
    });
    return res.json({ message: "Notification removed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { getNotifications, getUnreadCount, markRead, markAllRead, deleteNotification };
