const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { createNotification } = require("../utils/notify");
const { isBlockedEitherWay } = require("../lib/blocks");
const { sendServerError } = require("../lib/errorLog");

// POST /api/follows/:userId
async function followUser(req, res) {
  try {
    const followingId = Number(req.params.userId);
    if (followingId === req.userId) {
      return res.status(400).json({ message: "You cannot follow yourself" });
    }

    const target = await prisma.user.findUnique({ where: { id: followingId } });
    if (!target) return res.status(404).json({ message: "User not found" });

    if (await isBlockedEitherWay(req.userId, followingId)) {
      return res.status(403).json({ message: "You can't do that" });
    }

    const existing = await prisma.follow.findUnique({
      where: { followerId_followingId: { followerId: req.userId, followingId } },
    });
    if (existing) return res.status(400).json({ message: "Already following" });

    await prisma.follow.create({
      data: { followerId: req.userId, followingId },
    });

    await createNotification({ recipientId: followingId, actorId: req.userId, type: "follow" });

    return res.status(201).json({ message: "Followed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/follows/:userId
async function unfollowUser(req, res) {
  try {
    const followingId = Number(req.params.userId);
    await prisma.follow.deleteMany({
      where: { followerId: req.userId, followingId },
    });
    return res.json({ message: "Unfollowed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/follows/:userId — counts + whether the caller follows them.
async function getFollowInfo(req, res) {
  try {
    const userId = Number(req.params.userId);
    const [followers, following] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
    ]);

    let isFollowing = false;
    if (req.userId) {
      const rel = await prisma.follow.findUnique({
        where: { followerId_followingId: { followerId: req.userId, followingId: userId } },
      });
      isFollowing = !!rel;
    }

    return res.json({ followers, following, isFollowing });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function getFollowers(req, res) {
  try {
    const userId = Number(req.params.userId);
    const rows = await prisma.follow.findMany({
      where: { followingId: userId },
      include: { follower: { select: publicUserSelect } },
    });
    return res.json(rows.map((r) => r.follower));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function getFollowing(req, res) {
  try {
    const userId = Number(req.params.userId);
    const rows = await prisma.follow.findMany({
      where: { followerId: userId },
      include: { following: { select: publicUserSelect } },
    });
    return res.json(rows.map((r) => r.following));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { followUser, unfollowUser, getFollowInfo, getFollowers, getFollowing };
