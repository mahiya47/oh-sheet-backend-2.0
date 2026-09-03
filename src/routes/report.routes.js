const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { reportLimiter } = require("../middleware/rateLimit");
const { createReport } = require("../controllers/report.controller");

router.post("/", authMiddleware, reportLimiter, createReport);

module.exports = router;
