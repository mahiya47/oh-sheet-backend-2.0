const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const {
  getConversations,
  getUnreadCount,
  markAllRead,
  getThread,
  sendMessage,
} = require("../controllers/message.controller");

// Every messaging route requires login — DMs are always private.
// /read-all must come before the /:username routes below, or Express
// would treat "read-all" as a username instead of matching this route.
router.get("/conversations", authMiddleware, getConversations);
router.get("/unread-count", authMiddleware, getUnreadCount);
router.post("/read-all", authMiddleware, markAllRead);
router.get("/:username", authMiddleware, getThread);
router.post("/:username", authMiddleware, sendMessage);

module.exports = router;
