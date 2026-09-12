const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const { createReport } = require("../controllers/report.controller");

router.post("/", authMiddleware, createReport);

module.exports = router;
