const { query } = require("./db");
const pricingStrategy = require("./pricing_strategy");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 1) => Number(number(value).toFixed(digits));

function parseCompetitors(text = "") {
  return String(text).split(/(?=\b\d{8,12}\b)|[；;\n]+/).map((segment) => {
    const sku = segment.match(/\b(\d{8,12})\b/)?.[1];
    if (!sku) return null;
    const price = segment.match(/售价\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1];
    const sales = segment.match(/月销\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1];
    const adShare = segment.match(/广告\s*[:：]?\s*(\d+(?:\.\d+)?)/)?.[1];
    return {
      sku,
      price: price === undefined ? null : Number(price),
      sales30: sales === undefined ? null : Number(sales),
      adShare: adShare === undefined ? null : Number(adShare),
      stockout: /断货|缺货/.test(segment),
      comparable: !/尺寸不一样|规格不一样|不同尺寸|不同规格|非同款/.test(segment),
      marketType: /本土/.test(segment) ? "本土" : /跨境/.test(segment) ? "跨境" : null,
      note: segment.trim(),
    };
  }).filter(Boolean);
}

function recommend(row, pricing, monitorBySku = new Map()) {
  let monitorCount = 0;
  let latestMonitorAt = 0;
  const competitors = parseCompetitors(row.competitor_compare).map((item) => {
    const snapshot = monitorBySku.get(item.sku);
    if (!snapshot) return item;
    monitorCount += 1;
    const fetchedAt = snapshot.fetched_at ? new Date(snapshot.fetched_at).getTime() : 0;
    latestMonitorAt = Math.max(latestMonitorAt, fetchedAt);
    return {
      ...item,
      price: snapshot.price === null ? item.price : Number(snapshot.price),
      sales30: snapshot.sales_30d === null ? item.sales30 : Number(snapshot.sales_30d),
      revenue30: snapshot.revenue_30d === null ? null : Number(snapshot.revenue_30d),
      stock: snapshot.stock === null ? null : Number(snapshot.stock),
      rating: snapshot.rating === null ? null : Number(snapshot.rating),
      reviewCount: snapshot.review_count === null ? null : Number(snapshot.review_count),
      monitorFetchedAt: snapshot.fetched_at,
      dataSource: "seerfar_package_monitor"
    };
  });
  const priced = competitors.filter((item) => item.price && item.comparable);
  const active = priced.filter((item) => !item.stockout);
  const localActive = active.filter((item) => item.marketType === "本土");
  const localPriced = priced.filter((item) => item.marketType === "本土");
  const benchmark = localActive.length ? localActive : localPriced.length ? localPriced : active.length ? active : priced;
  const benchmarkMarketType = localActive.length || localPriced.length ? "本土" : benchmark.length ? "其他/未标记" : "无";
  const averagePrice = benchmark.length ? benchmark.reduce((sum, item) => sum + item.price, 0) / benchmark.length : null;
  const lowestPrice = benchmark.length ? Math.min(...benchmark.map((item) => item.price)) : null;
  const strongest = [...competitors].sort((a, b) => number(b.sales30) - number(a.sales30))[0] || null;
  const currentPrice = number(row.front_price);
  const sales7 = number(pricing?.sales7);
  const stock = number(pricing?.stock);
  const sourceTime = latestMonitorAt || new Date(row.updated_at).getTime();
  const ageDays = Math.max(0, (Date.now() - sourceTime) / 86400000);
  const populated = (field) => competitors.filter((item) => item[field] !== null).length;
  const qualityScore = Math.min(100,
    (competitors.length ? 20 : 0) + (priced.length ? 25 : 0) + (populated("sales30") ? 15 : 0)
    + (populated("adShare") ? 10 : 0) + (ageDays <= 14 ? 15 : 0) + (competitors.length >= 2 ? 10 : 0)
    + (competitors.every((item) => item.comparable) ? 5 : 0));
  const stockoutShare = competitors.length ? competitors.filter((item) => item.stockout).length / competitors.length : 0;
  let action = "hold";
  let reason = "当前价格处于竞品区间，先保持并继续观察销量。";
  let priority = "medium";

  if (!currentPrice) {
    action = "refresh_own_price"; reason = "缺少我方Ozon前台营销价，禁止使用后台卖家标价与竞品比较。"; priority = "high";
  } else if (!competitors.length) {
    action = "needs_mapping"; reason = "尚未填写可识别的竞品SKU，需要先绑定1—3个直接竞品。"; priority = "low";
  } else if (ageDays > 14) {
    action = "refresh_data"; reason = `竞品数据已超过${Math.floor(ageDays)}天，刷新后再决策。`;
  } else if (!benchmark.length) {
    action = competitors.some((item) => !item.comparable) ? "verify_match" : "refresh_data";
    reason = action === "verify_match" ? "现有竞品标注了不同尺寸或规格，确认同款后再比较价格。" : "竞品缺少有效售价，暂不生成价格动作。";
  } else if (stockoutShare >= 0.5 && stock > 0 && sales7 > 0 && pricing && !pricing.blocked) {
    action = "raise_opportunity"; reason = "至少一半竞品缺货且我方有销量和库存，可测试小幅提价。"; priority = qualityScore >= 70 ? "high" : "medium";
  } else if (currentPrice < lowestPrice * 0.9 && pricing && !pricing.blocked) {
    action = "raise_opportunity"; reason = "我方价格显著低于有效竞品，存在回收利润的提价空间。"; priority = qualityScore >= 70 ? "high" : "medium";
  } else if (currentPrice > averagePrice * 1.08) {
    action = pricing?.profitZone === "safe" ? "review_price" : "optimize_content";
    reason = action === "review_price" ? "我方价格高于竞品均价8%以上，且成本利润率在安全区，可测试价格回撤。" : "成本利润率未进入安全区，不跟随降价，优先优化主图、卖点和成本。";
    priority = qualityScore >= 70 && action === "review_price" ? "high" : "medium";
  } else if (strongest && number(strongest.sales30) >= Math.max(100, sales7 * 4) && number(strongest.adShare) > 0) {
    action = "strengthen_ads"; reason = "头部竞品月销和广告投入明显，建议先检查流量并测试广告，而非直接降价。";
  } else if (sales7 === 0 && stock > 0) {
    action = "optimize_content"; reason = "我方有库存但近7天无销量，优先诊断主图、标题和关键词。";
  }

  return {
    offerId: row.offer_id, sku: String(row.ozon_sku || ""), title: row.title || "", imageUrl: row.image_url || "",
    currentPrice: round(currentPrice), currentProfitCny: pricing?.currentProfitCny ?? null,
    currentCostProfitRatio: pricing?.currentCostProfitRatio ?? null, profitZone: pricing?.profitZone || "unknown",
    priceSource: row.front_price_source || "missing", frontPriceUpdatedAt: row.front_price_updated_at || null,
    sales7, stock, competitors, competitorCount: competitors.length,
    averageCompetitorPrice: averagePrice === null ? null : round(averagePrice), lowestCompetitorPrice: lowestPrice,
    benchmarkMarketType, localCompetitorCount: competitors.filter((item) => item.marketType === "本土").length,
    priceGapPct: averagePrice ? round((currentPrice / averagePrice - 1) * 100) : null,
    strongestCompetitor: strongest, action, reason, priority, qualityScore,
    reliableForPrice: currentPrice > 0 && qualityScore >= 70 && benchmark.length > 0 && ageDays <= 14,
    sourceUpdatedAt: new Date(sourceTime), sourceAgeDays: round(ageDays),
    source: monitorCount ? "Seerfar套餐监控 + 俄罗斯看板匹配" : "俄罗斯看板人工竞品资料",
    monitorCount,
  };
}

