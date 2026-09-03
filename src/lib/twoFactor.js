const { authenticator } = require("otplib");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const ISSUER = "Oh Sheet!";
const BACKUP_CODE_COUNT = 10;

function generateSecret() {
  return authenticator.generateSecret();
}

async function buildQrCode(secret, accountLabel) {
  const otpauthUrl = authenticator.keyuri(accountLabel, ISSUER, secret);
  const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
  return { otpauthUrl, qrCodeDataUrl };
}

function verifyCode(code, secret) {
  if (!code || !secret) return false;
  try {
    return authenticator.check(String(code).replace(/\s/g, ""), secret);
  } catch {
    return false;
  }
}

// Backup codes are shown to the user exactly once (at generation time) and
// only ever stored as bcrypt hashes — same treatment as a real password,
// since possessing one lets you log in.
function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const raw = crypto.randomBytes(5).toString("hex"); // 10 hex chars
    codes.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return codes;
}

async function hashBackupCodes(codes) {
  const hashed = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)));
  return JSON.stringify(hashed);
}

// Checks `code` against the stored hashed list; if it matches, returns the
// remaining list (JSON string) with that one consumed — the caller is
// responsible for persisting it, so a code can only ever be used once.
async function consumeBackupCode(code, storedJson) {
  if (!code || !storedJson) return null;
  let hashes;
  try {
    hashes = JSON.parse(storedJson);
  } catch {
    return null;
  }
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(String(code).trim(), hashes[i])) {
      const remaining = [...hashes.slice(0, i), ...hashes.slice(i + 1)];
      return JSON.stringify(remaining);
    }
  }
  return null;
}

module.exports = {
  generateSecret,
  buildQrCode,
  verifyCode,
  generateBackupCodes,
  hashBackupCodes,
  consumeBackupCode,
};
