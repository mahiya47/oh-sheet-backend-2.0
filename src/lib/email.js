// Account emails (verification links, password reset links) via Resend —
// the same provider the old backend used. Requires RESEND_API_KEY in the
// environment; every caller treats a send failure as non-fatal (logs and
// moves on) so a flaky email provider never blocks signup or login.
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5174";

async function sendVerificationEmail(to, token) {
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping verification email to", to);
    return;
  }
  const verifyUrl = `${FRONTEND_URL}/verify/${token}`;
  await resend.emails.send({
    from: "Oh Sheet! <noreply@ohsheet.blog>",
    to,
    subject: "Verify your email — Oh Sheet!",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>🐑 Welcome to Oh Sheet!</h2>
        <p>Click the button below to verify your email address:</p>
        <a href="${verifyUrl}"
           style="display: inline-block; padding: 12px 24px; background: #f5c945; color: #1c1810; text-decoration: none; border-radius: 8px; font-weight: 700;">
          Verify Email
        </a>
        <p style="color: #888; font-size: 13px;">Or copy this link: ${verifyUrl}</p>
        <p style="color: #888; font-size: 13px;">If you didn't sign up, ignore this email.</p>
      </div>
    `,
  });
}

async function sendPasswordResetEmail(to, token) {
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping password reset email to", to);
    return;
  }
  const resetUrl = `${FRONTEND_URL}/reset-password/${token}`;
  await resend.emails.send({
    from: "Oh Sheet! <noreply@ohsheet.blog>",
    to,
    subject: "Reset your password — Oh Sheet!",
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>🐑 Reset your password</h2>
        <p>Click the button below to set a new password. This link expires in 1 hour.</p>
        <a href="${resetUrl}"
           style="display: inline-block; padding: 12px 24px; background: #f5c945; color: #1c1810; text-decoration: none; border-radius: 8px; font-weight: 700;">
          Reset Password
        </a>
        <p style="color: #888; font-size: 13px;">Or copy this link: ${resetUrl}</p>
        <p style="color: #888; font-size: 13px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>
      </div>
    `,
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
