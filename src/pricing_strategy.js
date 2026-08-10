const { query } = require("./db");
const { getRubRate } = require("./exchange");
const { landedUnitCost, readSettings } = require("./daily_profit");
const actualCosts = require("./actual_costs");
const inventory = require("./inventory");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const DEFAULT_RULES = {
  dangerCostProfitRatio: 0.5,
  safeCostProfitRatio: 0.8,
  priceTestRate: 0.03,
  maxChangeRate: 0.03,
  observationDays: 3,
  maxObservationDays: 5,
  salesDropTolerance: 0.25,
  markdownRate: 0.02,
};

function normalizeRules(input = {}) {
  return {
    dangerCostProfitRatio: DEFAULT_RULES.dangerCostProfitRatio,
    safeCostProfitRatio: DEFAULT_RULES.safeCostProfitRatio,
    priceTestRate: clamp(number(input.priceTestRate ?? DEFAULT_RULES.priceTestRate), 0.01, 0.05),
    maxChangeRate: clamp(number(input.maxChangeRate ?? DEFAULT_RULES.maxChangeRate), 0.001, 0.2),
    observationDays: DEFAULT_RULES.observationDays,
    maxObservationDays: DEFAULT_RULES.maxObservationDays,
    salesDropTolerance: DEFAULT_RULES.salesDropTolerance,
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
  const purchaseCostCny = number(product.purchase_cost);
  const costProfitRatio = purchaseCostCny > 0 ? profitCny / purchaseCostCny : null;
  return { priceRub, landedCny, purchaseCostCny, netRate, profitCny, margin, costProfitRatio };
}

function competitorContext(product) {
  const ownFrontPrice = number(product.front_price);
  const competitors = String(product.competitor_compare || "").split(/(?=\b\d{8,12}\b)|[；;\n]+/).map((segment) => {
    const price = segment.match(/售价\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1];
    const sales = segment.match(/月销\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1];
    return {
      price: price === undefined ? null : Number(price),
      sales30: sales === undefined ? null : Number(sales),
      stockout: /断货|缺货/.test(segment),
      crossBorder: /跨境/.test(segment),
      comparable: !/尺寸不一样|规格不一样|不同尺寸|不同规格|非同款/.test(segment),
    };
  }).filter((item) => item.price !== null);
  const active = competitors.filter((item) => item.comparable && !item.stockout && !item.crossBorder && (item.sales30 === null || item.sales30 > 0));
  const effective = active.filter((item) => !ownFrontPrice || item.price <= ownFrontPrice * 1.3);
  const prices = effective.map((item) => item.price);
  return {
    ownFrontPrice,
    competitorCount: competitors.length,
    effectiveCompetitorCount: effective.length,
    noEffectiveCompetitor: effective.length === 0,
    averagePrice: prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : null,
    lowestPrice: prices.length ? Math.min(...prices) : null,
  };
}

function profitZone(ratio, rules) {
  if (ratio === null) return "unknown";
  if (ratio < rules.dangerCostProfitRatio) return "danger";
  if (ratio < rules.safeCostProfitRatio) return "warning";
  return "safe";
}

function recommendPrice(product, metrics, rates, settings, ruleInput = {}, actual = {}) {
  const rules = normalizeRules(ruleInput);
  const economics = unitEconomics(product, rates, settings, rules, actual);
  const fboFbsStock = number(product.fbo_stock) + number(product.fbs_stock);
  const unallocatedStock = number(product.unallocated_stock);
  const stock = fboFbsStock + unallocatedStock;
  const sales3 = number(metrics.sales_3d);
  const previous3 = number(metrics.sales_prev_3d);
  const sales5 = number(metrics.sales_5d);
  const sales7 = number(metrics.sales_7d);
  const previous7 = number(metrics.sales_prev_7d);
  const dailySales = sales7 / 7;
  const stockDays = dailySales > 0 ? stock / dailySales : null;
  const trend = previous7 > 0 ? (sales7 - previous7) / previous7 : (sales7 > 0 ? 1 : 0);
  const trend3 = previous3 > 0 ? (sales3 - previous3) / previous3 : (sales3 > 0 ? 1 : 0);
  const marketAccepted = sales3 > 0 && (previous3 === 0 || trend3 >= -rules.salesDropTolerance);
  const lowSample = sales3 < 3;
  const competitors = competitorContext(product);
  const zone = profitZone(economics.costProfitRatio, rules);
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
  } else if (sales3 === 0) {
    reason = sales5 === 0
      ? "近3天无订单，延长观察但最多5天；暂不自动调价"
      : "近3天无订单但5天内有成交，样本不足，保持价格观察";
  } else if (marketAccepted && competitors.noEffectiveCompetitor) {
    action = "raise";
    desiredPrice = economics.priceRub * (1 + rules.priceTestRate);
    reason = zone === "safe"
      ? "暂无有效竞品且市场接受当前价格，继续试探更高利润；观察3天，最多5天"
      : `${zone === "danger" ? "危险" : "警惕"}利润区，暂无有效竞品且市场接受价格，小幅提价测试`;
  } else if (marketAccepted && competitors.lowestPrice && competitors.ownFrontPrice > 0
    && competitors.ownFrontPrice < competitors.lowestPrice * 0.9) {
    action = "raise";
    desiredPrice = economics.priceRub * 1.02;
    reason = "我方前台价明显低于有效竞品且近3天市场接受，可小幅提价回收利润";
  } else if (trend3 < -rules.salesDropTolerance && competitors.averagePrice
    && competitors.ownFrontPrice > competitors.averagePrice * 1.08 && zone === "safe") {
    action = "lower";
    desiredPrice = economics.priceRub * (1 - rules.markdownRate);
    reason = `近3天销量下降${Math.abs(round(trend3 * 100, 1))}%且前台价高于有效竞品，回撤一档测试`;
  } else if (zone === "danger") {
    reason = "成本利润率低于50%危险线；竞品或销量暂不支持提价，优先复核成本、费用和广告";
  } else if (zone === "warning") {
    reason = "成本利润率处于50%—80%警惕区；等待销量或竞品给出明确提价信号";
  } else if (lowSample) {
    reason = "成本利润率在安全区，但近3天样本较少；最多观察5天后再判断";
  } else {
    reason = "成本利润率在安全区，当前竞品和销售表现暂不支持调整";
  }

  const lowerBound = economics.priceRub * (1 - rules.maxChangeRate);
  const upperBound = economics.priceRub * (1 + rules.maxChangeRate);
  const suggestedPrice = blocked ? economics.priceRub : Math.round(clamp(desiredPrice, lowerBound, upperBound));
  const suggestedEconomics = unitEconomics({ ...product, price: suggestedPrice }, rates, settings, rules, actual);
  if (action === "lower" && suggestedPrice >= economics.priceRub) {
    action = "hold";
    reason = "降价未形成有效价格变化，保持当前售价";
  }

  return {
    offerId: product.offer_id,
    productId: String(product.product_id || ""),
    sku: String(product.ozon_sku || ""),
    title: product.title || "",
    imageUrl: product.image_url || "",
    operator: product.operator_name || "",
    stock: round(stock), fboFbsStock: round(fboFbsStock), unallocatedStock: round(unallocatedStock),
    totalAvailableStock: round(stock), sales3: round(sales3), previous3: round(previous3), sales5: round(sales5),
    sales7: round(sales7), previous7: round(previous7),
    stockDays: stockDays === null ? null : round(stockDays, 1), trend: round(trend * 100, 1), trend3: round(trend3 * 100, 1),
    currentPrice: round(economics.priceRub), suggestedPrice: round(suggestedPrice), minimumPrice: null,
    currentProfitCny: round(economics.profitCny), suggestedProfitCny: round(suggestedEconomics.profitCny),
    currentMargin: economics.margin === null ? null : round(economics.margin * 100, 1),
    suggestedMargin: suggestedEconomics.margin === null ? null : round(suggestedEconomics.margin * 100, 1),
    currentCostProfitRatio: economics.costProfitRatio === null ? null : round(economics.costProfitRatio * 100, 1),
    suggestedCostProfitRatio: suggestedEconomics.costProfitRatio === null ? null : round(suggestedEconomics.costProfitRatio * 100, 1),
    financialInputs: {
      purchaseCostCny: round(economics.purchaseCostCny), landedCny: round(economics.landedCny),
      netRate: economics.netRate, rubToCny: number(rates.rubToCny),
    },
    profitZone: zone, marketAccepted, lowSample, observationDays: rules.observationDays,
    maxObservationDays: rules.maxObservationDays, competitorContext: competitors,
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
  const [result, rates, actualSnapshot, unallocatedSnapshot] = await Promise.all([
    query(`
      SELECT p.*,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 2), 0) AS sales_3d,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date BETWEEN (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 5 AND (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 3), 0) AS sales_prev_3d,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 4), 0) AS sales_5d,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 6), 0) AS sales_7d,
        COALESCE(SUM(m.sales_units) FILTER (WHERE m.metric_date BETWEEN (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13 AND (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 7), 0) AS sales_prev_7d
      FROM products p
      LEFT JOIN product_daily_metrics m ON m.offer_id = p.offer_id
        AND m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13
      WHERE COALESCE(p.hidden, false) = false
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `),
    getRubRate(), actualCosts.snapshot(), inventory.listUnallocatedAssignments(),
  ]);
  const settings = readSettings();
  const actualByOffer = new Map(actualSnapshot.rows.map((row) => [row.offerId, row]));
  const rows = result.rows.map((product) => {
    const unallocated = unallocatedSnapshot.byOffer.get(String(product.offer_id)) || { pieces: 0, boxes: 0 };
    const enriched = { ...product, unallocated_stock: Number(unallocated.pieces || 0), unallocated_boxes: Number(unallocated.boxes || 0) };
    return recommendPrice(enriched, enriched, rates, settings, rules, actualByOffer.get(product.offer_id) || {});
  });
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

