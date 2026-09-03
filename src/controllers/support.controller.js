const prisma = require("../lib/prisma");
const { sendServerError } = require("../lib/errorLog");

// POST /api/support — the Support page's contact form. Works whether
// you're logged in or not (optionalAuth), same as the old app.
async function createTicket(req, res) {
  try {
    const { name, email, subject, message } = req.body;

    if (!email?.trim() || !subject?.trim() || !message?.trim()) {
      return res.status(400).json({ message: "Email, subject, and message are required" });
    }

    const ticket = await prisma.supportTicket.create({
      data: {
        userId: req.userId || null,
        name: name?.trim() || null,
        email: email.trim(),
        subject: subject.trim().slice(0, 200),
        message: message.trim().slice(0, 5000),
      },
    });

    return res.status(201).json({ message: "Ticket submitted", id: ticket.id });
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { createTicket };
