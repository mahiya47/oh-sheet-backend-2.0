const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { UAParser } = require("ua-parser-js");
const prisma = require("../lib/prisma");
const { publicUserSelect } = require("../utils/format");
const { sendVerificationEmail, sendPasswordResetEmail } = require("../lib/email");
const { createNotification } = require("../utils/notify");
const { applyLoginStreak } = require("../utils/streak");
const { generateWelcomeMessage } = require("../lib/groq");
const { generateCatNoise } = require("../lib/pikku");
const { getBotIds } = require("../lib/bots");
const { sendServerError } = require("../lib/errorLog");
const {
  generateSecret,
  buildQrCode,
  verifyCode,
  generateBackupCodes,
  hashBackupCodes,
  consumeBackupCode,
} = require("../lib/twoFactor");

const CREATOR_USERNAME = "sourabhmahiya";

function signToken(user, jti) {
  const payload = { userId: user.id, email: user.email };
  if (jti) payload.jti = jti;
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
}

// Issues a real login token AND records it as a Session row, so it shows
// up in Settings > Account > Sessions and can be revoked remotely. Used by
// every path that logs someone in for real — register, password login,
// 2FA-verified login, OAuth callback — but NOT the 2FA challenge token
// (signChallengeToken below), which isn't a real session yet.
async function issueSession(user, req) {
  const jti = crypto.randomUUID();
  const token = signToken(user, jti);
  await prisma.session.create({
    data: {
      userId: user.id,
      jti,
      userAgent: (req?.headers?.["user-agent"] || "").slice(0, 300) || null,
    },
  });
  return token;
}

// A short-lived, single-purpose token for the gap between "password
// checked out" and "2FA code confirmed" — deliberately NOT a real login
// token (authMiddleware would never accept it: no matching claim shape,
// and it's checked against its own `pending2FA` flag besides).
const TWO_FA_CHALLENGE_TTL = "10m";
function signChallengeToken(userId) {
  return jwt.sign({ userId, pending2FA: true }, process.env.JWT_SECRET, {
    expiresIn: TWO_FA_CHALLENGE_TTL,
  });
}

const LINK_NONCE_TTL = "5m";

// Starting an OAuth account-link (Settings -> "Connect Google/GitHub")
// used to put the user's actual session JWT straight into the /link
// route's URL, which Google/GitHub's OAuth redirect then echoes back —
// so that token sat in the browser's address bar, its history, and both
// this server's and the provider's access logs for as long as either
// keeps them. A leaked copy from any of those was a fully valid, long-
// lived session token. This nonce is scoped to nothing but "start a link
// flow for this one user, once, within five minutes" (see
// lib/passport.js's parseLinkUserId, which also enforces the one-time-use
// part) — worthless for anything else even if it leaks the exact same way.
function signLinkNonce(userId) {
  return jwt.sign(
    { userId, purpose: "oauth-link", jti: crypto.randomUUID() },
    process.env.JWT_SECRET,
    { expiresIn: LINK_NONCE_TTL },
  );
}

