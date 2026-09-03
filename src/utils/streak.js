const prisma = require("../lib/prisma");

// Ported from the old backend's login handler — currentStreak/
// lastStreakUpdate exist on the User model already, but nothing in 2.0
// was actually touching them, so every profile showed a frozen streak.
//
// Only counts once per calendar day (so refreshing the page all day
// doesn't inflate it): +1 if the last check-in was exactly yesterday,
// reset to 1 on any bigger gap (or a first-ever check-in). Awards the
// same +1 score bump the old app gave for a day's first login.
//
// Password login only, matching the old app — it never did this for
// OAuth logins either.
async function applyLoginStreak(user) {
  const now = new Date();
  const last = user.lastLoginAt ? new Date(user.lastLoginAt) : null;
  const isNewDay =
    !last ||
    last.getFullYear() !== now.getFullYear() ||
    last.getMonth() !== now.getMonth() ||
    last.getDate() !== now.getDate();

  if (!isNewDay) {
    // Still the same calendar day — just bump lastLoginAt, streak unchanged.
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } });
    return;
  }

  let newStreak = user.currentStreak || 0;
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  if (user.lastStreakUpdate) {
    const lastUpdateStart = new Date(user.lastStreakUpdate);
    lastUpdateStart.setHours(0, 0, 0, 0);
    const diffDays = Math.round((todayStart - lastUpdateStart) / 86400000);

    if (diffDays === 1) newStreak += 1;
    else if (diffDays > 1) newStreak = 1;
    // diffDays === 0 can't happen here since isNewDay is already true.
  } else {
    newStreak = 1;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      score: { increment: 1 },
      lastLoginAt: now,
      currentStreak: newStreak,
      lastStreakUpdate: now,
    },
  });
}

module.exports = { applyLoginStreak };
