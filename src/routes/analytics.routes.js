const express = require("express");
const router = express.Router();
const { analyticsLimiter } = require("../middleware/rateLimit");
const { trackPageview } = require("../controllers/analytics.controller");

router.post("/pageview", analyticsLimiter, trackPageview);

module.exports = router;
