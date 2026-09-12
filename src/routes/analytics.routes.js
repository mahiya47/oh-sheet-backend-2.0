const express = require("express");
const router = express.Router();
const { trackPageview } = require("../controllers/analytics.controller");

router.post("/pageview", trackPageview);

module.exports = router;
