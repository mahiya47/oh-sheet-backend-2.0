const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { muteUser, unmuteUser, getMutedUsers, getMuteStatus } = require("../controllers/mute.controller");

router.get("/", authMiddleware, getMutedUsers);
router.get("/:userId/status", authMiddleware, getMuteStatus);
router.post("/:userId", authMiddleware, muteUser);
router.delete("/:userId", authMiddleware, unmuteUser);

module.exports = router;