// POST /api/auth/link-nonce — authenticated (real session required), so
// only the logged-in user themselves can mint a nonce for their own id.
async function getOAuthLinkNonce(req, res) {
  try {
    return res.json({ nonce: signLinkNonce(req.userId) });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

// Mirrors the username-based creator lookup in lib/passport.js — kept as
// its own small helper here rather than hard-coding an id, since ids
// aren't stable between the production database and a fresh/local one.
async function followCreatorIfNew(userId) {
  try {
    const creator = await prisma.user.findFirst({ where: { username: CREATOR_USERNAME } });
    if (creator && creator.id !== userId) {
      await prisma.follow.create({ data: { followerId: userId, followingId: creator.id } });
    }
  } catch {
    // Not fatal — creator account may not exist in this DB yet.
  }
}

// Fire the bot welcome DMs — fire-and-forget (not awaited by the caller)
// so a slow Groq call or a DB hiccup never delays the signup response.
// Each bot's DM is wrapped in its own try/catch so one failing doesn't
// stop the other from sending.
function sendBotWelcomeDms(user) {
  (async () => {
    const bots = getBotIds();
    if (!bots) return; // server started before bot accounts finished setting up

    if (bots.tonald && bots.tonald !== user.id) {
      try {
        const welcomeText = await generateWelcomeMessage(user.name || user.username);
        await prisma.directMessage.create({
          data: { content: welcomeText.slice(0, 1000), senderId: bots.tonald, receiverId: user.id },
        });
        await createNotification({ recipientId: user.id, actorId: bots.tonald, type: "dm" });
      } catch (e) {
        console.error("Tonald welcome DM failed:", e.message);
      }
    }

    if (bots.pikku && bots.pikku !== user.id) {
      try {
        await prisma.directMessage.create({
          data: { content: generateCatNoise(), senderId: bots.pikku, receiverId: user.id },
        });
        await createNotification({ recipientId: user.id, actorId: bots.pikku, type: "dm" });
      } catch (e) {
        console.error("Pikku welcome DM failed:", e.message);
      }
    }
  })();
}

async function register(req, res) {
  try {
    const { name, username, email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({ message: "Email already registered" });
    }

    let finalUsername = (username || "").trim();
    if (finalUsername) {
      const existingUsername = await prisma.user.findUnique({
        where: { username: finalUsername },
      });
      if (existingUsername) {
        return res.status(400).json({ message: "That username is already taken" });
      }
    } else {
      finalUsername = `user_${crypto.randomBytes(4).toString("hex")}`;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const verifyToken = crypto.randomBytes(32).toString("hex");

    const user = await prisma.user.create({
      data: {
        name: (name || finalUsername).trim(),
        username: finalUsername,
        email: email.toLowerCase().trim(),
        password: hashedPassword,
        verifyToken,
      },
      select: publicUserSelect,
    });

    await followCreatorIfNew(user.id);
    sendBotWelcomeDms(user);

    // Best-effort — a flaky email provider should never block signup.
    try {
      await sendVerificationEmail(user.email, verifyToken);
    } catch (e) {
      console.error("Verification email failed:", e.message);
    }

    const token = await issueSession({ id: user.id, email }, req);
    return res.status(201).json({ message: "Account created", token, user });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(400).json({ message: "Email or username already taken" });
    }
    return sendServerError(res, error, req, "Server error");
  }
}

// GET /api/auth/verify/:token
async function verifyEmail(req, res) {
  try {
    const { token } = req.params;
    const user = await prisma.user.findUnique({ where: { verifyToken: token } });
    if (!user) {
      return res.status(400).json({ message: "Invalid or expired link" });
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verifyToken: null },
    });
    return res.json({ message: "Email verified successfully" });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/resend-verification (authenticated)
async function resendVerification(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.emailVerified) {
      return res.status(400).json({ message: "Email already verified" });
    }

    const verifyToken = crypto.randomBytes(32).toString("hex");
    await prisma.user.update({ where: { id: user.id }, data: { verifyToken } });
    await sendVerificationEmail(user.email, verifyToken);

    return res.json({ message: "Verification email sent" });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// POST /api/auth/forgot-password — always responds with the same generic
// message whether or not the email exists, so this can't be used to probe
// which emails are registered.
async function forgotPassword(req, res) {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email is required" });

    const user = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (user && user.password) {
      const resetToken = crypto.randomBytes(32).toString("hex");
      await prisma.user.update({
        where: { id: user.id },
        data: { resetToken, resetTokenExpiry: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
      });
      try {
        await sendPasswordResetEmail(user.email, resetToken);
      } catch (e) {
        console.error("Password reset email failed:", e.message);
      }
    }

    return res.json({
      message: "If that email is registered, a password reset link is on its way.",
    });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/reset-password/:token
async function resetPassword(req, res) {
  try {
    const { token } = req.params;
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }

    const user = await prisma.user.findUnique({ where: { resetToken: token } });
    if (!user || !user.resetTokenExpiry || user.resetTokenExpiry < new Date()) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
        // Logs out every device holding an old token — authMiddleware
        // rejects any token issued before this timestamp.
        passwordChangedAt: new Date(),
      },
    });

    return res.json({ message: "Password updated — please log in again." });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

// Accounts past their 7-day soft-delete grace window are gone for good —
// purge them lazily (same pattern as notification expiry) rather than
// running a separate cron job. Best-effort: never blocks a login attempt.
async function purgeExpiredDeletedAccounts() {
  try {
    await prisma.user.deleteMany({
      where: { deletedAt: { lt: new Date(Date.now() - DELETE_GRACE_MS) } },
    });
  } catch {
    // ignore — this is just opportunistic cleanup
  }
}

async function login(req, res) {
  try {
    await purgeExpiredDeletedAccounts();
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res
        .status(400)
        .json({ message: "Please enter your email/username and password" });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier.toLowerCase().trim() },
          { username: identifier.trim() },
        ],
      },
    });

    if (!user || !user.password) {
      return res.status(400).json({ message: "Invalid email/username or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid email/username or password" });
    }

    if (user.deletedAt) {
      // Reactivate an account within the 7 day soft-delete window.
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });
    }

    // Password checks out, but 2FA is enabled — hold off on the real
    // login (streak, token) until verify-login confirms the code. A stolen
    // password alone should never be enough to get in.
    if (user.twoFactorEnabled) {
      return res.json({ requires2FA: true, challengeToken: signChallengeToken(user.id) });
    }

    await applyLoginStreak(user);

    const token = await issueSession(user, req);
    return res.json({ message: "Login successful", token });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/2fa/verify-login  { challengeToken, code } — the second
