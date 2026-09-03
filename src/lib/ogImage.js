// Generates a branded "preview card" PNG for posts that don't have their
// own image or video attached — otherwise, sharing a text-only sheet's
// link on Slack/Twitter/iMessage etc. would show no preview image at all.
// Posts that DO have an imageUrl/videoUrl just use that instead (see
// post.controller.js) — this only ever runs for text-only posts.
const sharp = require("sharp");

const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;

// Same pastel palette as the feed cards in the frontend (src/index.css'
// --app-green/yellow/pink/blue/purple), kept in sync manually since this
// backend has no shared package with the frontend to import it from.
const CARD_COLORS = ["#a3e6a1", "#f5c945", "#f6a8cd", "#a3d8f2", "#cdb3f2"];
const INK = "#1c1810";

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Rough word-wrap for SVG text — there's no real layout engine here, just
// an estimate of how many characters fit per line at a given font size,
// which is close enough for a generated share-card (not pixel-perfect
// typesetting).
function wrapText(text, fontSize, maxWidth, maxLines) {
  const avgCharWidth = fontSize * 0.56;
  const charsPerLine = Math.max(4, Math.floor(maxWidth / avgCharWidth));
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > charsPerLine && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  // If there's still more text than fit, mark the last line as truncated.
  const consumedWords = lines.join(" ").split(/\s+/).length;
  if (consumedWords < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.replace(/[.,;:!?]*$/, "") + "…";
  }
  return lines;
}

function pickColor(postId) {
  return CARD_COLORS[Math.abs(postId) % CARD_COLORS.length];
}

function buildSvg({ postId, content, authorLabel }) {
  const bg = pickColor(postId);
  const excerpt = (content || "").replace(/\s+/g, " ").trim().slice(0, 260);
  const fontSize = excerpt.length > 140 ? 46 : 56;
  const lines = wrapText(excerpt || "A new sheet on Oh Sheet!", fontSize, CARD_WIDTH - 200, 5);
  const lineHeight = fontSize * 1.28;
  const totalTextHeight = lines.length * lineHeight;
  const startY = CARD_HEIGHT / 2 - totalTextHeight / 2 + fontSize * 0.5;

  const textLines = lines
    .map(
      (line, i) =>
        `<text x="100" y="${startY + i * lineHeight}" font-family="Nunito, Arial, sans-serif" font-weight="800" font-size="${fontSize}" fill="${INK}">${escapeXml(line)}</text>`,
    )
    .join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}">
    <rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${bg}"/>

    <!-- Mascot glyph, top-left -->
    <g transform="translate(100,72) scale(1.6)">
      <circle cx="24" cy="24" r="22" fill="${bg}" stroke="${INK}" stroke-width="2.4"/>
      <path d="M8,24 A16,16 0 0 1 40,24 L40,36 A4,4 0 0 1 32,36 A4,4 0 0 1 24,36 A4,4 0 0 1 16,36 A4,4 0 0 1 8,36 Z" fill="#ffffff" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>
      <ellipse cx="18" cy="25" rx="2.4" ry="3" fill="${INK}"/>
      <ellipse cx="30" cy="25" rx="2.4" ry="3" fill="${INK}"/>
      <circle cx="14.5" cy="31" r="2" fill="#f6a8cd"/>
      <circle cx="33.5" cy="31" r="2" fill="#f6a8cd"/>
    </g>
    <text x="170" y="100" font-family="Nunito, Arial, sans-serif" font-weight="800" font-size="34" fill="${INK}">Oh Sheet!</text>

    ${textLines}

    <text x="100" y="${CARD_HEIGHT - 60}" font-family="Nunito, Arial, sans-serif" font-weight="700" font-size="30" fill="${INK}" opacity="0.75">${escapeXml(authorLabel)}</text>
  </svg>`;
}

// Renders the card and returns a PNG Buffer — the caller stores it via the
// existing Media table, same as any other upload (see wireOgImage below).
async function generateOgImageBuffer(post, authorLabel) {
  const svg = buildSvg({ postId: post.id, content: post.content, authorLabel });
  return sharp(Buffer.from(svg)).png().toBuffer();
}

module.exports = { generateOgImageBuffer, CARD_WIDTH, CARD_HEIGHT };
