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
} = require("../controllers/follow.controller");

router.get("/:userId/followers", getFollowers);
router.get("/:userId/following", getFollowing);
router.get("/:userId", optionalAuth, getFollowInfo);
router.post("/:userId", authMiddleware, followUser);
router.delete("/:userId", authMiddleware, unfollowUser);

module.exports = router;
