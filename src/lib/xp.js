// Site-wide XP/level system.
//
// There's no new column here on purpose — `User.score` (already
// incremented in post.controller.js on post creation, and in
// comment.controller.js on commenting/being commented on — see those
// files) already IS the XP number. A "level" is just that score run
// through a curve. Keep this pure/stateless so it can be called from
// any controller that already has a user's score in hand (leaderboard,
// profile, wherever else a badge shows up later).

// Flat 100 XP per level. Simple on purpose — easy to reason about,
// easy to tune later (bump LEVEL_STEP, or swap levelForScore's math
// for a curve) without touching every call site.
const LEVEL_STEP = 100;

// score 0-99 -> level 1, 100-199 -> level 2, 200-299 -> level 3, ...
function levelForScore(score) {
  const s = Math.max(0, Number(score) || 0);
  return Math.floor(s / LEVEL_STEP) + 1;
}

// How far into the current level this score is, for a progress bar:
// { level, into, needed, remaining }. "needed" is always LEVEL_STEP for
// now (flat curve) but is returned explicitly so a UI doesn't have to
// hardcode it, in case the curve ever changes.
function levelProgress(score) {
  const s = Math.max(0, Number(score) || 0);
  const level = levelForScore(s);
  const into = s % LEVEL_STEP;
  return { level, into, needed: LEVEL_STEP, remaining: LEVEL_STEP - into };
}

module.exports = { levelForScore, levelProgress, LEVEL_STEP };