// step of logging in when 2FA is enabled. `code` can be a 6-digit
// authenticator code or one of the one-time backup codes.
async function verifyLogin2FA(req, res) {
  try {
    const { challengeToken, code } = req.body;
    if (!challengeToken || !code) {
      return res.status(400).json({ message: "Code is required" });
    }

    let decoded;
    try {
      decoded = jwt.verify(challengeToken, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ message: "That login attempt expired — please log in again" });
    }
    if (!decoded.pending2FA) {
      return res.status(400).json({ message: "Invalid challenge" });
    }

    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user || !user.twoFactorEnabled) {
      return res.status(400).json({ message: "2FA is not enabled on this account" });
    }

    let usedBackupCode = false;
    if (verifyCode(code, user.twoFactorSecret)) {
      // matched via authenticator code
    } else {
      const remaining = await consumeBackupCode(code, user.twoFactorBackupCodes);
      if (remaining === null) {
        return res.status(400).json({ message: "Invalid code" });
      }
      usedBackupCode = true;
      await prisma.user.update({ where: { id: user.id }, data: { twoFactorBackupCodes: remaining } });
    }

    if (user.deletedAt) {
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } });
    }
    await applyLoginStreak(user);

    const token = await issueSession(user, req);
    return res.json({ message: "Login successful", token, usedBackupCode });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/2fa/setup (authenticated) — generates a new secret and QR
// code. Not enabled yet: the secret is stored so /2fa/enable can verify
// against it, but twoFactorEnabled stays false until that succeeds.
async function setup2FA(req, res) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ message: "2FA is already enabled" });
    }

    const secret = generateSecret();
    await prisma.user.update({ where: { id: user.id }, data: { twoFactorSecret: secret } });

    const { qrCodeDataUrl } = await buildQrCode(secret, user.username || user.email);
    return res.json({ secret, qrCodeDataUrl });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/2fa/enable (authenticated)  { code } — confirms the
// authenticator app was set up correctly before actually turning 2FA on,
// and hands back backup codes (shown exactly this once).
async function enable2FA(req, res) {
  try {
    const { code } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.twoFactorEnabled) {
      return res.status(400).json({ message: "2FA is already enabled" });
    }
    if (!user.twoFactorSecret) {
      return res.status(400).json({ message: "Start setup first" });
    }
    if (!verifyCode(code, user.twoFactorSecret)) {
      return res.status(400).json({ message: "Invalid code — check your authenticator app and try again" });
    }

    const backupCodes = generateBackupCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: true, twoFactorBackupCodes: await hashBackupCodes(backupCodes) },
    });

    return res.json({ message: "2FA enabled", backupCodes });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/2fa/disable (authenticated)  { password? } — password is
