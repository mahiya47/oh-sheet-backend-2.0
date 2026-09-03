require("dotenv").config();
const http = require("http");
const { Server } = require("socket.io");
const app = require("./app");
const { attachGameSockets } = require("./realtime/gameSockets");
const { ensureBotUsers } = require("./lib/bots");
const { logError } = require("./lib/errorLog");

const PORT = process.env.PORT || 4000;

// Anything thrown outside a request (a dropped promise in a fire-and-forget
// job, for instance) would otherwise only show up in the process logs —
// log it to the same place the admin Errors tab reads from.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  logError(reason instanceof Error ? reason : new Error(String(reason)), null, null);
});

const server = http.createServer(app);

// Same allowed-origin rule as app.js's CORS setup (kept in sync manually
// since socket.io configures CORS separately from Express).
const explicitOrigins = [process.env.FRONTEND_URL].filter(Boolean);
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (explicitOrigins.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

const io = new Server(server, {
  cors: {
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) return callback(null, true);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  },
});

attachGameSockets(io);

// Make sure Pikku and Tonald's accounts exist before we start taking
// requests — signup and post-creation both look their ids up synchronously.
ensureBotUsers()
  .catch((err) => console.error("Failed to set up bot accounts:", err.message))
  .finally(() => {
    server.listen(PORT, () => {
      console.log(`Oh Sheet! API listening on http://localhost:${PORT} (HTTP + WebSocket)`);
    });
  });
