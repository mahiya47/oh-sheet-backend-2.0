const { Filter } = require("bad-words");

const filter = new Filter();

const URL_RE = /https?:\/\/\S+/gi;
const MAX_URLS = 3;
// Same character repeated 10+ times in a row ("aaaaaaaaaaaa") — cheap,
// effective signal for keyboard-mash / spam content.
const REPEAT_CHAR_RE = /(.)\1{9,}/;

// Returns a user-facing rejection message, or null if the content is fine.
// Used to BLOCK submission (post/comment creation) per product decision —
// not a silent flag, the author has to edit and resubmit.
function checkContent(text) {
  if (!text) return null;

  if (filter.isProfane(text)) {
    return "That contains language we don't allow here — please edit and try again.";
  }

  const urlCount = (text.match(URL_RE) || []).length;
  if (urlCount > MAX_URLS) {
    return "That looks like spam (too many links).";
  }

  if (REPEAT_CHAR_RE.test(text)) {
    return "That looks like spam.";
  }

  return null;
}

module.exports = { checkContent };
