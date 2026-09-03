const prisma = require("../lib/prisma");
const { sendServerError } = require("../lib/errorLog");

// Uploads are stored as bytes directly in this database (no third-party
// storage) — kept reasonably small so the database stays fast. Bump these
// if you need bigger files later.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB
const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25MB

// Explicit allowlist — notably excludes image/svg+xml, which can carry
// inline <script> and would be an XSS vector if ever rendered/opened
// directly. Anything not on this list is rejected outright, whatever
// browser mimetype the upload claims.
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const ALLOWED_VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);

// Cheap magic-byte sniff so a renamed/relabeled file can't sneak past the
// mimetype check above (a malicious upload can set any Content-Type it
// wants — this looks at the actual bytes instead). Returns "image", "video",
// or null if nothing recognized.
function sniffKind(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image"; // JPEG
  }
  if (buffer.length >= 8 && buffer.toString("hex", 0, 8) === "89504e470d0a1a0a") {
    return "image"; // PNG
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return "image"; // GIF
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image"; // WEBP
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") {
    return "video"; // MP4 / MOV / M4V family (all share the ftyp box)
  }
  if (buffer.length >= 4 && buffer.toString("hex", 0, 4) === "1a45dfa3") {
    return "video"; // WEBM / MKV (EBML header)
  }
  return null;
}

function mediaUrl(req, id) {
  return `${req.protocol}://${req.get("host")}/api/media/${id}`;
}

// POST /api/media  (multipart/form-data, field name "file")
async function uploadMedia(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const { mimetype, size, buffer } = req.file;
    const isImage = ALLOWED_IMAGE_TYPES.has(mimetype);
    const isVideo = ALLOWED_VIDEO_TYPES.has(mimetype);

    if (!isImage && !isVideo) {
      return res.status(400).json({ message: "Only jpg/png/gif/webp images or mp4/webm/mov videos are allowed" });
    }

    const sniffed = sniffKind(buffer);
    const expectedKind = isImage ? "image" : "video";
    if (sniffed !== expectedKind) {
      return res.status(400).json({ message: "That file's content doesn't match its type — upload wasn't accepted" });
    }

    const limit = isImage ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (size > limit) {
      return res.status(400).json({
        message: `File too large (max ${Math.floor(limit / (1024 * 1024))}MB for ${isImage ? "images" : "videos"})`,
      });
    }

    const media = await prisma.media.create({
      data: {
        data: buffer,
        mimeType: mimetype,
        byteSize: size,
        uploadedBy: req.userId,
      },
      select: { id: true },
    });

    return res.status(201).json({
      id: media.id,
      url: mediaUrl(req, media.id),
      mimeType: mimetype,
      kind: isImage ? "image" : "video",
    });
  } catch (error) {
    return sendServerError(res, error, req, "Upload failed");
  }
}

// GET /api/media/:id — serves the raw file with the right content type.
async function getMedia(req, res) {
  try {
    const id = Number(req.params.id);
    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) return res.status(404).json({ message: "Not found" });

    res.set("Content-Type", media.mimeType);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    // Prisma returns Bytes columns as a plain Uint8Array, not a Node
    // Buffer — res.send() only takes the binary-safe path for a real
    // Buffer, so wrap it or the response gets corrupted/re-encoded.
    return res.send(Buffer.from(media.data));
  } catch (error) {
    return sendServerError(res, error, req);
  }
}

module.exports = { uploadMedia, getMedia, mediaUrl, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES };
