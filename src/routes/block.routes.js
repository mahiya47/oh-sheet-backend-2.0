const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { blockUser, unblockUser, getBlockedUsers, getBlockStatus } = require("../controllers/block.controller");

router.get("/", authMiddleware, getBlockedUsers);
router.get("/:userId/status", authMiddleware, getBlockStatus);
router.post("/:userId", authMiddleware, blockUser);
router.delete("/:userId", authMiddleware, unblockUser);

module.exports = router;
