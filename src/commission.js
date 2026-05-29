const rules = require("./commission-rules.json");

const FBO_LIMITS = [100, 300, 1500, 5000, 10000, Infinity];

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token && token !== "и" && token !== "для");
}

function fboIndex(price) {
  const value = Number(price);
  if (!Number.isFinite(value) || value <= 0) return -1;
  return FBO_LIMITS.findIndex((limit) => value <= limit);
}

function scoreRule(product, rule) {
  const typeName = normalizeText(product.type_name);
  const categoryName = normalizeText(product.category_name);
  const ruleType = normalizeText(rule.type_name);
  const ruleCategory = normalizeText(rule.category_name);

  if (typeName && ruleType && typeName === ruleType) return 1000;

  let score = 0;
  if (categoryName && ruleCategory && categoryName === ruleCategory) score += 100;
  const productTokens = new Set(tokens(product.type_name));
  const ruleTokens = tokens(rule.type_name);
  for (const token of ruleTokens) {
    if (productTokens.has(token)) score += 10;
  }

  if (typeName && ruleType && (typeName.includes(ruleType) || ruleType.includes(typeName))) score += 50;
  return score;
}

function findRule(product) {
  let best = null;
  let bestScore = 0;
  for (const rule of rules) {
    const score = scoreRule(product, rule);
    if (score > bestScore) {
      best = rule;
      bestScore = score;
    }
  }
  return bestScore >= 30 ? { rule: best, score: bestScore } : null;
}

function calculateFboCommission(product, price) {
  const index = fboIndex(price);
  if (index < 0) return null;

  const match = findRule(product);
  if (!match) return null;

  const rawRate = match.rule.fbo[index];
  const rate = Number(rawRate);
  if (!Number.isFinite(rate)) return null;

  return {
    commission_rate: Number((rate * 100).toFixed(2)),
    source: "commission_table_fbo",
    matched_type_name: match.rule.type_name,
    matched_category_name: match.rule.category_name,
    score: match.score
  };
}

module.exports = { calculateFboCommission };
