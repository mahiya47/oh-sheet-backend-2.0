const prisma = require("../lib/prisma");
const { notifyPush } = require("../lib/push");

// Fire-and-forget notification creation, called from inside the actions
// that should notify someone (follow, upvote, comment, reply, tagged).
// Never notifies people about their own actions, and never lets a
// notification failure break the action that triggered it.
//
// This is the single choke point every in-app notification passes through,
// which makes it the right place to also fire a push notification — push
// ends up covering exactly the same events as the in-app bell, with no
// separate list to keep in sync. notifyPush is itself fire-and-forget and
// never throws, so it's deliberately not awaited here.
async function createNotification({ recipientId, actorId, type, postId = null }) {
  try {
    if (!recipientId || !actorId || recipientId === actorId) return;
    await prisma.notification.create({
      data: { recipientId, actorId, type, postId },
    });
    notifyPush({ recipientId, actorId, type, postId });
  } catch (error) {
    console.error("Failed to create notification:", error.message);
  }
}

module.exports = { createNotification };