async function strategies() {
  const [productsResult, pricing, monitorResult] = await Promise.all([
    query(`SELECT offer_id, ozon_sku, title, image_url, price, front_price, front_price_source, front_price_updated_at, competitor_compare, updated_at
      FROM products WHERE COALESCE(hidden, false) = false ORDER BY updated_at DESC`),
    pricingStrategy.recommendations(),
    query(`SELECT sku, price, sales_30d, revenue_30d, stock, rating, review_count, fetched_at
      FROM seerfar_competitors WHERE platform='OZON' AND source='seerfar_monitor'`).catch(() => ({ rows: [] })),
  ]);
  const pricingByOffer = new Map(pricing.rows.map((row) => [row.offerId, row]));
  const monitorBySku = new Map(monitorResult.rows.map((row) => [String(row.sku), row]));
  const rows = productsResult.rows.map((row) => recommend(row, pricingByOffer.get(row.offer_id), monitorBySku));
  return {
    generatedAt: new Date().toISOString(), mode: "advisory", platformWrite: false,
    source: { name: "俄罗斯看板人工竞品资料", automated: false, freshnessWarningDays: 14 }, rows,
    summary: {
      products: rows.length,
      covered: rows.filter((row) => row.competitorCount > 0).length,
      fresh: rows.filter((row) => row.competitorCount > 0 && row.sourceAgeDays <= 14).length,
      highPriority: rows.filter((row) => row.priority === "high").length,
      mediumPriority: rows.filter((row) => row.priority === "medium").length,
      lowPriority: rows.filter((row) => row.priority === "low").length,
      reliableForPrice: rows.filter((row) => row.reliableForPrice).length,
      monitorCoveredProducts: rows.filter((row) => row.monitorCount > 0).length,
      monitorMatchedSkus: new Set(rows.flatMap((row) => row.competitors.filter((item) => item.dataSource === "seerfar_package_monitor").map((item) => item.sku))).size,
      blockedByQuality: rows.filter((row) => ["needs_mapping", "refresh_data", "refresh_own_price", "verify_match"].includes(row.action)).length,
      priceActions: rows.filter((row) => ["raise_opportunity", "review_price"].includes(row.action)).length,
      advertisingActions: rows.filter((row) => row.action === "strengthen_ads").length,
      contentActions: rows.filter((row) => row.action === "optimize_content").length,
    },
  };
}

module.exports = { parseCompetitors, recommend, strategies };

