const prisma = require("./prisma");

// Best-effort — logging an error must never itself throw and take down the
// request that's already failing.
async function logError(err, req, statusCode) {
  try {
    await prisma.errorLog.create({
      data: {
        message: String(err && err.message ? err.message : err).slice(0, 2000),
        stack: err && err.stack ? String(err.stack).slice(0, 8000) : null,
        path: req ? req.originalUrl : null,
        method: req ? req.method : null,
        statusCode: statusCode || null,
      },
    });
  } catch (e) {
    console.error("Failed to write to ErrorLog:", e.message);
  }
}

// Shared 500-response helper for every route handler's catch block. Always
// logs the real error server-side (console + ErrorLog, both fire-and-forget
// so a logging hiccup never blocks the response) but only puts the raw
// error.message in the JSON response outside production — in production
// that message can contain internal details (Prisma query fragments, file
// paths, third-party API errors) that have no business reaching whoever
// triggered the failure, attacker or not.
function sendServerError(res, error, req, message = "Something went wrong") {
  console.error(error);
  logError(error, req, 500);
  const isProduction = process.env.NODE_ENV === "production";
  return res.status(500).json({
    message,
    ...(!isProduction && { error: error.message }),
  });
}

module.exports = { logError, sendServerError };
