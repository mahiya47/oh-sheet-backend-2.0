const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const {
  createStory,
  getStoriesFeed,
  getAuthorStories,
  viewStory,
  deleteStory,
} = require("../controllers/story.controller");

// Stories are public — same audience as a normal post (see the model
// comment in schema.prisma) — so browsing works logged-out too;
// optionalAuth just means a logged-in viewer also gets seen/unseen
// status and can be excluded from muted authors' stories.
router.get("/", optionalAuth, getStoriesFeed);
router.post("/", authMiddleware, createStory);
router.get("/:authorId", optionalAuth, getAuthorStories);
router.post("/:id/view", authMiddleware, viewStory);
router.delete("/:id", authMiddleware, deleteStory);

module.exports = router;
