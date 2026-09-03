const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const { submitScore, getLeaderboard, getTopPlayers, getMyScores } = require("../controllers/arcade.controller");

// Specific routes before the generic "/:gameSlug/..." ones below.
router.get("/top-players", optionalAuth, getTopPlayers);
router.get("/me", authMiddleware, getMyScores);

router.post("/:gameSlug/score", authMiddleware, submitScore);
router.get("/:gameSlug/leaderboard", optionalAuth, getLeaderboard);

module.exports = router;
