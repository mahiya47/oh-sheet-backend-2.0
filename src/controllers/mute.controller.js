const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { sendServerError } = require("../lib/errorLog");

// Muting is deliberately lighter than blocking (see the schema comment on
// the Mute model): it only hides someone's posts from your own
// feed/following/trending — it doesn't touch follows, DMs, comments, or
// notify the muted person in any way.

async function muteUser(req, res) {
  try {
    const muterId = req.userId;
    const mutedId = Number(req.params.userId);

    if (muterId === mutedId) {
      return res.status(400).json({ message: "You can't mute yourself" });
    }

    const target = await prisma.user.findUnique({ where: { id: mutedId } });
    if (!target) return res.status(404).json({ message: "User not found" });

    await prisma.mute.upsert({
      where: { muterId_mutedId: { muterId, mutedId } },
      update: {},
      create: { muterId, mutedId },
    });

    return res.json({ message: "User muted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function unmuteUser(req, res) {
  try {
    await prisma.mute.deleteMany({
      where: { muterId: req.userId, mutedId: Number(req.params.userId) },
    });
    return res.json({ message: "User unmuted" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function getMutedUsers(req, res) {
  try {
    const mutes = await prisma.mute.findMany({
      where: { muterId: req.userId },
      orderBy: { createdAt: "desc" },
      include: { muted: { select: publicUserSelect } },
    });
    return res.json(mutes.map((m) => m.muted));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

async function getMuteStatus(req, res) {
  try {
    const mute = await prisma.mute.findUnique({
      where: { muterId_mutedId: { muterId: req.userId, mutedId: Number(req.params.userId) } },
    });
    return res.json({ isMuted: !!mute });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { muteUser, unmuteUser, getMutedUsers, getMuteStatus };
