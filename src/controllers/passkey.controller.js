const { sendServerError } = require("../lib/errorLog");
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { RP_NAME, RP_ID, EXPECTED_ORIGIN, registrationChallengeKey, saveChallenge, consumeChallenge } = require("../lib/webauthn");
const { issueSession, describeUserAgent } = require("./auth.controller");
const { applyLoginStreak } = require("../utils/streak");

// GET /api/auth/passkeys — Settings > Account > Passkeys list.
async function listPasskeys(req, res) {
  try {
    const passkeys = await prisma.authenticator.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: "desc" },
      select: { id: true, deviceLabel: true, createdAt: true, lastUsedAt: true },
    });
    return res.json(passkeys);
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/passkeys/register-options — step 1 of adding a passkey to
// an already-logged-in account. residentKey: "required" is what makes the
// resulting passkey "discoverable" — i.e. usable for the usernameless
// login flow below, where the browser shows an account picker with no
// server round-trip needed to know who's signing in.
async function generateRegisterOptions(req, res) {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { id: true, username: true, name: true },
    });
    if (!user) return res.status(404).json({ message: "User not found" });

    const existing = await prisma.authenticator.findMany({
      where: { userId: user.id },
      select: { credentialId: true, transports: true },
    });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: new TextEncoder().encode(String(user.id)),
      userName: user.username || `user${user.id}`,
      userDisplayName: user.name || user.username || `user${user.id}`,
      attestationType: "none",
      excludeCredentials: existing.map((a) => ({
        id: a.credentialId,
        transports: a.transports ? a.transports.split(",") : undefined,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });

    await saveChallenge(registrationChallengeKey(user.id), options.challenge);
    return res.json(options);
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/passkeys/register-verify — step 2: body is whatever
// @simplewebauthn/browser's startRegistration(options) returned, plus an
// optional deviceLabel the Settings UI can prompt for. Falls back to a
// User-Agent-derived label ("Chrome on macOS") when none is given.
async function verifyRegister(req, res) {
  try {
    const { response, deviceLabel } = req.body || {};
    if (!response) return res.status(400).json({ message: "Missing registration response" });

    const expectedChallenge = await consumeChallenge(registrationChallengeKey(req.userId));
    if (!expectedChallenge) {
      return res.status(400).json({ message: "This registration attempt expired — try again." });
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ message: "Couldn't verify that passkey" });
    }

    const { credential } = verification.registrationInfo;
    await prisma.authenticator.create({
      data: {
        userId: req.userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports?.length ? credential.transports.join(",") : null,
        deviceLabel: deviceLabel?.trim() || describeUserAgent(req.headers["user-agent"]),
      },
    });

    return res.status(201).json({ message: "Passkey added" });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// DELETE /api/auth/passkeys/:id
async function deletePasskey(req, res) {
  try {
    const id = Number(req.params.id);
    const deleted = await prisma.authenticator.deleteMany({ where: { id, userId: req.userId } });
    if (!deleted.count) return res.status(404).json({ message: "Passkey not found" });
    return res.json({ message: "Passkey removed" });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/passkeys/login-options — no auth: this IS how you log in.
// No allowCredentials means the browser doesn't need to be told who's
// signing in ahead of time — it shows an account picker of whatever
// discoverable passkeys for this site it already knows about.
async function generateLoginOptions(req, res) {
  try {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "preferred",
    });
    const challengeId = crypto.randomUUID();
    await saveChallenge(challengeId, options.challenge);
    return res.json({ challengeId, options });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

// POST /api/auth/passkeys/login-verify  { challengeId, response } — same
// shape of result as a normal password login ({ message, token }), so the
// frontend's existing login() handling works unchanged.
async function verifyLogin(req, res) {
  try {
    const { challengeId, response } = req.body || {};
    if (!challengeId || !response) {
      return res.status(400).json({ message: "Missing passkey login response" });
    }

    const expectedChallenge = await consumeChallenge(challengeId);
    if (!expectedChallenge) {
      return res.status(400).json({ message: "This login attempt expired — try again." });
    }

    const authenticator = await prisma.authenticator.findUnique({ where: { credentialId: response.id } });
    if (!authenticator) {
      return res.status(400).json({ message: "That passkey isn't registered here" });
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: authenticator.credentialId,
        publicKey: new Uint8Array(authenticator.publicKey),
        counter: Number(authenticator.counter),
        transports: authenticator.transports ? authenticator.transports.split(",") : undefined,
      },
    });
    if (!verification.verified) {
      return res.status(400).json({ message: "Couldn't verify that passkey" });
    }

    const user = await prisma.user.findUnique({ where: { id: authenticator.userId } });
    if (!user) return res.status(404).json({ message: "Account not found" });

    await Promise.all([
      prisma.authenticator.update({
        where: { id: authenticator.id },
        data: { counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date() },
      }),
      user.deletedAt ? prisma.user.update({ where: { id: user.id }, data: { deletedAt: null } }) : null,
    ]);

    // A passkey is itself a strong, phishing-resistant second factor, so
    // (unlike a plain password) it skips the separate 2FA-code step even
    // on accounts that have 2FA turned on.
    await applyLoginStreak(user);
    const token = await issueSession(user, req);
    return res.json({ message: "Login successful", token });
  } catch (error) {
    return sendServerError(res, error, req, "Server error");
  }
}

module.exports = {
  listPasskeys,
  generateRegisterOptions,
  verifyRegister,
  deletePasskey,
  generateLoginOptions,
  verifyLogin,
};
