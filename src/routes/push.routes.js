const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { getPublicKey, subscribe, unsubscribe } = require("../controllers/push.controller");

router.get("/public-key", getPublicKey);
router.post("/subscribe", authMiddleware, subscribe);
router.delete("/subscribe", authMiddleware, unsubscribe);

module.exports = router;
