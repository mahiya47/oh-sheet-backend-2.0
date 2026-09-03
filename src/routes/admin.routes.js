const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth");
const adminMiddleware = require("../middleware/admin");
const {
  getStats,
  listUsers,
  updateUser,
  deleteUser,
  listPosts,
  updatePost,
  deletePost,
  listComments,
  deleteComment,
  listReports,
  replyToReport,
  listSupportTickets,
  replyToSupportTicket,
  listErrors,
  deleteError,
  clearErrors,
  getAnalytics,
} = require("../controllers/admin.controller");

// Every route here requires a valid login AND the one admin account.
router.use(authMiddleware, adminMiddleware);

router.get("/stats", getStats);

router.get("/users", listUsers);
router.patch("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);

router.get("/posts", listPosts);
router.patch("/posts/:id", updatePost);
router.delete("/posts/:id", deletePost);

router.get("/comments", listComments);
router.delete("/comments/:id", deleteComment);

router.get("/reports", listReports);
router.patch("/reports/:id", replyToReport);

router.get("/support", listSupportTickets);
router.patch("/support/:id", replyToSupportTicket);

router.get("/errors", listErrors);
router.delete("/errors/:id", deleteError);
router.delete("/errors", clearErrors);

router.get("/analytics", getAnalytics);

module.exports = router;
