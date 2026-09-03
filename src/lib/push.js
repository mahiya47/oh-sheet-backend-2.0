const webpush = require("web-push");
const prisma = require("./prisma");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:support@ohsheet.blog";

const pushConfigured = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
if (pushConfigured) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled.");
}

// One line of copy per notification type, matching the wording the in-app
// bell already uses (see NotificationsPage) so a push and its in-app
// counterpart never say different things about the same event.
function buildPayload(type, actorLabel, postId) {
  const url = postId ? `/post/${postId}` : "/notifications";
  const bodies = {
    follow: `${actorLabel} followed you.`,
    upvote: `${actorLabel} upvoted your post.`,
    comment: `${actorLabel} commented on your post.`,
    reply: `${actorLabel} replied to your comment.`,
    mention: `${actorLabel} mentioned you.`,
    tagged: `${actorLabel} tagged you in a post.`,
    dm: `${actorLabel} sent you a message.`,
  };
  return {
    title: "Oh Sheet!",
    body: bodies[type] || `${actorLabel} did something on Oh Sheet!`,
    url,
  };
}

// Fire-and-forget: sends a push to every device this user has push enabled
// on. Called from utils/notify.js right after an in-app notification is
// created, so push mirrors the in-app bell's triggers exactly. Never throws
// — a push failure should never break whatever action triggered it.
async function notifyPush({ recipientId, actorId, type, postId }) {
  if (!pushConfigured) return;
  try {
    const subscriptions = await prisma.pushSubscription.findMany({ where: { userId: recipientId } });
    if (!subscriptions.length) return;

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, username: true },
    });
    const actorLabel = actor?.name || actor?.username || "Someone";
    const payload = JSON.stringify(buildPayload(type, actorLabel, postId));

    await Promise.all(
      subscriptions.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          );
        } catch (error) {
          // 404/410 means the browser dropped this subscription (uninstalled,
          // cleared data, expired) — clean it up so we stop trying it.
          if (error.statusCode === 404 || error.statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {});
          } else {
            console.error("Push send failed:", error.message);
          }
        }
      }),
    );
  } catch (error) {
    console.error("notifyPush failed:", error.message);
  }
}

module.exports = { notifyPush, pushConfigured, VAPID_PUBLIC_KEY };
