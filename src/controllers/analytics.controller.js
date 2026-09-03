const prisma = require("../lib/prisma");
const { sendServerError } = require("../lib/errorLog");

// POST /api/analytics/pageview — fired by the frontend on every route
// change. Public (no auth) so logged-out visitors count too; kept cheap
// and best-effort so a failure here never surfaces to the visitor.
async function trackPageview(req, res) {
  try {
    let { path } = req.body;
    if (typeof path !== "string" || !path.trim()) {
      return res.status(400).json({ message: "path is required" });
    }
    path = path.trim().slice(0, 300);

    await prisma.pageView.create({ data: { path } });
    return res.status(204).end();
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

module.exports = { trackPageview };
