const fs = require("fs");
const path = require("path");
const https = require("https");
const { query } = require("./src/db");
require("./src/config");

const REPORT_PATH = "/opt/ozon-api-v2/wb-erp-compare-20260603.json";
const TARGET_DATE = "2026-06-03";
const MAX_ATTEMPTS = Number(process.env.WB_COMPARE_MAX_ATTEMPTS || 6);
const DELAY_MS = Number(process.env.WB_COMPARE_DELAY_MS || 180000);

const ERP = {
  local: {
    label: "WB_LOCAL_MIMI",
    keyEnv: "WB_API_KEY",
    productTable: "wb_products",
    metricTable: "wb_daily_metrics",
    expected: {
      paiqiguan200cm: 11,
      "paiqiguan2.5m": 2,
      manshixingxing: 1,
      runhuapenzui: 1,
      DABJ603305925: 1,
      CWMSQ032503232: 1,
      chaixiandao: 1,
      paiqiguan100cm: 1,
    },
  },
  cross: {
    label: "WB_CROSS",
    keyEnv: "WB_CROSS_API_KEY",
    productTable: "wb_cross_products",
    metricTable: "wb_cross_daily_metrics",
    expected: {
      baojiandeng: 3,
      DIYDLB: 2,
      hangmogongju: 2,
      niaojia: 1,
      gaodagongju: 1,
      chuizhizuank: 1,
      manshiqixin: 1,
      zizhujiariguan3M: 1,
      "zizhujiariguan1.5M": 1,
      caixiandao: 1,
      longshangzhantai: 1,
    },
  },
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestStats(endpoint, apiKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "statistics-api.wildberries.ru",
      path: `/api/v1/supplier/${endpoint}?dateFrom=${TARGET_DATE}&flag=0`,
      method: "GET",
      headers: { Authorization: apiKey, Accept: "application/json" },
      timeout: 180000,
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`WB ${endpoint} HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.details = raw.slice(0, 500);
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(raw || "[]"));
        } catch (error) {
          error.details = raw.slice(0, 500);
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`WB ${endpoint} timeout`)));
    req.on("error", reject);
    req.end();
  });
}

function dateKey(row) {
  return String(row.date || row.lastChangeDate || "").slice(0, 10);
}

function vendorCode(row) {
  return String(row.supplierArticle || row.vendorCode || "").trim();
}

function isCanceled(row) {
  return row.isCancel === true || String(row.isCancel).toLowerCase() === "true";
}

function aggregateApiRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (dateKey(row) !== TARGET_DATE) continue;
    if (isCanceled(row)) continue;
    const code = vendorCode(row) || String(row.nmId || row.nmID || row.nmid || "").trim();
    if (!code) continue;
    const item = map.get(code) || { sku: code, qty: 0, revenue: 0 };
    item.qty += 1;
    item.revenue += Number(row.finishedPrice || row.priceWithDisc || row.totalPrice || 0) || 0;
    map.set(code, item);
  }
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function aggregateDb(productTable, metricTable) {
  const rows = await query(
    `SELECT COALESCE(p.vendor_code, m.nm_id) AS sku,
            COALESCE(m.sales_units, 0) AS qty,
            COALESCE(m.revenue, 0) AS revenue
     FROM ${metricTable} m
     LEFT JOIN ${productTable} p ON p.nm_id = m.nm_id
     WHERE m.metric_date = $1::date
       AND COALESCE(m.sales_units, 0) <> 0`,
    [TARGET_DATE]
  );
  const map = {};
  for (const row of rows.rows) {
    map[String(row.sku)] = {
      sku: String(row.sku),
      qty: Number(row.qty || 0),
      revenue: Number(row.revenue || 0),
    };
  }
  return map;
}

function compare(expected, actual) {
  const skus = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const rows = [...skus].sort().map(sku => {
    const erpQty = Number(expected[sku] || 0);
    const actualQty = Number(actual[sku]?.qty || 0);
    return {
      sku,
      erpQty,
      actualQty,
      diff: actualQty - erpQty,
      revenue: Number(actual[sku]?.revenue || 0),
    };
  });
  return {
    totalErp: Object.values(expected).reduce((sum, value) => sum + Number(value || 0), 0),
    totalActual: rows.reduce((sum, row) => sum + row.actualQty, 0),
    totalDiff: rows.reduce((sum, row) => sum + row.actualQty, 0) - Object.values(expected).reduce((sum, value) => sum + Number(value || 0), 0),
    rows: rows.filter(row => row.erpQty || row.actualQty || row.diff),
    diffs: rows.filter(row => row.diff !== 0),
  };
}

async function buildReportOnce() {
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    targetDate: TARGET_DATE,
    markets: {},
  };

  for (const [market, cfg] of Object.entries(ERP)) {
    const apiKey = process.env[cfg.keyEnv];
    if (!apiKey) throw new Error(`${cfg.keyEnv} is required`);

    const [ordersRows, salesRows, dbRows] = await Promise.all([
      requestStats("orders", apiKey),
      requestStats("sales", apiKey),
      aggregateDb(cfg.productTable, cfg.metricTable),
    ]);

    const orders = aggregateApiRows(ordersRows);
    const sales = aggregateApiRows(salesRows);

    report.markets[market] = {
      label: cfg.label,
      expected: cfg.expected,
      dbMetrics: compare(cfg.expected, dbRows),
      orders: compare(cfg.expected, orders),
      sales: compare(cfg.expected, sales),
      rawCounts: {
        ordersRows: Array.isArray(ordersRows) ? ordersRows.length : null,
        salesRows: Array.isArray(salesRows) ? salesRows.length : null,
      },
    };
  }

  return report;
}

async function main() {
  const status = {
    ok: false,
    targetDate: TARGET_DATE,
    startedAt: new Date().toISOString(),
    attempts: [],
  };

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      status.attempts.push({ attempt, startedAt: new Date().toISOString(), status: "running" });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(status, null, 2));

      const report = await buildReportOnce();
      report.attempts = status.attempts.map((item, index) => index === status.attempts.length - 1 ? { ...item, status: "ok", finishedAt: new Date().toISOString() } : item);
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
      console.log(`report written: ${REPORT_PATH}`);
      return;
    } catch (error) {
      const current = status.attempts[status.attempts.length - 1];
      current.status = "failed";
      current.finishedAt = new Date().toISOString();
      current.error = error.message;
      current.statusCode = error.statusCode || null;
      current.details = error.details || "";
      status.lastError = current;
      fs.writeFileSync(REPORT_PATH, JSON.stringify(status, null, 2));

      console.error(`[attempt ${attempt}/${MAX_ATTEMPTS}] ${error.message}`);
      if (attempt < MAX_ATTEMPTS) await sleep(DELAY_MS);
    }
  }

  process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
