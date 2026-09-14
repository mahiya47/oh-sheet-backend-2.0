// Scrapes Open Graph tags for a link preview card. No extra dependency —
// just node's http/https. Any failure (bad url, private ip, timeout, huge
// page, not html) just returns null instead of throwing.

const http = require("http");
const https = require("https");
const dns = require("dns").promises;
const { URL } = require("url");

const FETCH_TIMEOUT_MS = 4000;
const MAX_BYTES = 500 * 1024;
const MAX_REDIRECTS = 3;
const USER_AGENT = "Mozilla/5.0 (compatible; OhSheetLinkPreview/1.0; +https://ohsheet.blog)";

const URL_RE = /https?:\/\/[^\s<>"']+/i;
function extractFirstUrl(text) {
  if (!text) return null;
  const match = text.match(URL_RE);
  if (!match) return null;
  return match[0].replace(/[).,!?'"]+$/, "");
}

// Blocks loopback/private/link-local so this can't be used to probe our
// own internal network from a pasted link.
function isPrivateAddress(address) {
  if (address === "::1" || address === "0.0.0.0") return true;
  if (address.startsWith("127.")) return true;
  if (address.startsWith("10.")) return true;
  if (address.startsWith("169.254.")) return true;
  if (/^192\.168\./.test(address)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/i.test(address)) return true;
  if (/^fe[89ab][0-9a-f]:/i.test(address)) return true;
  return false;
}

async function assertSafeUrl(parsed) {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Unsupported protocol");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  let records;
  try {
    records = await dns.lookup(hostname, { all: true });
  } catch {
    throw new Error("Could not resolve host");
  }
  if (!records.length || records.some((r) => isPrivateAddress(r.address))) {
    throw new Error("Refusing to fetch a private/internal address");
  }
}

function get(urlString, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return reject(new Error("Invalid URL"));
    }

    assertSafeUrl(parsed)
      .then(() => {
        const client = parsed.protocol === "https:" ? https : http;
        const req = client.get(
          parsed,
          { timeout: FETCH_TIMEOUT_MS, headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" } },
          (res) => {
            const { statusCode, headers } = res;

            if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
              res.resume();
              const next = new URL(headers.location, parsed).toString();
              resolve(get(next, redirectsLeft - 1));
              return;
            }

            if (statusCode < 200 || statusCode >= 300) {
              res.resume();
              return reject(new Error(`HTTP ${statusCode}`));
            }

            const contentType = headers["content-type"] || "";
            if (!contentType.includes("html")) {
              res.resume();
              return reject(new Error("Not an HTML page"));
            }

            let body = "";
            let bytes = 0;
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              bytes += Buffer.byteLength(chunk);
              body += chunk;
              if (bytes >= MAX_BYTES) {
                res.destroy();
                resolve({ body, finalUrl: parsed.toString() });
              }
            });
            res.on("end", () => resolve({ body, finalUrl: parsed.toString() }));
          },
        );
        req.on("timeout", () => req.destroy(new Error("Timed out")));
        req.on("error", reject);
      })
      .catch(reject);
  });
}

function extractMeta(html) {
  const og = {};
  const metaTagRe = /<meta\b[^>]*>/gi;
  let m;
  while ((m = metaTagRe.exec(html))) {
    const tag = m[0];
    const propMatch = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i);
    const contentMatch = tag.match(/content\s*=\s*["']([^"']*)["']/i);
    if (!propMatch || !contentMatch) continue;
    const key = propMatch[1].toLowerCase();
    if (key.startsWith("og:")) {
      og[key.slice(3)] = decodeEntities(contentMatch[1]);
    }
  }
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = titleMatch ? decodeEntities(titleMatch[1].trim()) : null;
  return { og, pageTitle };
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .trim();
}

async function fetchLinkPreview(url) {
  try {
    const { body, finalUrl } = await get(url, MAX_REDIRECTS);
    const { og, pageTitle } = extractMeta(body);

    const title = og.title || pageTitle || null;
    const description = og.description || null;
    const siteName = og["site_name"] || null;
    let image = og.image || null;
    if (image) {
      try {
        image = new URL(image, finalUrl).toString();
      } catch {
        image = null;
      }
    }

    if (!title && !description && !image) return null;

    return { url: finalUrl, title, description, image, siteName };
  } catch (error) {
    console.error("Link preview fetch failed:", error.message);
    return null;
  }
}

module.exports = { extractFirstUrl, fetchLinkPreview };
