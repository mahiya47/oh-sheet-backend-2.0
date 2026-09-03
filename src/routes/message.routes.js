const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const {
  getConversations,
  getUnreadCount,
  getThread,
  sendMessage,
} = require("../controllers/message.controller");

// Every messaging route requires login — DMs are always private.
router.get("/conversations", authMiddleware, getConversations);
router.get("/unread-count", authMiddleware, getUnreadCount);
router.get("/:username", authMiddleware, getThread);
router.post("/:username", authMiddleware, sendMessage);

module.exports = router;
