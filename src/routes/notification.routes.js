const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const {
  getNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} = require("../controllers/notification.controller");

// All notification routes require login — there's no "public" notification view.
router.get("/", authMiddleware, getNotifications);
router.get("/unread-count", authMiddleware, getUnreadCount);
router.post("/read-all", authMiddleware, markAllRead);
router.post("/:id/read", authMiddleware, markRead);
router.delete("/:id", authMiddleware, deleteNotification);

module.exports = router;
