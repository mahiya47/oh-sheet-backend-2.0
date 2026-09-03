const prisma = require("../lib/prisma");
const { VAPID_PUBLIC_KEY, pushConfigured } = require("../lib/push");
const { sendServerError } = require("../lib/errorLog");

// GET /api/push/public-key — the frontend needs this to call
// PushManager.subscribe({ applicationServerKey: ... }). Not a secret (it's
// the whole point of a public key), so no auth needed.
function getPublicKey(req, res) {
  return res.json({ publicKey: pushConfigured ? VAPID_PUBLIC_KEY : null });
}

// POST /api/push/subscribe — body is the PushSubscription object the
// browser handed back from PushManager.subscribe() (endpoint + keys).
// Upserted on endpoint so re-subscribing on the same browser (e.g. after
// clearing the toggle off/on) doesn't create a duplicate row.
async function subscribe(req, res) {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ message: "Invalid push subscription" });
    }
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: req.userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        userAgent: (req.headers["user-agent"] || "").slice(0, 300) || null,
      },
      // A subscription endpoint belongs to one browser profile — if it's
      // already on file for a different account (e.g. someone logged out
      // and a different person logged in on the same browser), re-point it
      // at whoever's logged in now rather than erroring.
      update: { userId: req.userId, p256dh: keys.p256dh, auth: keys.auth },
    });
    return res.status(201).json({ message: "Subscribed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// DELETE /api/push/subscribe — body: { endpoint }. Only removes it if it
// belongs to the caller.
async function unsubscribe(req, res) {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ message: "endpoint required" });
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.userId } });
    return res.json({ message: "Unsubscribed" });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { getPublicKey, subscribe, unsubscribe };
