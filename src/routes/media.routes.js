const express = require("express");
const router = express.Router();
const multer = require("multer");
const authMiddleware = require("../middleware/auth");
const { uploadMedia, getMedia, MAX_VIDEO_BYTES } = require("../controllers/media.controller");

// Buffered in memory, then written straight into the database — no files
// ever touch disk. The per-field size cap here is the larger of the two
// limits; the controller itself enforces the tighter image limit.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_VIDEO_BYTES } });

router.post("/", authMiddleware, upload.single("file"), uploadMedia);
router.get("/:id", getMedia);

module.exports = router;
