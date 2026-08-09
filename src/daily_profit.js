const fs = require("fs");
const { query } = require("./db");
const { getRubRate } = require("./exchange");

const SETTINGS_PATH = "/var/www/ozon-dashboard/russia-operations-settings.json";
const DEFAULT_SETTINGS = { taxRate: 0.13, withdrawalRate: 0.03, logisticsFactorUsdKg: 3 };

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value) => Number(number(value).toFixed(2));
const dateOnly = (value) => String(value || "").slice(0, 10);
const beijingDateOffset = (days = 0) => {
  const value = new Date(Date.now() + 8 * 3600000 + days * 86400000);
  return value.toISOString().slice(0, 10);
};

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function readSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return {
      taxRate: number(saved.taxRate ?? DEFAULT_SETTINGS.taxRate),
      withdrawalRate: number(saved.withdrawalRate ?? DEFAULT_SETTINGS.withdrawalRate),
      logisticsFactorUsdKg: number(saved.logisticsFactorUsdKg ?? DEFAULT_SETTINGS.logisticsFactorUsdKg),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function landedUnitCost(product, rates, settings) {
  const purchaseCost = number(product.purchase_cost);
  const weightKg = number(product.weight) / 1000;
  const freightRate = number(product.freight_rate) || settings.logisticsFactorUsdKg;
  return purchaseCost + weightKg * freightRate * number(rates.usdToCny);
}

function calculateEstimatedRow(metric, product, rates, settings) {
  const units = number(metric.sales_units);
  const revenueRub = number(metric.revenue);
  const commissionRub = revenueRub * number(product.commission_rate) / 100;
  const adRub = number(metric.ad_spend);
  const returnRub = revenueRub * number(product.return_rate) / 100;
  const tailRate = product.tail_delivery_rate === null || product.tail_delivery_rate === undefined
    ? 10 : number(product.tail_delivery_rate);
  const tailRub = revenueRub * tailRate / 100;
  const taxRub = revenueRub * settings.taxRate;
  const beforeWithdrawalRub = revenueRub - commissionRub - adRub - returnRub - tailRub - taxRub;
  const withdrawalRub = Math.max(0, beforeWithdrawalRub) * settings.withdrawalRate;
  const platformCostRub = commissionRub + adRub + returnRub + tailRub + taxRub + withdrawalRub;
  const landedCostCny = landedUnitCost(product, rates, settings) * units;
  const profitCny = (revenueRub - platformCostRub) * number(rates.rubToCny) - landedCostCny;
  return {
    metricDate: dateOnly(metric.metric_date),
    offerId: product.offer_id,
    sku: String(product.ozon_sku || ""),
    title: product.title || "",
    imageUrl: product.image_url || "",
    units: round(units),
    revenueRub: round(revenueRub),
    adSpendRub: round(adRub),
    platformCostRub: round(platformCostRub),
    landedCostCny: round(landedCostCny),
    estimatedProfitCny: round(profitCny),
    estimatedMargin: revenueRub > 0 ? round(profitCny / (revenueRub * number(rates.rubToCny)) * 100) : null,
  };
}

function aggregateConfirmedOperations(operations, productsBySku, rates) {
  const byKey = new Map();
  let unallocatedRub = 0;
  for (const operation of operations || []) {
    const items = (operation.items || []).filter((item) => String(item.sku || ""));
    const totalQuantity = items.reduce((sum, item) => sum + Math.max(number(item.quantity), 0), 0);
    if (!items.length || totalQuantity <= 0) {
      unallocatedRub += number(operation.amount);
      continue;
    }
    for (const item of items) {
      const sku = String(item.sku);
      const product = productsBySku.get(sku);
      if (!product) {
        unallocatedRub += number(operation.amount) * number(item.quantity) / totalQuantity;
        continue;
      }
      const day = dateOnly(operation.operation_date);
      const key = `${day}\u0000${product.offer_id}`;
      const row = byKey.get(key) || {
        metricDate: day, offerId: product.offer_id, sku,
        title: product.title || "", imageUrl: product.image_url || "",
        confirmedNetRub: 0, confirmedOperations: 0,
      };
      row.confirmedNetRub += number(operation.amount) * number(item.quantity) / totalQuantity;
      row.confirmedOperations += 1;
      byKey.set(key, row);
    }
  }
  for (const row of byKey.values()) {
    row.confirmedNetRub = round(row.confirmedNetRub);
    row.confirmedNetCny = round(row.confirmedNetRub * number(rates.rubToCny));
  }
  return { rows: byKey, unallocatedRub: round(unallocatedRub) };
}

function mergeRows(estimatedRows, confirmed) {
  const used = new Set();
  const rows = estimatedRows.map((row) => {
    const key = `${row.metricDate}\u0000${row.offerId}`;
    used.add(key);
    const financial = confirmed.rows.get(key);
    return {
      ...row,
      confirmedNetRub: financial?.confirmedNetRub ?? null,
      confirmedNetCny: financial?.confirmedNetCny ?? null,
      confirmedOperations: financial?.confirmedOperations || 0,
    };
  });
  for (const [key, financial] of confirmed.rows) {
    if (used.has(key)) continue;
    rows.push({
      metricDate: financial.metricDate, offerId: financial.offerId, sku: financial.sku,
      title: financial.title, imageUrl: financial.imageUrl, units: 0, revenueRub: 0,
      adSpendRub: 0, platformCostRub: 0, landedCostCny: 0,
      estimatedProfitCny: null, estimatedMargin: null,
      confirmedNetRub: financial.confirmedNetRub, confirmedNetCny: financial.confirmedNetCny,
      confirmedOperations: financial.confirmedOperations,
    });
  }
  return rows.sort((a, b) => b.metricDate.localeCompare(a.metricDate) || number(b.revenueRub) - number(a.revenueRub));
}

function summarize(rows, confirmed) {
  return {
    products: new Set(rows.map((row) => row.offerId)).size,
    units: round(rows.reduce((sum, row) => sum + number(row.units), 0)),
    revenueRub: round(rows.reduce((sum, row) => sum + number(row.revenueRub), 0)),
    estimatedProfitCny: round(rows.reduce((sum, row) => sum + number(row.estimatedProfitCny), 0)),
    confirmedNetCny: round(rows.reduce((sum, row) => sum + number(row.confirmedNetCny), 0)),
    confirmedMatchedRows: rows.filter((row) => row.confirmedNetCny !== null).length,
    unallocatedFinanceRub: confirmed.unallocatedRub,
  };
}

async function report({ days = 7 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 7, 1), 31);
  const [result, rates] = await Promise.all([
    query(`
      SELECT m.metric_date::text, m.sales_units, m.revenue, m.ad_spend,
             p.offer_id, p.ozon_sku, p.title, p.image_url, p.commission_rate,
             p.purchase_cost, p.weight, p.freight_rate, p.tail_delivery_rate, p.return_rate
      FROM product_daily_metrics m
      JOIN products p ON p.offer_id = m.offer_id
      WHERE m.metric_date >= (NOW() AT TIME ZONE 'Asia/Shanghai')::date - ($1::int - 1)
      ORDER BY m.metric_date DESC, m.revenue DESC NULLS LAST
    `, [safeDays]),
    getRubRate(),
  ]);
  const settings = readSettings();
  const productsBySku = new Map(result.rows.filter((row) => row.ozon_sku).map((row) => [String(row.ozon_sku), row]));
  const estimatedRows = result.rows.map((row) => calculateEstimatedRow(row, row, rates, settings));
  const from = beijingDateOffset(-(safeDays - 1));
  const to = beijingDateOffset(0);
  let finance = { operations: [] };
  let financeWarning = null;
  try {
    finance = await withTimeout(
      require("./ozon").listFinanceTransactions({ from, to, pageSize: 1000, includeItems: true }),
      10000,
      "Ozon财务流水读取超过10秒，本次先返回预计利润",
    );
  } catch (error) {
    financeWarning = error.message;
  }
  const confirmed = aggregateConfirmedOperations(finance.operations || [], productsBySku, rates);
  const rows = mergeRows(estimatedRows, confirmed);
  return {
    from, to, timezone: "Asia/Shanghai", rows,
    summary: summarize(rows, confirmed),
    parameters: { ...settings, rubToCny: rates.rubToCny, usdToCny: rates.usdToCny },
    dataStatus: {
      estimated: "按日销量、销售额和当前经营参数估算",
      confirmed: financeWarning ? "本次财务流水暂不可用" : "Ozon财务流水净额；未归属SKU的费用单独列示",
      financeWarning,
      exchangeRate: rates.source,
    },
  };
}

module.exports = { report, calculateEstimatedRow, aggregateConfirmedOperations, mergeRows, landedUnitCost, withTimeout, readSettings };
