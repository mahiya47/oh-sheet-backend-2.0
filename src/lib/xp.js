// Levels are derived from User.score — no separate XP column.
const LEVEL_STEP = 100;

function levelForScore(score) {
  const s = Math.max(0, Number(score) || 0);
  return Math.floor(s / LEVEL_STEP) + 1;
}

function levelProgress(score) {
  const s = Math.max(0, Number(score) || 0);
  const level = levelForScore(s);
  const into = s % LEVEL_STEP;
  return { level, into, needed: LEVEL_STEP, remaining: LEVEL_STEP - into };
}

module.exports = { levelForScore, levelProgress, LEVEL_STEP };
