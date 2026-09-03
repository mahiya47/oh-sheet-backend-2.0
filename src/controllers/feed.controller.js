const prisma = require("../lib/prisma");

// Same resolution as seo.controller.js's sitemap — the frontend's own
// domain, not this API host.
const SITE_URL = (process.env.SITE_URL || process.env.FRONTEND_URL || "http://localhost:5174").replace(/\/$/, "");

const FEED_TITLE = "Oh Sheet!";
const FEED_DESCRIPTION = "Latest posts from Oh Sheet!";
const FEED_SIZE = 30;

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

// RSS wants RFC 822 dates (e.g. "Tue, 03 Sep 2026 10:00:00 GMT") — this is
// exactly what Date#toUTCString already produces.
function rfc822(date) {
  return date.toUTCString();
}

// GET /feed.xml — RSS 2.0 feed of the most recent public posts, so people
// can follow the site in any feed reader without an account. Reposts are
// left out (repostOfId: null) since they'd otherwise duplicate an original
// post's entry, and posts from deleted accounts are excluded.
async function feed(req, res) {
  try {
    const posts = await prisma.post.findMany({
      where: {
        repostOfId: null,
        published: true,
        author: { deletedAt: null },
      },
      orderBy: { createdAt: "desc" },
      take: FEED_SIZE,
      select: {
        id: true,
        title: true,
        content: true,
        createdAt: true,
        author: { select: { username: true, name: true } },
      },
    });

    const feedUrl = `${SITE_URL}/feed.xml`;
    const lastBuildDate = posts.length ? rfc822(posts[0].createdAt) : rfc822(new Date());

    const items = posts.map((post) => {
      const postUrl = `${SITE_URL}/post/${post.id}`;
      const authorLabel = post.author?.name || post.author?.username || "Someone";
      return [
        "<item>",
        `<title>${xmlEscape(post.title || "Untitled post")}</title>`,
        `<link>${xmlEscape(postUrl)}</link>`,
        `<guid isPermaLink="true">${xmlEscape(postUrl)}</guid>`,
        `<pubDate>${rfc822(post.createdAt)}</pubDate>`,
        `<dc:creator>${xmlEscape(authorLabel)}</dc:creator>`,
        `<description><![CDATA[${post.content || ""}]]></description>`,
        "</item>",
      ].join("");
    });

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">',
      "<channel>",
      `<title>${xmlEscape(FEED_TITLE)}</title>`,
      `<link>${xmlEscape(SITE_URL)}</link>`,
      `<atom:link href="${xmlEscape(feedUrl)}" rel="self" type="application/rss+xml" />`,
      `<description>${xmlEscape(FEED_DESCRIPTION)}</description>`,
      `<language>en</language>`,
      `<lastBuildDate>${lastBuildDate}</lastBuildDate>`,
      ...items,
      "</channel>",
      "</rss>",
    ].join("");

    res.set("Content-Type", "application/rss+xml; charset=UTF-8");
    return res.send(xml);
  } catch (error) {
    return res.status(500).send("");
  }
}

module.exports = { feed };
