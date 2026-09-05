const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { createNotification } = require("../utils/notify");
const { isBlockedEitherWay } = require("../lib/blocks");
const { sendServerError } = require("../lib/errorLog");

// POST /api/follows/:userId — follows instantly, unless the target has a
// private account (isPrivate), in which case this files a follow request
// for them to accept/decline instead (see acceptFollowRequest /
// rejectFollowRequest below).
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

    if (target.isPrivate) {
      const existingRequest = await prisma.followRequest.findUnique({
        where: { requesterId_targetId: { requesterId: req.userId, targetId: followingId } },
      });
      if (existingRequest) return res.status(400).json({ message: "Already requested" });

      await prisma.followRequest.create({
        data: { requesterId: req.userId, targetId: followingId },
      });
      await createNotification({ recipientId: followingId, actorId: req.userId, type: "follow_request" });

      return res.status(201).json({ message: "Follow request sent", requested: true });
    }

    await prisma.follow.create({
      data: { followerId: req.userId, followingId },
    });

    await createNotification({ recipientId: followingId, actorId: req.userId, type: "follow" });

    return res.status(201).json({ message: "Followed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/follows/:userId — unfollows, and also cancels any pending
// follow request you sent that person, so the same "Following"/"Requested"
// button un-does either state.
async function unfollowUser(req, res) {
  try {
    const followingId = Number(req.params.userId);
    await prisma.follow.deleteMany({
      where: { followerId: req.userId, followingId },
    });
    await prisma.followRequest.deleteMany({
      where: { requesterId: req.userId, targetId: followingId },
    });
    return res.json({ message: "Unfollowed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/follows/:userId — counts + whether the caller follows them / has
// a follow request pending on them.
async function getFollowInfo(req, res) {
  try {
    const userId = Number(req.params.userId);
    const [followers, following] = await Promise.all([
      prisma.follow.count({ where: { followingId: userId } }),
      prisma.follow.count({ where: { followerId: userId } }),
    ]);

    let isFollowing = false;
    let hasPendingRequest = false;
    if (req.userId) {
      const [rel, pending] = await Promise.all([
        prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: req.userId, followingId: userId } },
        }),
        prisma.followRequest.findUnique({
          where: { requesterId_targetId: { requesterId: req.userId, targetId: userId } },
        }),
      ]);
      isFollowing = !!rel;
      hasPendingRequest = !!pending;
    }

    return res.json({ followers, following, isFollowing, hasPendingRequest });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// A private account's followers/following lists are only visible to the
// account itself and people it's already accepted as a follower — same
// audience as its posts.
async function canViewConnections(viewerId, targetId) {
  if (viewerId === targetId) return true;
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: { isPrivate: true } });
  if (!target || !target.isPrivate) return true;
  if (!viewerId) return false;
  const rel = await prisma.follow.findUnique({
    where: { followerId_followingId: { followerId: viewerId, followingId: targetId } },
  });
  return !!rel;
}

async function getFollowers(req, res) {
  try {
    const userId = Number(req.params.userId);
    if (!(await canViewConnections(req.userId, userId))) {
      return res.status(403).json({ message: "This account is private" });
    }
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
    if (!(await canViewConnections(req.userId, userId))) {
      return res.status(403).json({ message: "This account is private" });
    }
    const rows = await prisma.follow.findMany({
      where: { followerId: userId },
      include: { following: { select: publicUserSelect } },
    });
    return res.json(rows.map((r) => r.following));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/follows/requests — everyone currently waiting on your approval.
// The notification bell already surfaces these one at a time as they come
// in; this backs a fuller list if the frontend wants one.
async function getFollowRequests(req, res) {
  try {
    const rows = await prisma.followRequest.findMany({
      where: { targetId: req.userId },
      orderBy: { createdAt: "desc" },
      include: { requester: { select: publicUserSelect } },
    });
    return res.json(rows.map((r) => ({ ...r.requester, requestedAt: r.createdAt })));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// POST /api/follows/requests/:requesterId/accept
async function acceptFollowRequest(req, res) {
  try {
    const requesterId = Number(req.params.requesterId);
    const existingRequest = await prisma.followRequest.findUnique({
      where: { requesterId_targetId: { requesterId, targetId: req.userId } },
    });
    if (!existingRequest) return res.status(404).json({ message: "No such follow request" });

    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId: requesterId, followingId: req.userId } },
      update: {},
      create: { followerId: requesterId, followingId: req.userId },
    });
    await prisma.followRequest.delete({
      where: { requesterId_targetId: { requesterId, targetId: req.userId } },
    });

    await createNotification({ recipientId: requesterId, actorId: req.userId, type: "follow_accept" });

    return res.json({ message: "Follow request accepted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/follows/requests/:requesterId — decline a pending request.
async function rejectFollowRequest(req, res) {
  try {
    const requesterId = Number(req.params.requesterId);
    await prisma.followRequest.deleteMany({
      where: { requesterId, targetId: req.userId },
    });
    return res.json({ message: "Follow request declined" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = {
  followUser,
  unfollowUser,
  getFollowInfo,
  getFollowers,
  getFollowing,
  getFollowRequests,
  acceptFollowRequest,
  rejectFollowRequest,
};
