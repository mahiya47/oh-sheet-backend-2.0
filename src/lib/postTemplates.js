// Post templates (Recipe, Travel log) — structured extra data a post can
// carry alongside its normal caption. Add a new type by adding a key to
// TEMPLATE_NORMALIZERS below, then wire it up on the frontend.

const MAX_LIST_ITEMS = 30;
const MAX_SHORT_STRING = 200;
const MAX_LONG_STRING = 2000;
const MAX_CODE_LENGTH = 20000;

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
      !data.servings && !data.prepTime && !data.cookTime && !data.ingredients.length && !data.steps.length;
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
  code(raw = {}) {
    const data = {
      language: clampString(raw.language, 40),
      filename: clampString(raw.filename, 100),
      code: clampString(raw.code, MAX_CODE_LENGTH),
    };
    const isEmpty = !data.language && !data.filename && !data.code;
    return isEmpty ? null : data;
  },
};

function normalizeTemplate(rawType, rawData) {
  const type = typeof rawType === "string" ? rawType.trim().toLowerCase() : "";
  const normalizer = TEMPLATE_NORMALIZERS[type];
  if (!normalizer) return { templateType: null, templateData: null };

  const templateData = normalizer(rawData && typeof rawData === "object" ? rawData : {});
  if (!templateData) return { templateType: null, templateData: null };

  return { templateType: type, templateData };
}

module.exports = { normalizeTemplate, TEMPLATE_NORMALIZERS };
