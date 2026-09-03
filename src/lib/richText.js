const sanitizeHtml = require("sanitize-html");
const cheerio = require("cheerio");

// Kept in sync manually with the frontend's lib/hashtags.js patterns —
// same reasoning as lib/mentions.js's copy of the mention pattern.
const HASHTAG_PATTERN = /#([a-zA-Z0-9_]+)/g;
const MENTION_PATTERN = /@([a-zA-Z0-9_]{3,30})/g;

// Only what the composer's toolbar can actually produce (bold, italic,
// strikethrough, inline code, links, paragraphs/line breaks) — anything
// else Tiptap might theoretically emit, or that a crafted request sends
// directly to the API, gets stripped rather than rendered.
const SANITIZE_OPTIONS = {
  allowedTags: ["p", "br", "strong", "em", "s", "code", "a"],
  allowedAttributes: { a: ["href", "rel", "target"] },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
  },
};

// Walks the sanitized HTML's text nodes and turns #hashtag / @mention
// occurrences into real links — the same thing the frontend's PostText
// component does for plain-text posts via regex, done once here (server
// side, at save time) so rich posts don't need a second, HTML-aware
// version of that logic living in the client. Skips text already inside
// an <a> or <code> element so a pasted URL or a code snippet never gets
// re-linked or mangled.
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function linkifyHashtagsAndMentions(html) {
  const $ = cheerio.load(html, null, false);

  function shouldSkip(el) {
    for (let node = el; node; node = node.parent) {
      if (node.type === "tag" && (node.name === "a" || node.name === "code")) return true;
    }
    return false;
  }

  // One combined pattern so "@user" and "#tag" are found left-to-right in
  // a single pass — group 1/2 are the hashtag's full match / bare name,
  // group 3/4 the mention's full match / bare handle.
  const combined = new RegExp(`(${HASHTAG_PATTERN.source})|(${MENTION_PATTERN.source})`, "g");

  $("*")
    .addBack()
    .contents()
    .filter((_, el) => el.type === "text" && !shouldSkip(el))
    .each((_, el) => {
      const original = el.data;
      combined.lastIndex = 0;
      if (!combined.test(original)) return;
      combined.lastIndex = 0;

      let lastIndex = 0;
      let match;
      let out = "";
      while ((match = combined.exec(original))) {
        if (match.index > lastIndex) out += escapeHtml(original.slice(lastIndex, match.index));
        if (match[1]) {
          out += `<a class="app-card-hashtag" href="/tag/${encodeURIComponent(match[2].toLowerCase())}">${escapeHtml(match[1])}</a>`;
        } else {
          out += `<a class="app-card-mention" href="/profile/${encodeURIComponent(match[4])}">${escapeHtml(match[3])}</a>`;
        }
        lastIndex = match.index + match[0].length;
      }
      if (lastIndex < original.length) out += escapeHtml(original.slice(lastIndex));
      $(el).replaceWith(out);
    });

  return $.html();
}

// The one function post.controller.js calls: sanitize first (so nothing
// unexpected reaches the hashtag/mention walk), then linkify. Returns null
// for empty input so callers can treat "no formatting" and "empty string"
// the same way as an absent contentHtml.
function sanitizeContentHtml(rawHtml) {
  if (!rawHtml || !rawHtml.trim()) return null;
  const clean = sanitizeHtml(rawHtml, SANITIZE_OPTIONS).trim();
  if (!clean) return null;
  // Guards against e.g. "<p></p>" (all text deleted but Tiptap still
  // emits an empty paragraph) — no visible text means there's nothing
  // worth storing as rich content.
  if (!cheerio.load(clean, null, false).text().trim()) return null;
  return linkifyHashtagsAndMentions(clean);
}

module.exports = { sanitizeContentHtml };
