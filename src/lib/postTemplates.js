// Post templates — structured extra data a post can carry on top of its
// normal plain-text caption. `content`/`contentHtml` stay the caption
// either way (so search, @mentions, OG image generation, RSS, etc. all
// keep working against them unchanged, same as every other post) —
// `templateData` is purely additive, rendered as its own card by
// FeedCard.jsx/PostPage.jsx above the caption.
//
// Adding a new template type: add its key to TEMPLATE_FIELDS below with
// each field's kind, then teach the frontend (CreatePage.jsx's template
// picker, FeedCard.jsx's template card renderer) to match.

const MAX_LIST_ITEMS = 30;
const MAX_SHORT_STRING = 200;
const MAX_LONG_STRING = 2000;

function clampString(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clampList(value, itemMax) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => clampString(v, itemMax))
    .filter(Boolean)
    .slice(0, MAX_LIST_ITEMS);
}

// Each normalizer takes whatever raw JSON the client sent and returns a
// clean object with only its own known fields, so an unrecognized or
// malformed field never reaches the database.
const TEMPLATE_NORMALIZERS = {
  recipe(raw = {}) {
    const data = {
      servings: clampString(raw.servings, 40),
      prepTime: clampString(raw.prepTime, 40),
      cookTime: clampString(raw.cookTime, 40),
      ingredients: clampList(raw.ingredients, MAX_SHORT_STRING),
      steps: clampList(raw.steps, MAX_LONG_STRING),
    };
    const isEmpty =
      !data.servings &&
      !data.prepTime &&
      !data.cookTime &&
      !data.ingredients.length &&
      !data.steps.length;
    return isEmpty ? null : data;
  },
  travel(raw = {}) {
    const data = {
      place: clampString(raw.place, MAX_SHORT_STRING),
      startDate: clampString(raw.startDate, 20),
      endDate: clampString(raw.endDate, 20),
      highlights: clampList(raw.highlights, MAX_SHORT_STRING),
    };
    const isEmpty = !data.place && !data.startDate && !data.endDate && !data.highlights.length;
    return isEmpty ? null : data;
  },
};

// Turns whatever the client sent (req.body.templateType/templateData)
// into a safe { templateType, templateData } pair, or { null, null } if
// the type is unrecognized or the data normalizes away to nothing.
function normalizeTemplate(rawType, rawData) {
  const type = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  const normalizer = TEMPLATE_NORMALIZERS[type];
  if (!normalizer) return { templateType: null, templateData: null };

  const templateData = normalizer(rawData && typeof rawData === "object" ? rawData : {});
  if (!templateData) return { templateType: null, templateData: null };

  return { templateType: type, templateData };
}

module.exports = { normalizeTemplate, TEMPLATE_NORMALIZERS };
