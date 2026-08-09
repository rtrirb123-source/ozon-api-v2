const { query } = require("./db");
const { getRubRate } = require("./exchange");
const { landedUnitCost, readSettings } = require("./daily_profit");
const actualCosts = require("./actual_costs");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const DEFAULT_RULES = {
  targetMargin: 0.18,
  minimumMargin: 0.08,
  minimumProfitCny: 5,
  maxChangeRate: 0.05,
  lowStockDays: 14,
  markdownRate: 0.03,
};

function normalizeRules(input = {}) {
  return {
    targetMargin: clamp(number(input.targetMargin ?? DEFAULT_RULES.targetMargin), 0, 0.8),
    minimumMargin: clamp(number(input.minimumMargin ?? DEFAULT_RULES.minimumMargin), 0, 0.8),
    minimumProfitCny: clamp(number(input.minimumProfitCny ?? DEFAULT_RULES.minimumProfitCny), 0, 10000),
    maxChangeRate: clamp(number(input.maxChangeRate ?? DEFAULT_RULES.maxChangeRate), 0.001, 0.2),
    lowStockDays: clamp(number(input.lowStockDays ?? DEFAULT_RULES.lowStockDays), 1, 180),
    markdownRate: clamp(number(input.markdownRate ?? DEFAULT_RULES.markdownRate), 0.001, 0.1),
  };
}

function unitEconomics(product, rates, settings, rules, actual = {}) {
  const priceRub = number(product.price);
  const landedCny = landedUnitCost(product, rates, settings);
  const adRate = actual.adCostRate14 ?? product.ad_ratio;
  const returnCostRate = actual.actualReturnCostRate ?? product.return_rate;
  const logisticsRate = actual.actualLogisticsRate ?? product.tail_delivery_rate ?? 10;
  const additionalRate = actual.actualAdditionalServiceRate ?? 0;
  const acquiringRate = actual.actualAcquiringRate ?? 0;
  const feeRate = (
    number(product.commission_rate) + number(adRate) + number(returnCostRate)
    + number(logisticsRate) + number(additionalRate) + number(acquiringRate)
  ) / 100 + settings.taxRate;
  const netRate = Math.max(0, 1 - feeRate) * (1 - settings.withdrawalRate);
  const revenueCny = priceRub * number(rates.rubToCny);
  const profitCny = priceRub * netRate * number(rates.rubToCny) - landedCny;
  const margin = revenueCny > 0 ? profitCny / revenueCny : null;
  const targetDenominator = number(rates.rubToCny) * (netRate - rules.targetMargin);
  const targetPrice = targetDenominator > 0 ? landedCny / targetDenominator : Infinity;
  const profitFloorPrice = netRate > 0
    ? (landedCny + rules.minimumProfitCny) / (number(rates.rubToCny) * netRate)
    : Infinity;
  const minimumPrice = Math.ceil(Math.max(targetPrice, profitFloorPrice));
  return { priceRub, landedCny, netRate, profitCny, margin, minimumPrice };
}

