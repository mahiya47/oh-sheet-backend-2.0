const express = require("express");
const router = express.Router();
const { optionalAuth } = require("../middleware/auth");
const { createTicket } = require("../controllers/support.controller");

router.post("/", optionalAuth, createTicket);

module.exports = router;
