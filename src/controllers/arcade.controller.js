const prisma = require("../lib/prisma");
const { sendServerError } = require("../lib/errorLog");

const GAME_SLUGS = ["snake", "tetris", "minesweeper", "reaction", "flappybird", "runner", "sudoku", "crossword"];

// For these games a LOWER score is better (Reaction Timer = average ms
// across 3 rounds, Minesweeper = seconds to clear the board). Every other
// game is a normal high-score-wins game.
const TIME_BASED_GAMES = ["reaction", "minesweeper"];

// Sudoku and Crossword are one-puzzle-per-day games — "score" here is
// repurposed to store the player's current daily-solve streak instead of
// a personal best. Rebuilt from the old site's version (which had this
// same streak model) with cleaner puzzle generation and no ported bugs.
const STREAK_GAMES = ["sudoku", "crossword"];

const topPlayerSelect = {
  id: true,
  name: true,
  username: true,
  avatarUrl: true,
};

function isTimeBased(gameSlug) {
  return TIME_BASED_GAMES.includes(gameSlug);
}

function dayKey(date) {
  return date.toISOString().slice(0, 10); // UTC calendar day — same puzzle/streak boundary for everyone
}

// Streak games submit once per solved day: same day as last solve is a
// no-op (idempotent — replaying today's win doesn't inflate anything),
// consecutive day extends the streak, a gap resets it to 1.
async function submitStreakScore(gameSlug, userId) {
  const now = new Date();
  const todayStr = dayKey(now);

  const existing = await prisma.arcadeScore.findUnique({
    where: { gameSlug_userId: { gameSlug, userId } },
  });

  if (!existing) {
    await prisma.arcadeScore.create({
      data: { gameSlug, userId, score: 1, lastPlayedAt: now },
    });
    return { score: 1, isNewBest: true, previousBest: null };
  }

  const lastStr = existing.lastPlayedAt ? dayKey(new Date(existing.lastPlayedAt)) : null;
  if (lastStr === todayStr) {
    return { score: existing.score, isNewBest: false, previousBest: existing.score };
  }

  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const newStreak = lastStr === dayKey(yesterday) ? existing.score + 1 : 1;

  await prisma.arcadeScore.update({
    where: { gameSlug_userId: { gameSlug, userId } },
    data: { score: newStreak, lastPlayedAt: now },
  });
  return { score: newStreak, isNewBest: true, previousBest: existing.score };
}

// POST /api/arcade/:gameSlug/score — submits a run's score. Only kept if
// it beats the player's existing best for that game (lower-is-better for
// time-based games, higher-is-better otherwise). Always returns the
// player's current best after the call, so the frontend can show "New
// best!" or just their existing best unchanged.
async function submitScore(req, res) {
  try {
    const { gameSlug } = req.params;
    const { score } = req.body;

    if (!GAME_SLUGS.includes(gameSlug)) {
      return res.status(404).json({ message: "Unknown game" });
    }
    if (typeof score !== "number" || !Number.isFinite(score) || score < 0) {
      return res.status(400).json({ message: "Invalid score" });
    }

    if (STREAK_GAMES.includes(gameSlug)) {
      const result = await submitStreakScore(gameSlug, req.userId);
      return res.json(result);
    }

    const existing = await prisma.arcadeScore.findUnique({
      where: { gameSlug_userId: { gameSlug, userId: req.userId } },
    });

    const roundedScore = Math.round(score);
    const isBetter =
      !existing || (isTimeBased(gameSlug) ? roundedScore < existing.score : roundedScore > existing.score);

    if (!existing) {
      await prisma.arcadeScore.create({
        data: { gameSlug, userId: req.userId, score: roundedScore, lastPlayedAt: new Date() },
      });
    } else if (isBetter) {
      await prisma.arcadeScore.update({
        where: { gameSlug_userId: { gameSlug, userId: req.userId } },
        data: { score: roundedScore, lastPlayedAt: new Date() },
      });
    } else {
      await prisma.arcadeScore.update({
        where: { gameSlug_userId: { gameSlug, userId: req.userId } },
        data: { lastPlayedAt: new Date() },
      });
    }

    return res.json({
      score: isBetter ? roundedScore : existing.score,
      isNewBest: isBetter,
      previousBest: existing?.score ?? null,
    });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/arcade/:gameSlug/leaderboard — top 20 players for one game.
async function getLeaderboard(req, res) {
  try {
    const { gameSlug } = req.params;
    if (!GAME_SLUGS.includes(gameSlug)) {
      return res.status(404).json({ message: "Unknown game" });
    }

    const rows = await prisma.arcadeScore.findMany({
      where: { gameSlug, user: { deletedAt: null } },
      orderBy: { score: isTimeBased(gameSlug) ? "asc" : "desc" },
      take: 20,
      select: { score: true, updatedAt: true, user: { select: topPlayerSelect } },
    });

    return res.json(rows);
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/arcade/top-players — the #1 player for every game in one call,
// used by the "Arcade Champions" widget on the hub page and sidebar.
async function getTopPlayers(req, res) {
  try {
    const results = await Promise.all(
      GAME_SLUGS.map(async (gameSlug) => {
        const top = await prisma.arcadeScore.findFirst({
          where: { gameSlug, user: { deletedAt: null } },
          orderBy: { score: isTimeBased(gameSlug) ? "asc" : "desc" },
          select: { score: true, user: { select: topPlayerSelect } },
        });
        return [gameSlug, top || null];
      }),
    );

    return res.json(Object.fromEntries(results));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// GET /api/arcade/me — the logged-in player's own best score per game, so
// the hub can show "Your best" on each game tile.
async function getMyScores(req, res) {
  try {
    const rows = await prisma.arcadeScore.findMany({
      where: { userId: req.userId, gameSlug: { in: GAME_SLUGS } },
      select: { gameSlug: true, score: true, lastPlayedAt: true },
    });
    return res.json(Object.fromEntries(rows.map((r) => [r.gameSlug, r])));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { GAME_SLUGS, TIME_BASED_GAMES, submitScore, getLeaderboard, getTopPlayers, getMyScores };
