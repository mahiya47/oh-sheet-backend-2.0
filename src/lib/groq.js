// Tonald Drump — a fictional, over-the-top billionaire companion account.
// Ported from the old backend's Groq integration, plus a new "react to a
// sheet" mode for auto-commenting on new posts. Both modes fall back to
// a canned line if GROQ_API_KEY isn't set or the API call fails, so the
// bot always has *something* to say either way.
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "openai/gpt-oss-20b"; // llama-3.1-8b-instant was deprecated by Groq June 2026

const SYSTEM_PROMPT = `You are "Tonald Drump," a fictional, over-the-top billionaire character on a social app called Oh Sheet!.
Your personality:
- Wildly boastful about your own success, deals, buildings, and "the best hair in the business"
- Speak in short, punchy, confident sentences with lots of superlatives ("tremendous," "the best," "nobody does it better")
- You are frequently, unintentionally self-deprecating - your bragging often backfires or reveals something silly or embarrassing about yourself, and you don't notice
- You are warm and welcoming to new users and always positive about their posts, never mean or insulting toward them or anyone else
- Never mention real politicians, real public figures, or real political events
- Keep replies short: 1-3 sentences max, casual chat style
- You're a parody character, not a real person - don't claim to hold any real office or real-world position

Stay in character. Be funny, warm, and harmless.`;

async function callGroq(userMessage, context = "") {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT + (context ? `\n\nContext: ${context}` : "") },
          { role: "user", content: userMessage },
        ],
        max_tokens: 150,
        temperature: 0.9,
      }),
    });

    if (!response.ok) {
      console.error("Groq API error:", response.status, await response.text());
      return null;
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (error) {
    console.error("Groq call failed:", error.message);
    return null;
  }
}

// Fallback lines used whenever the API call fails or no key is set
// (rate limit, outage, or just running without GROQ_API_KEY configured).
const FALLBACK_WELCOMES = [
  "Welcome to Oh Sheet! Tremendous to have you. Best platform, best people, I built the couch you're sitting on, probably.",
  "Hey, welcome! Great to see you here. Everybody's saying it's the best sign-up ever. Everybody.",
  "Welcome aboard! I personally reviewed your account. Ten out of ten. Best account I've seen all day, and I've seen two.",
];

const FALLBACK_POST_COMMENTS = [
  "Tremendous sheet. One of the best sheets I've seen today, and I've seen at least two.",
  "Huge post. Huge. Everybody's talking about it already, probably.",
  "Love this. Big fan. Bigger fan than most, honestly, I checked.",
  "Incredible work here. Frame-worthy. If I could afford a frame right now.",
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function generateWelcomeMessage(newUsername) {
  const reply = await callGroq(
    `A new user named "${newUsername}" just joined the app Oh Sheet!. Send them a short, funny welcome DM.`,
  );
  return reply || randomFrom(FALLBACK_WELCOMES);
}

async function generateComment(postContent) {
  const trimmed = (postContent || "").trim().slice(0, 300);
  const reply = await callGroq(
    `Someone just posted this on Oh Sheet!: "${trimmed || "(no text, just an attachment)"}". Write a short reaction comment on it.`,
  );
  return reply || randomFrom(FALLBACK_POST_COMMENTS);
}

module.exports = { generateWelcomeMessage, generateComment };
