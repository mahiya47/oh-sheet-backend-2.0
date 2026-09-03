const prisma = require("../lib/prisma");

// The frontend's own domain — sitemap URLs point at the site people
// actually browse, not this API host. Falls back to FRONTEND_URL (already
// used elsewhere for CORS/redirects) since most deployments serve the API
// on a separate subdomain (e.g. api.ohsheet.blog) from the site itself
// (ohsheet.blog). Override with SITE_URL if that's ever not true.
const SITE_URL = (process.env.SITE_URL || process.env.FRONTEND_URL || "http://localhost:5174").replace(/\/$/, "");

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

// GET /sitemap.xml — home, static legal/about pages, recent posts, and
// user profiles. Capped at a few thousand URLs so this stays fast to
// generate and to crawl.
async function sitemap(req, res) {
  try {
    const [posts, users] = await Promise.all([
      prisma.post.findMany({
        where: { repostOfId: null },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 2000,
      }),
      prisma.user.findMany({
        where: { deletedAt: null, username: { not: null } },
        select: { username: true, updatedAt: true },
        take: 2000,
      }),
    ]);

    const staticUrls = ["", "/about", "/privacy", "/agreement", "/rules", "/trending", "/leaderboard"];

    const urls = [
      ...staticUrls.map((path) => `<url><loc>${xmlEscape(SITE_URL + path)}</loc></url>`),
      ...posts.map(
        (p) =>
          `<url><loc>${xmlEscape(`${SITE_URL}/post/${p.id}`)}</loc><lastmod>${p.createdAt.toISOString()}</lastmod></url>`,
      ),
      ...users.map(
        (u) =>
          `<url><loc>${xmlEscape(`${SITE_URL}/profile/${u.username}`)}</loc><lastmod>${u.updatedAt.toISOString()}</lastmod></url>`,
      ),
    ];

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;

    res.set("Content-Type", "application/xml");
    return res.send(xml);
  } catch (error) {
    return res.status(500).send("");
  }
}

// GET /robots.txt
function robotsTxt(req, res) {
  res.set("Content-Type", "text/plain");
  return res.send(`User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`);
}

module.exports = { sitemap, robotsTxt };