function recommendPrice(product, metrics, rates, settings, ruleInput = {}, actual = {}) {
  const rules = normalizeRules(ruleInput);
  const economics = unitEconomics(product, rates, settings, rules, actual);
  const stock = number(product.fbo_stock) + number(product.fbs_stock);
  const sales7 = number(metrics.sales_7d);
  const previous7 = number(metrics.sales_prev_7d);
  const dailySales = sales7 / 7;
  const stockDays = dailySales > 0 ? stock / dailySales : null;
  const trend = previous7 > 0 ? (sales7 - previous7) / previous7 : (sales7 > 0 ? 1 : 0);
  const missing = [];
  if (!economics.priceRub) missing.push("当前售价");
  if (!number(product.purchase_cost)) missing.push("采购成本");
  if (!number(product.weight)) missing.push("重量");
  if (!number(product.commission_rate)) missing.push("佣金率");

  let action = "hold";
  let reason = "销量和利润暂时稳定";
  let desiredPrice = economics.priceRub;
  let blocked = false;

  if (missing.length) {
    blocked = true;
    reason = `缺少${missing.join("、")}，禁止自动调价`;
  } else if (stock <= 0) {
    blocked = true;
    reason = "库存为0，暂停调价";
  } else if (!Number.isFinite(economics.minimumPrice)) {
    blocked = true;
    reason = "当前费用率无法达到目标利润，禁止自动调价";
  } else if (economics.margin < rules.minimumMargin || economics.priceRub < economics.minimumPrice) {
    action = "raise";
    desiredPrice = Math.max(economics.minimumPrice, economics.priceRub * 1.02);
    reason = "当前利润低于安全线，需要提价保护利润";
  } else if (stockDays !== null && stockDays < rules.lowStockDays) {
    action = "raise";
    desiredPrice = economics.priceRub * 1.02;
    reason = `预计库存仅可售${round(stockDays, 1)}天，提价降低缺货风险`;
  } else if (sales7 === 0 && stock > 0) {
    action = "lower";
    desiredPrice = Math.max(economics.minimumPrice, economics.priceRub * (1 - rules.markdownRate));
    reason = "近7天无销量，建议小幅降价测试转化";
  } else if (trend <= -0.2 && economics.margin >= rules.targetMargin + 0.05) {
    action = "lower";
    desiredPrice = Math.max(economics.minimumPrice, economics.priceRub * (1 - Math.min(rules.markdownRate, 0.02)));
    reason = `近7天销量下降${Math.abs(round(trend * 100, 1))}%，且利润空间充足`;
  } else if (trend >= 0.2 && economics.margin < rules.targetMargin + 0.03) {
    action = "raise";
    desiredPrice = economics.priceRub * 1.02;
    reason = `近7天销量增长${round(trend * 100, 1)}%，可小幅提价改善利润`;
  }

  const lowerBound = economics.priceRub * (1 - rules.maxChangeRate);
  const upperBound = economics.priceRub * (1 + rules.maxChangeRate);
  const suggestedPrice = blocked ? economics.priceRub : Math.round(clamp(desiredPrice, lowerBound, upperBound));
  const suggestedEconomics = unitEconomics({ ...product, price: suggestedPrice }, rates, settings, rules, actual);
  if (action === "lower" && suggestedPrice >= economics.priceRub) {
    action = "hold";
    reason = "降价会突破最低利润价格，保持当前售价";
  }

  return {
    offerId: product.offer_id,
    productId: String(product.product_id || ""),
    sku: String(product.ozon_sku || ""),
    title: product.title || "",
    imageUrl: product.image_url || "",
    operator: product.operator_name || "",
    stock: round(stock), sales7: round(sales7), previous7: round(previous7),
    stockDays: stockDays === null ? null : round(stockDays, 1), trend: round(trend * 100, 1),
    currentPrice: round(economics.priceRub), suggestedPrice: round(suggestedPrice), minimumPrice: economics.minimumPrice,
    currentProfitCny: round(economics.profitCny), suggestedProfitCny: round(suggestedEconomics.profitCny),
    currentMargin: economics.margin === null ? null : round(economics.margin * 100, 1),
    suggestedMargin: suggestedEconomics.margin === null ? null : round(suggestedEconomics.margin * 100, 1),
    action, reason, blocked,
    dataBasis: {
      commission: actual.sources?.commission || "商品设置",
      advertising: actual.sources?.advertising || "商品设置",
      settlementFees: actual.sources?.settlementFees || "商品设置",
    },
  };
}

async function recommendations(ruleInput = {}) {
  const rules = normalizeRules(ruleInput);
  const [result, rates, actualSnapshot] = await Promise.all([
    query(`
      SELECT p.*,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 6), 0) AS sales_7d,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date BETWEEN (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13 AND (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 7), 0) AS sales_prev_7d
      FROM products p
      LEFT JOIN product_daily_metrics m ON m.offer_id = p.offer_id
        AND m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13
      WHERE COALESCE(p.hidden, false) = false
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `),
    getRubRate(), actualCosts.snapshot(),
  ]);
  const settings = readSettings();
  const actualByOffer = new Map(actualSnapshot.rows.map((row) => [row.offerId, row]));
  const rows = result.rows.map((product) => recommendPrice(product, product, rates, settings, rules, actualByOffer.get(product.offer_id) || {}));
  return {
    generatedAt: new Date().toISOString(), mode: "advisory", platformWrite: false,
    rules, parameters: { ...settings, rubToCny: rates.rubToCny, usdToCny: rates.usdToCny },
    actualCostStatus: { settlementMonth: actualSnapshot.settlementMonth, summary: actualSnapshot.summary, warning: actualSnapshot.warning }, rows,
    summary: {
      products: rows.length,
      raise: rows.filter((row) => row.action === "raise" && !row.blocked).length,
      lower: rows.filter((row) => row.action === "lower" && !row.blocked).length,
      hold: rows.filter((row) => row.action === "hold" && !row.blocked).length,
      blocked: rows.filter((row) => row.blocked).length,
    },
  };
}

module.exports = { DEFAULT_RULES, normalizeRules, unitEconomics, recommendPrice, recommendations };

