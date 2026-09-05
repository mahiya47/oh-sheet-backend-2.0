const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { sendServerError } = require("../lib/errorLog");

async function blockUser(req, res) {
  try {
    const blockerId = req.userId;
    const blockedId = Number(req.params.userId);

    if (blockerId === blockedId) {
      return res.status(400).json({ message: "You can't block yourself" });
    }

    const target = await prisma.user.findUnique({ where: { id: blockedId } });
    if (!target) return res.status(404).json({ message: "User not found" });

    await prisma.block.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      update: {},
      create: { blockerId, blockedId },
    });

    // Blocking severs any existing follow relationship, both directions —
    // and any pending follow request between the two of you, so a blocked
    // account can't sit in the other person's requests list forever.
    await prisma.follow.deleteMany({
      where: {
        OR: [
          { followerId: blockerId, followingId: blockedId },
          { followerId: blockedId, followingId: blockerId },
        ],
      },
    });
    await prisma.followRequest.deleteMany({
      where: {
        OR: [
          { requesterId: blockerId, targetId: blockedId },
          { requesterId: blockedId, targetId: blockerId },
        ],
      },
    });

    return res.json({ message: "User blocked" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function unblockUser(req, res) {
  try {
    await prisma.block.deleteMany({
      where: { blockerId: req.userId, blockedId: Number(req.params.userId) },
    });
    return res.json({ message: "User unblocked" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function getBlockedUsers(req, res) {
  try {
    const blocks = await prisma.block.findMany({
      where: { blockerId: req.userId },
      orderBy: { createdAt: "desc" },
      include: { blocked: { select: publicUserSelect } },
    });
    return res.json(blocks.map((b) => b.blocked));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function getBlockStatus(req, res) {
  try {
    const me = req.userId;
    const other = Number(req.params.userId);

    const [iBlockedThem, theyBlockedMe] = await Promise.all([
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: me, blockedId: other } } }),
      prisma.block.findUnique({ where: { blockerId_blockedId: { blockerId: other, blockedId: me } } }),
    ]);

    return res.json({ iBlockedThem: !!iBlockedThem, theyBlockedMe: !!theyBlockedMe });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { blockUser, unblockUser, getBlockedUsers, getBlockStatus };
