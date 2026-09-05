const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const prisma = require("./prisma");

// Two companion accounts that live alongside real users: Pikku The Cat
// (canned meows) and Tonald Drump (a parody billionaire, Groq-powered
// with a canned fallback — see groq.js). Both auto-comment on new sheets
// a few minutes after they're posted, and both DM new users a welcome
// message right at signup.
//
// Looked up by USERNAME rather than a hardcoded id — same reasoning as
// the creator-follow lookup in auth.controller.js: ids aren't stable
// between a fresh database and the production one.
const BOT_USERNAMES = {
  pikku: process.env.PIKKU_USERNAME || "PikkuTheCat",
  tonald: process.env.TONALD_USERNAME || "TonaldDrump",
};

const BOT_DISPLAY_NAMES = {
  pikku: "Pikku The Cat",
  tonald: "Tonald Drump",
};

const BOT_BIOS = {
  pikku: "Meow. 🐾 (I comment on things. I do not understand things.)",
  tonald: "The best sheeter. Tremendous posts. Everybody says so.",
};

let cachedIds = null; // { pikku: id, tonald: id } once ensured

async function upsertBot(key) {
  const username = BOT_USERNAMES[key];
  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) return existing.id;

  // Bots never log in — login already rejects a null password, but a
  // real (never-revealed) hash keeps the row looking like every other
  // account rather than visibly "broken" wherever raw user rows show up.
  const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  const created = await prisma.user.create({
    data: {
      name: BOT_DISPLAY_NAMES[key],
      username,
      email: `${username.toLowerCase()}@bots.ohsheet.blog`,
      password: randomPassword,
      emailVerified: true,
      bio: BOT_BIOS[key],
    },
  });
  console.log(`Created bot account @${username}`);
  return created.id;
}

// Run once at server startup, before the app starts accepting requests —
// creates each bot account the first time (idempotent after that).
async function ensureBotUsers() {
  const [pikku, tonald] = await Promise.all([upsertBot("pikku"), upsertBot("tonald")]);
  cachedIds = { pikku, tonald };
  return cachedIds;
}

// Safe to call any time after ensureBotUsers() has resolved once at
// startup. Returns null (never throws) if that hasn't happened yet, so
// callers just skip the bot behavior that one time rather than erroring.
function getBotIds() {
  return cachedIds;
}

// The old app's Pikku comment landed 2–3 minutes after the post — kept
// as the default here too, and overridable via env for local testing so
// nobody has to sit around waiting on a fresh checkout.
function randomBotCommentDelayMs() {
  const min = Number(process.env.BOT_COMMENT_DELAY_MS_MIN) || 120000;
  const max = Number(process.env.BOT_COMMENT_DELAY_MS_MAX) || 180000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// A DM reply should feel like someone's actually there — a few seconds,
// not the multi-minute delay used for post comments. Overridable via env
// the same way, for local testing.
function randomBotReplyDelayMs() {
  const min = Number(process.env.BOT_REPLY_DELAY_MS_MIN) || 2000;
  const max = Number(process.env.BOT_REPLY_DELAY_MS_MAX) || 6000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = { ensureBotUsers, getBotIds, randomBotCommentDelayMs, randomBotReplyDelayMs, BOT_USERNAMES };
