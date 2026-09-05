const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const {
  getUserByUsername,
  checkUsernameAvailable,
  updateProfile,
  updatePrivacy,
  searchAll,
  getSuggestedUsers,
  getLeaderboard,
  exportMyData,
} = require("../controllers/user.controller");

// Specific routes before the generic "/:username" route.
router.get("/suggestions", optionalAuth, getSuggestedUsers);
router.get("/leaderboard", getLeaderboard);
router.get("/search", optionalAuth, searchAll);
router.get("/check-username/:username", checkUsernameAvailable);
router.put("/me", authMiddleware, updateProfile);
router.put("/me/privacy", authMiddleware, updatePrivacy);
router.get("/me/export", authMiddleware, exportMyData);

router.get("/:username", optionalAuth, getUserByUsername);

module.exports = router;
