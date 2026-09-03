const express = require("express");
const router = express.Router({ mergeParams: true }); // inherit :postId from the parent router
const authMiddleware = require("../middleware/auth");
const { optionalAuth } = require("../middleware/auth");
const { createComment, getCommentsByPost, deleteComment } = require("../controllers/comment.controller");

router.get("/", optionalAuth, getCommentsByPost); // GET  /api/posts/:postId/comments
router.post("/", authMiddleware, createComment); // POST /api/posts/:postId/comments
router.delete("/:id", authMiddleware, deleteComment); // DELETE /api/posts/:postId/comments/:id

module.exports = router;
