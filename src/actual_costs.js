const fs = require("fs");
const { query } = require("./db");

const MANIFEST_PATH = "/var/www/ozon-dashboard/russia-unit-economics-months.json";
const DATA_DIR = "/var/www/ozon-dashboard";
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value, digits = 2) => Number(number(value).toFixed(digits));
const rate = (cost, sales) => sales > 0 ? Math.abs(cost) / sales * 100 : null;

function rowActualRates(row) {
  const salesRub = ["revenue", "discountPoints", "partnerPrograms"].reduce((sum, key) => sum + number(row[key]), 0);
  const logisticsRub = ["shipmentProcessing", "logistics", "lastMile", "storage"].reduce((sum, key) => sum + number(row[key]), 0);
  const returnsRub = ["returnProcessing", "reverseLogistics"].reduce((sum, key) => sum + number(row[key]), 0);
  const additionalRub = ["disposal", "oversizeProcessing", "operationalErrors"].reduce((sum, key) => sum + number(row[key]), 0);
  return {
    sku: String(row.sku || ""), offerId: row.offerId || "", salesRub: round(salesRub),
    delivered: round(row.delivered),
    actualCommissionRate: rate(number(row.ozonCommission), salesRub),
    actualAcquiringRate: rate(number(row.acquiring), salesRub),
    actualLogisticsRate: rate(logisticsRub, salesRub),
    actualReturnCostRate: rate(returnsRub, salesRub),
    actualAdditionalServiceRate: rate(additionalRub, salesRub),
  };
}

function loadLatestEconomics() {
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    const months = [...(manifest.months || [])].sort((a, b) => String(a.month).localeCompare(String(b.month)));
    const latest = months[months.length - 1];
    if (!latest) return { month: null, generatedAt: null, rows: [], warning: "没有可用的Ozon单品经济数据" };
    const data = JSON.parse(fs.readFileSync(`${DATA_DIR}/${latest.file}`, "utf8"));
    return {
      month: latest.month, generatedAt: data.generatedAt || manifest.generatedAt || null,
      costMergedAt: data.costMergedAt || null, rows: (data.rows || []).map(rowActualRates), warning: null,
    };
  } catch (error) {
    return { month: null, generatedAt: null, rows: [], warning: `读取实际结算费用失败：${error.message}` };
  }
}

function combineRow(product, monthly) {
  const revenue14 = number(product.revenue_14d);
  const revenue30 = number(product.revenue_30d);
  const adCoverage14 = number(product.ad_days_14d);
  const adCoverage30 = number(product.ad_days_30d);
  const adRate14 = adCoverage14 > 0 && revenue14 > 0 ? number(product.ad_spend_14d) / revenue14 * 100 : null;
  const adRate30 = adCoverage30 > 0 && revenue30 > 0 ? number(product.ad_spend_30d) / revenue30 * 100 : null;
  return {
    offerId: product.offer_id, sku: String(product.ozon_sku || ""), title: product.title || "", imageUrl: product.image_url || "",
    apiCommissionRate: product.commission_rate === null ? null : round(product.commission_rate, 3),
    adCostRate14: adRate14 === null ? null : round(adRate14, 3),
    adCostRate30: adRate30 === null ? null : round(adRate30, 3),
    adSpend14Rub: round(product.ad_spend_14d), revenue14Rub: round(revenue14), adDays14: round(adCoverage14),
    actualCommissionRate: monthly?.actualCommissionRate === null || monthly?.actualCommissionRate === undefined ? null : round(monthly.actualCommissionRate, 3),
    actualAcquiringRate: monthly?.actualAcquiringRate === null || monthly?.actualAcquiringRate === undefined ? null : round(monthly.actualAcquiringRate, 3),
    actualLogisticsRate: monthly?.actualLogisticsRate === null || monthly?.actualLogisticsRate === undefined ? null : round(monthly.actualLogisticsRate, 3),
    actualReturnCostRate: monthly?.actualReturnCostRate === null || monthly?.actualReturnCostRate === undefined ? null : round(monthly.actualReturnCostRate, 3),
    actualAdditionalServiceRate: monthly?.actualAdditionalServiceRate === null || monthly?.actualAdditionalServiceRate === undefined ? null : round(monthly.actualAdditionalServiceRate, 3),
    deliveredInSettlementMonth: monthly?.delivered ?? null,
    sources: {
      commission: product.commission_rate === null ? "missing" : "Ozon商品API",
      advertising: adRate14 === null ? "missing" : "Ozon Performance API / 近14天广告消耗占总销售额",
      settlementFees: monthly ? "Ozon单品经济实际结算" : "missing",
    },
  };
}

async function snapshot() {
  const monthly = loadLatestEconomics();
  const monthlyBySku = new Map(monthly.rows.filter((row) => row.sku).map((row) => [row.sku, row]));
  const result = await query(`
    SELECT p.offer_id, p.ozon_sku, p.title, p.image_url, p.commission_rate,
      COALESCE(SUM(m.ad_spend) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13), 0) AS ad_spend_14d,
      COALESCE(SUM(m.revenue) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13), 0) AS revenue_14d,
      COUNT(m.ad_spend) FILTER (WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 13) AS ad_days_14d,
      COALESCE(SUM(m.ad_spend), 0) AS ad_spend_30d,
      COALESCE(SUM(m.revenue), 0) AS revenue_30d,
      COUNT(m.ad_spend) AS ad_days_30d
    FROM products p
    LEFT JOIN product_daily_metrics m ON m.offer_id=p.offer_id
      AND m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - 29
    WHERE COALESCE(p.hidden, false)=false
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `);
  const rows = result.rows.map((product) => combineRow(product, monthlyBySku.get(String(product.ozon_sku || ""))));
  return {
    generatedAt: new Date().toISOString(), settlementMonth: monthly.month,
    settlementGeneratedAt: monthly.generatedAt, settlementCostMergedAt: monthly.costMergedAt,
    warning: monthly.warning, rows,
    summary: {
      products: rows.length,
      commissionApiCoverage: rows.filter((row) => row.apiCommissionRate !== null).length,
      advertisingCoverage: rows.filter((row) => row.adCostRate14 !== null).length,
      settlementCoverage: rows.filter((row) => row.actualLogisticsRate !== null).length,
    },
  };
}

module.exports = { rowActualRates, loadLatestEconomics, combineRow, snapshot };
