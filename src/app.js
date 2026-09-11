const express = require("express");
const path = require("path");
const cors = require("cors");
const passport = require("./lib/passport");

const authRoutes = require("./routes/auth.routes");
const postRoutes = require("./routes/post.routes");
const userRoutes = require("./routes/user.routes");
const followRoutes = require("./routes/follow.routes");
const blockRoutes = require("./routes/block.routes");
const muteRoutes = require("./routes/mute.routes");
const reportRoutes = require("./routes/report.routes");
const mediaRoutes = require("./routes/media.routes");
const notificationRoutes = require("./routes/notification.routes");
const messageRoutes = require("./routes/message.routes");
const supportRoutes = require("./routes/support.routes");
const adminRoutes = require("./routes/admin.routes");
const arcadeRoutes = require("./routes/arcade.routes");
const analyticsRoutes = require("./routes/analytics.routes");
const pushRoutes = require("./routes/push.routes");
const storyRoutes = require("./routes/story.routes");
const { generalLimiter } = require("./middleware/rateLimit");
const { sendServerError } = require("./lib/errorLog");
const { sitemap, robotsTxt } = require("./controllers/seo.controller");
const { feed } = require("./controllers/feed.controller");

const app = express();

// Deployed behind a reverse proxy (nginx on the Oracle VM, or Vercel/
// similar) that terminates TLS — without this, Express sees the proxy's
// plain-HTTP connection to it and req.protocol reports "http" even
// though the site is served over https. That silently corrupts every
// URL built from it (mediaUrl() in media.controller.js — uploaded
// images/videos, avatars, covers, auto-generated OG preview cards — all
// of it), permanently storing "http://" links that browsers then block
// or fail to load on an https page. Harmless in local dev (no proxy in
// front of it there).
app.set("trust proxy", 1);

// Allowed frontend origins. FRONTEND_URL (from .env) is always included.
// Every localhost/127.0.0.1 port is also allowed in development, since
// Vite picks a different port automatically when its default is busy —
// but never in production, where a stray localhost origin has no
// business being trusted.
const explicitOrigins = [process.env.FRONTEND_URL].filter(Boolean);
const isProduction = process.env.NODE_ENV === "production";

app.use(
  cors({
    origin(origin, callback) {
      // No Origin header (curl, server-to-server, some native apps) — allow.
      if (!origin) return callback(null, true);
      if (explicitOrigins.includes(origin)) return callback(null, true);
      if (!isProduction && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
        return callback(null, true);
      }
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

// Legacy uploads (avatars/photos saved before media moved into the
// database) still live on disk here — keep serving them so old
// avatarUrl/imageUrl/videoUrl values saved in the DB don't 404.
app.use("/ohsheet", express.static(path.join(__dirname, "../public/ohsheet")));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(passport.initialize());

// Broad safety net first, tighter per-route limiters layer on top of it
// inside their own route files (auth, reports).
app.use("/api", generalLimiter);

app.use("/api/auth", authRoutes);
app.use("/api/posts", postRoutes);
app.use("/api/users", userRoutes);
app.use("/api/follows", followRoutes);
app.use("/api/blocks", blockRoutes);
app.use("/api/mutes", muteRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/media", mediaRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/messages", messageRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/arcade", arcadeRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/stories", storyRoutes);

app.get("/", (req, res) => {
  res.json({ message: "Oh Sheet! API is running." });
});

app.get("/sitemap.xml", sitemap);
app.get("/robots.txt", robotsTxt);
app.get("/feed.xml", feed);

app.use((req, res) => {
  res.status(404).json({ message: "Not found" });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  sendServerError(res, err, req, "Server error");
});

module.exports = app;
