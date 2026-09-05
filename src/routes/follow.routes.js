const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const {
  followUser,
  unfollowUser,
  getFollowInfo,
  getFollowers,
  getFollowing,
  getFollowRequests,
  acceptFollowRequest,
  rejectFollowRequest,
} = require("../controllers/follow.controller");

// Specific routes before the generic "/:userId" ones below.
router.get("/requests", authMiddleware, getFollowRequests);
router.post("/requests/:requesterId/accept", authMiddleware, acceptFollowRequest);
router.delete("/requests/:requesterId", authMiddleware, rejectFollowRequest);

router.get("/:userId/followers", optionalAuth, getFollowers);
router.get("/:userId/following", optionalAuth, getFollowing);
router.get("/:userId", optionalAuth, getFollowInfo);
router.post("/:userId", authMiddleware, followUser);
router.delete("/:userId", authMiddleware, unfollowUser);

module.exports = router;