// required when the account has one; an OAuth-only account (no password
// to check) can disable directly.
async function disable2FA(req, res) {
  try {
    const { password } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return res.status(404).json({ message: "User not found" });
    if (!user.twoFactorEnabled) {
      return res.status(400).json({ message: "2FA isn't enabled" });
    }

    if (user.password) {
      if (!password || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ message: "Incorrect password" });
      }
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { twoFactorEnabled: false, twoFactorSecret: null, twoFactorBackupCodes: null },
    });
    return res.json({ message: "2FA disabled" });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// Turns a raw User-Agent string into something a person can actually read
// in the Settings > Account > Sessions list ("Chrome on macOS" instead of
// the full UA string).
function describeUserAgent(userAgent) {
  if (!userAgent) return "Unknown device";
  const { browser, os } = new UAParser(userAgent).getResult();
  const browserName = browser.name || "Unknown browser";
  const osName = os.name || "Unknown OS";
  return `${browserName} on ${osName}`;
}

// GET /api/auth/sessions — every device currently logged into this
// account, most recently active first, so someone can spot a login they
// don't recognize.
async function getSessions(req, res) {
  try {
    const sessions = await prisma.session.findMany({
      where: { userId: req.userId, revokedAt: null },
      orderBy: { lastActiveAt: "desc" },
    });
    return res.json(
      sessions.map((s) => ({
        id: s.id,
        device: describeUserAgent(s.userAgent),
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        isCurrent: !!req.sessionJti && s.jti === req.sessionJti,
      })),
    );
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// DELETE /api/auth/sessions/:id — log out one specific device remotely.
// Revoking the session behind the request you're making right now is
// allowed (and is really just "log out") — the very next authenticated
// request on that device gets rejected by authMiddleware and its frontend
// treats that the same as any other expired session.
async function revokeSession(req, res) {
  try {
    const id = Number(req.params.id);
    const session = await prisma.session.findUnique({ where: { id } });
    if (!session || session.userId !== req.userId) {
      return res.status(404).json({ message: "Session not found" });
    }
    await prisma.session.update({ where: { id }, data: { revokedAt: new Date() } });
    return res.json({ message: "Session logged out" });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// GET /api/auth/me — who the current token belongs to. This is what the
// new frontend calls right after loading a stored token to know who's
// logged in, and what to show as "your own" post/profile.
async function getMe(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: {
        id: true,
        name: true,
        username: true,
        email: true,
        bio: true,
        avatarUrl: true,
        coverUrl: true,
        emailVerified: true,
        isPrivate: true,
        createdAt: true,
        birthday: true,
        pronouns: true,
        currentCity: true,
        work: true,
        education: true,
        gender: true,
        showGender: true,
        orientation: true,
        showOrientation: true,
        githubUrl: true,
        twitterUrl: true,
        linkedinUrl: true,
        instagramUrl: true,
        pinterestUrl: true,
        googleId: true,
        githubId: true,
        twoFactorEnabled: true,
        password: true,
      },
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    // Never expose the raw OAuth provider ids (or the password hash) to the
    // client — just whether each provider is linked, and whether a password
    // exists at all (an OAuth-only account has none, which the 2FA-disable
    // flow on the Account tab needs to know before asking for one).
    const { googleId, githubId, password, ...rest } = user;
    return res.json({
      ...rest,
      googleConnected: !!googleId,
      githubConnected: !!githubId,
      hasPassword: !!password,
    });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

async function deleteAccount(req, res) {
  try {
    await prisma.user.update({
      where: { id: req.userId },
      data: { deletedAt: new Date() },
    });
    return res.json({
      message: "Account deleted. Log back in within 7 days to undo this.",
    });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

module.exports = {
  register,
  login,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  getMe,
  deleteAccount,
  signToken,
  verifyLogin2FA,
  setup2FA,
  enable2FA,
  disable2FA,
  getSessions,
  revokeSession,
  issueSession,
  describeUserAgent,
  getOAuthLinkNonce,
};
