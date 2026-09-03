const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { createNotification } = require("../utils/notify");
const { getBotIds } = require("../lib/bots");
const { sendServerError } = require("../lib/errorLog");

const MESSAGE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours after BOTH sides have seen it

// Deletes messages once both the sender and receiver have viewed them —
// `read`/`readAt` is the receiver's view, `senderSeenAt` is the sender's
// (set when they reopen the thread after sending) — and 24 hours have
// passed since the later of the two. Called lazily wherever a conversation
// is touched, same pattern as expireOldNotifications.
async function expireOldMessages() {
  const cutoff = new Date(Date.now() - MESSAGE_EXPIRY_MS);
  await prisma.directMessage.deleteMany({
    where: {
      readAt: { not: null, lt: cutoff },
      senderSeenAt: { not: null, lt: cutoff },
    },
  });
}

function isBotId(id) {
  const bots = getBotIds();
  return !!bots && (id === bots.pikku || id === bots.tonald);
}

// GET /api/messages/conversations — one row per person you've exchanged
// messages with, newest message first, with an unread count for each.
async function getConversations(req, res) {
  try {
    await expireOldMessages();
    const me = req.userId;

    const messages = await prisma.directMessage.findMany({
      where: { OR: [{ senderId: me }, { receiverId: me }] },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    // Keep only the latest message per "other person" (messages are
    // already newest-first, so the first time we see an id wins).
    const latestByOther = new Map();
    for (const m of messages) {
      const otherId = m.senderId === me ? m.receiverId : m.senderId;
      if (!latestByOther.has(otherId)) latestByOther.set(otherId, m);
    }

    const otherIds = [...latestByOther.keys()];
    if (!otherIds.length) return res.json([]);

    const [otherUsers, unreadGroups] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: otherIds } },
        select: publicUserSelect,
      }),
      prisma.directMessage.groupBy({
        by: ["senderId"],
        where: { receiverId: me, read: false, senderId: { in: otherIds } },
        _count: { _all: true },
      }),
    ]);

    const userById = new Map(otherUsers.map((u) => [u.id, u]));
    const unreadBySenderId = new Map(unreadGroups.map((g) => [g.senderId, g._count._all]));

    const conversations = otherIds
      .map((id) => {
        const other = userById.get(id);
        if (!other) return null;
        const last = latestByOther.get(id);
        return {
          user: other,
          lastMessage: last.content,
          lastMessageAt: last.createdAt,
          lastMessageIsMine: last.senderId === me,
          unreadCount: unreadBySenderId.get(id) || 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

    return res.json(conversations);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/messages/unread-count — total unread DMs, for the bell/badge.
async function getUnreadCount(req, res) {
  try {
    const count = await prisma.directMessage.count({
      where: { receiverId: req.userId, read: false },
    });
    return res.json({ count });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/messages/:username — the message thread with one other user.
// Opening the thread also marks anything they sent you as read, AND marks
// anything you sent them as seen-by-you-again — the sender's half of the
// "both sides have seen it" rule that expireOldMessages() checks.
async function getThread(req, res) {
  try {
    await expireOldMessages();
    const me = req.userId;
    const other = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!other || other.deletedAt) return res.status(404).json({ message: "User not found" });
    if (other.id === me) return res.status(400).json({ message: "That's you" });

    const messages = await prisma.directMessage.findMany({
      where: {
        OR: [
          { senderId: me, receiverId: other.id },
          { senderId: other.id, receiverId: me },
        ],
      },
      orderBy: { createdAt: "asc" },
      take: 200,
    });

    const now = new Date();
    await prisma.directMessage.updateMany({
      where: { senderId: other.id, receiverId: me, read: false },
      data: { read: true, readAt: now },
    });
    await prisma.directMessage.updateMany({
      where: { senderId: me, receiverId: other.id, senderSeenAt: null },
      data: { senderSeenAt: now },
    });

    // Bot accounts (Pikku/Tonald) reply, but never open a thread themselves
    // — they can never supply their own half of "both sides have seen it".
    // The human on the other end stands in for the bot's half too, on
    // both directions of the conversation.
    if (isBotId(other.id)) {
      await prisma.directMessage.updateMany({
        where: { senderId: other.id, receiverId: me, senderSeenAt: null },
        data: { senderSeenAt: now },
      });
      await prisma.directMessage.updateMany({
        where: { senderId: me, receiverId: other.id, read: false },
        data: { read: true, readAt: now },
      });
    }

    return res.json({
      user: {
        id: other.id,
        name: other.name,
        username: other.username,
        avatarUrl: other.avatarUrl,
      },
      messages: messages.map((m) => ({
        id: m.id,
        content: m.content,
        createdAt: m.createdAt,
        isMine: m.senderId === me,
        // Read receipt — only meaningful for messages I sent (the
        // frontend only shows "Seen" under your own last message).
        read: m.read,
        readAt: m.readAt,
      })),
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST /api/messages/:username  { content }
async function sendMessage(req, res) {
  try {
    const me = req.userId;
    const content = (req.body.content || "").trim();
    if (!content) return res.status(400).json({ message: "Message can't be empty" });
    if (content.length > 2000) return res.status(400).json({ message: "Message is too long" });

    const other = await prisma.user.findUnique({ where: { username: req.params.username } });
    if (!other || other.deletedAt) return res.status(404).json({ message: "User not found" });
    if (other.id === me) return res.status(400).json({ message: "You can't message yourself" });

    const iBlockedThem = await prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId: me, blockedId: other.id } },
    });
    const theyBlockedMe = await prisma.block.findUnique({
      where: { blockerId_blockedId: { blockerId: other.id, blockedId: me } },
    });
    if (iBlockedThem || theyBlockedMe) {
      return res.status(403).json({ message: "You can't message this user" });
    }

    const message = await prisma.directMessage.create({
      data: { content, senderId: me, receiverId: other.id },
    });

    await createNotification({ recipientId: other.id, actorId: me, type: "dm" });

    return res.status(201).json({
      id: message.id,
      content: message.content,
      createdAt: message.createdAt,
      isMine: true,
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { getConversations, getUnreadCount, getThread, sendMessage };
