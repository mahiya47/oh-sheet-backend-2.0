const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const commentRoutes = require("./comment.routes");
const { votePost } = require("../controllers/vote.controller");
const {
  createPost,
  getAllPosts,
  getFollowingFeed,
  getSavedPosts,
  getPostsByUsername,
  getPostById,
  updatePost,
  deletePost,
  getPostVoters,
  toggleBookmark,
  untagSelf,
  getPostsByTag,
  getTrendingPosts,
  recordPostView,
  getPostAnalytics,
} = require("../controllers/post.controller");

// Specific routes MUST come before the generic "/:id" route below.
router.get("/", optionalAuth, getAllPosts);
router.get("/following", authMiddleware, getFollowingFeed);
router.get("/trending", optionalAuth, getTrendingPosts);
router.get("/saved/me", authMiddleware, getSavedPosts);
router.get("/user/:username", optionalAuth, getPostsByUsername);
router.get("/tag/:name", optionalAuth, getPostsByTag);

router.post("/", authMiddleware, createPost);
router.get("/:id", optionalAuth, getPostById);
router.put("/:id", authMiddleware, updatePost);
router.delete("/:id", authMiddleware, deletePost);
router.delete("/:id/untag", authMiddleware, untagSelf);

// Comments live under a post.
router.use("/:postId/comments", commentRoutes);

// Votes (upvote/downvote — reuses the old reactions table, see vote.controller.js).
router.post("/:id/vote", authMiddleware, votePost);
router.get("/:id/voters", optionalAuth, getPostVoters);

// Save / bookmark.
router.post("/:id/bookmark", authMiddleware, toggleBookmark);
router.delete("/:id/bookmark", authMiddleware, toggleBookmark);

// Analytics — view tracking (works logged-out) and the author-only summary.
router.post("/:id/view", optionalAuth, recordPostView);
router.get("/:id/analytics", authMiddleware, getPostAnalytics);

module.exports = router;
