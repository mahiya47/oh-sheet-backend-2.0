const prisma = require("../lib/prisma");
const { postIncludeForFormat, formatPost, publicUserSelect } = require("../utils/format");
const { sendServerError } = require("../lib/errorLog");

const ADMIN_USER_SELECT = {
  id: true,
  name: true,
  username: true,
  email: true,
  bio: true,
  avatarUrl: true,
  score: true,
  emailVerified: true,
  createdAt: true,
  deletedAt: true,
  lastLoginAt: true,
  _count: { select: { posts: true, comments: true, followers: true, following: true } },
};

// ---------------------------------------------------------------------
// GET /api/admin/stats — overview numbers for the dashboard tab.
// ---------------------------------------------------------------------
async function getStats(req, res) {
  try {
    const [
      totalUsers,
      totalPosts,
      totalComments,
      openReports,
      openTickets,
      deletedPendingPurge,
    ] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.post.count(),
      prisma.comment.count(),
      prisma.report.count({ where: { status: "open" } }),
      prisma.supportTicket.count({ where: { status: "open" } }),
      prisma.user.count({ where: { deletedAt: { not: null } } }),
    ]);
    return res.json({ totalUsers, totalPosts, totalComments, openReports, openTickets, deletedPendingPurge });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------

// GET /api/admin/users?q=&cursor=&limit=
async function listUsers(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const q = (req.query.q || "").trim();

    const where = q
      ? {
          OR: [
            { username: { contains: q, mode: "insensitive" } },
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ],
        }
      : {};

    const users = await prisma.user.findMany({
      where,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: "desc" },
      select: ADMIN_USER_SELECT,
    });

    const hasMore = users.length > limit;
    const page = hasMore ? users.slice(0, limit) : users;
    return res.json({ users: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// PATCH /api/admin/users/:id — admin edit of a handful of safe fields.
// Deliberately doesn't allow changing password/email here — that's not
// what this panel is for, and touching login credentials from an admin
// screen is a good way to lock someone out by accident.
async function updateUser(req, res) {
  try {
    const id = Number(req.params.id);
    const { name, bio, score, emailVerified } = req.body;

    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "User not found" });

    const data = {};
    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ message: "Name can't be empty" });
      data.name = name.trim();
    }
    if (bio !== undefined) data.bio = bio === null ? null : String(bio).slice(0, 500);
    if (score !== undefined) {
      const n = Number(score);
      if (!Number.isFinite(n)) return res.status(400).json({ message: "Score must be a number" });
      data.score = Math.trunc(n);
    }
    if (emailVerified !== undefined) data.emailVerified = !!emailVerified;

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: ADMIN_USER_SELECT,
    });
    return res.json(updated);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/admin/users/:id — a real, immediate, permanent delete (not
// the 7-day-grace soft delete self-service accounts get). This is a
// moderation action, so it cascades everything that FK's to the user
// (posts, comments, likes, follows, etc. — see schema.prisma onDelete).
// The admin can't delete their own account through here.
async function deleteUser(req, res) {
  try {
    const id = Number(req.params.id);
    if (id === req.userId) {
      return res.status(400).json({ message: "You can't delete your own admin account from here" });
    }
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "User not found" });

    await prisma.user.delete({ where: { id } });
    return res.json({ message: "User deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------

// GET /api/admin/posts?q=&cursor=&limit=
async function listPosts(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const q = (req.query.q || "").trim();

    const where = q
      ? {
          OR: [
            { content: { contains: q, mode: "insensitive" } },
            { author: { username: { contains: q, mode: "insensitive" } } },
            { author: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {};

    const posts = await prisma.post.findMany({
      where,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: "desc" },
      include: postIncludeForFormat,
    });

    const hasMore = posts.length > limit;
    const page = hasMore ? posts.slice(0, limit) : posts;
    const formatted = page.map((p) => formatPost(p, req.userId, new Set(), new Set()));
    return res.json({ posts: formatted, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// PATCH /api/admin/posts/:id — content only (same field the author-facing
// edit form allows), for fixing/redacting something without deleting it.
async function updatePost(req, res) {
  try {
    const id = Number(req.params.id);
    const { content } = req.body;
    if (content !== undefined && !content.trim()) {
      return res.status(400).json({ message: "Content can't be empty" });
    }

    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Post not found" });

    const updated = await prisma.post.update({
      where: { id },
      data: content !== undefined ? { content: content.trim() } : {},
      include: postIncludeForFormat,
    });
    return res.json(formatPost(updated, req.userId, new Set(), new Set()));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/admin/posts/:id
async function deletePost(req, res) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.post.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Post not found" });

    await prisma.post.delete({ where: { id } });
    return res.json({ message: "Post deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Comments — moderation-only listing, independent of any report (a
// report links to a specific comment via Report.commentId; this is the
// "just browse everything" view, same shape as the Posts tab).
// ---------------------------------------------------------------------

// GET /api/admin/comments?q=&cursor=&limit=
async function listComments(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const q = (req.query.q || "").trim();

    const where = q
      ? {
          OR: [
            { content: { contains: q, mode: "insensitive" } },
            { user: { username: { contains: q, mode: "insensitive" } } },
            { user: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : {};

    const comments = await prisma.comment.findMany({
      where,
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: "desc" },
      include: {
        user: { select: publicUserSelect },
        post: { select: { id: true, title: true } },
      },
    });

    const hasMore = comments.length > limit;
    const page = hasMore ? comments.slice(0, limit) : comments;
    return res.json({ comments: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/admin/comments/:id
async function deleteComment(req, res) {
  try {
    const id = Number(req.params.id);
    const existing = await prisma.comment.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Comment not found" });

    // Cascades to any replies (see schema's onDelete: Cascade on parentId),
    // and any Report row pointing at it keeps its record with commentId
    // set to null (onDelete: SetNull) rather than disappearing.
    await prisma.comment.delete({ where: { id } });
    return res.json({ message: "Comment deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------

// Deliberately does NOT include `message` — DMs are meant to become
// encrypted later, and even today the admin panel has no other way to
// read someone's messages, so a message-type report never surfaces the
// content, only that one was filed. Post/comment reports do include
// their content, since admins already see those in the Posts/Comments
// tabs anyway — a report just brings the relevant one to the front.
const REPORT_INCLUDE = {
  reporter: { select: { id: true, name: true, username: true, avatarUrl: true } },
  reportedUser: { select: { id: true, name: true, username: true, avatarUrl: true } },
  post: { select: { id: true, content: true } },
  comment: { select: { id: true, content: true, postId: true } },
};

// GET /api/admin/reports?status=open|resolved&cursor=&limit=
async function listReports(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const status = req.query.status;

    const reports = await prisma.report.findMany({
      where: status ? { status } : {},
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: "desc" },
      include: REPORT_INCLUDE,
    });

    const hasMore = reports.length > limit;
    const page = hasMore ? reports.slice(0, limit) : reports;
    return res.json({ reports: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// PATCH /api/admin/reports/:id — { reply?, status? }. Replying creates an
// in-app notification for the reporter attributed to "System" (see the
// notification controller / frontend — actorId is still the admin's own
// account internally, but that's never shown to the recipient).
async function replyToReport(req, res) {
  try {
    const id = Number(req.params.id);
    const { reply, status } = req.body;

    const existing = await prisma.report.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Report not found" });
    if (status !== undefined && !["open", "resolved"].includes(status)) {
      return res.status(400).json({ message: "status must be 'open' or 'resolved'" });
    }

    const data = {};
    if (reply !== undefined && reply.trim()) {
      data.adminReply = reply.trim();
      data.repliedAt = new Date();
    }
    if (status !== undefined) {
      data.status = status;
      data.resolvedAt = status === "resolved" ? new Date() : null;
    }

    const updated = await prisma.report.update({ where: { id }, data, include: REPORT_INCLUDE });

    if (data.adminReply) {
      await prisma.notification.create({
        data: {
          type: "report_reply",
          recipientId: existing.reporterId,
          actorId: req.userId,
          message: data.adminReply,
        },
      });
    }

    return res.json(updated);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------

// GET /api/admin/support?status=open|resolved&cursor=&limit=
async function listSupportTickets(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;
    const status = req.query.status;

    const tickets = await prisma.supportTicket.findMany({
      where: status ? { status } : {},
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: "desc" },
      include: { user: { select: { id: true, name: true, username: true, avatarUrl: true } } },
    });

    const hasMore = tickets.length > limit;
    const page = hasMore ? tickets.slice(0, limit) : tickets;
    return res.json({ tickets: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// PATCH /api/admin/support/:id — { reply?, status? }. Notifies in-app only
// when the ticket is tied to an account (userId set); a ticket submitted
// while logged out has no account to notify — this app doesn't send email,
// so the reply is saved and shown in the panel but not delivered anywhere.
async function replyToSupportTicket(req, res) {
  try {
    const id = Number(req.params.id);
    const { reply, status } = req.body;

    const existing = await prisma.supportTicket.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ message: "Ticket not found" });
    if (status !== undefined && !["open", "resolved"].includes(status)) {
      return res.status(400).json({ message: "status must be 'open' or 'resolved'" });
    }

    const data = {};
    if (reply !== undefined && reply.trim()) {
      data.adminReply = reply.trim();
      data.repliedAt = new Date();
    }
    if (status !== undefined) {
      data.status = status;
      data.resolvedAt = status === "resolved" ? new Date() : null;
    }

    const updated = await prisma.supportTicket.update({
      where: { id },
      data,
      include: { user: { select: { id: true, name: true, username: true, avatarUrl: true } } },
    });

    let notified = false;
    if (data.adminReply && existing.userId) {
      await prisma.notification.create({
        data: {
          type: "support_reply",
          recipientId: existing.userId,
          actorId: req.userId,
          message: data.adminReply,
        },
      });
      notified = true;
    }

    return res.json({ ...updated, notified });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Errors (built-in error logging — no third-party service)
// ---------------------------------------------------------------------

// GET /api/admin/errors?cursor=&limit=
async function listErrors(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit) || 25, 100);
    const cursor = req.query.cursor ? Number(req.query.cursor) : null;

    const errors = await prisma.errorLog.findMany({
      take: limit + 1,
      ...(cursor && { cursor: { id: cursor }, skip: 1 }),
      orderBy: { id: "desc" },
    });

    const hasMore = errors.length > limit;
    const page = hasMore ? errors.slice(0, limit) : errors;
    return res.json({ items: page, nextCursor: hasMore ? page[page.length - 1].id : null });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/admin/errors/:id
async function deleteError(req, res) {
  try {
    await prisma.errorLog.delete({ where: { id: Number(req.params.id) } });
    return res.json({ message: "Deleted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/admin/errors — clear the whole log.
async function clearErrors(req, res) {
  try {
    await prisma.errorLog.deleteMany({});
    return res.json({ message: "Cleared" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// ---------------------------------------------------------------------
// Analytics (built-in — no third-party service)
// ---------------------------------------------------------------------

// Buckets a list of { createdAt } rows into day -> count, for the last
// `days` days (including days with zero rows), oldest first.
function bucketByDay(rows, days) {
  const counts = new Map();
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    counts.set(d.toISOString().slice(0, 10), 0);
  }
  for (const row of rows) {
    const key = new Date(row.createdAt).toISOString().slice(0, 10);
    if (counts.has(key)) counts.set(key, counts.get(key) + 1);
  }
  return [...counts.entries()].map(([date, count]) => ({ date, count }));
}

// GET /api/admin/analytics?days=30
async function getAnalytics(req, res) {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 90);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [signupRows, postRows, pageviewRows, topPagesRaw] = await Promise.all([
      prisma.user.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.post.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true } }),
      prisma.pageView.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, path: true } }),
      prisma.pageView.groupBy({
        by: ["path"],
        where: { createdAt: { gte: since } },
        _count: { path: true },
        orderBy: { _count: { path: "desc" } },
        take: 10,
      }),
    ]);

    return res.json({
      signups: bucketByDay(signupRows, days),
      posts: bucketByDay(postRows, days),
      pageviews: bucketByDay(pageviewRows, days),
      totalPageviews: pageviewRows.length,
      topPages: topPagesRaw.map((r) => ({ path: r.path, count: r._count.path })),
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = {
  getStats,
  listUsers,
  updateUser,
  deleteUser,
  listPosts,
  updatePost,
  deletePost,
  listComments,
  deleteComment,
  listReports,
  replyToReport,
  listSupportTickets,
  replyToSupportTicket,
  listErrors,
  deleteError,
  clearErrors,
  getAnalytics,
};
