const https = require("https");
const { config } = require("./config");
const { query } = require("./db");
const wbMapping = require("./wb_mapping");
const { createWbStatsLimiter } = require("./wb_stats_limiter");

const STATS_HOST = "statistics-api.wildberries.ru";
const CONTENT_HOST = "content-api.wildberries.ru";
const MARKETPLACE_HOST = "marketplace-api.wildberries.ru";
const statsLimiter = createWbStatsLimiter();
const ADVERT_HOST = "advert-api.wildberries.ru";
const adSummaryCache = new Map();
let wbHiddenSchemaReady = false;

async function ensureWbHiddenSchema() {
  if (wbHiddenSchemaReady) return;
  await query("ALTER TABLE wb_products ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false");
  wbHiddenSchemaReady = true;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatDate(date) { return date.toISOString().slice(0, 10); }

function monthBounds(month) {
  const match = String(month || "").match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    const error = new Error("month must use YYYY-MM");
    error.statusCode = 400;
    throw error;
  }
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    const error = new Error("month must use YYYY-MM");
    error.statusCode = 400;
    throw error;
  }
  const from = `${match[1]}-${match[2]}-01`;
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const to = `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`;
  return { month: `${match[1]}-${match[2]}`, from, to };
}

function requestAdvert(path) {
  return new Promise((resolve, reject) => {
    if (!config.wbApiKey) {
      const error = new Error("WB_API_KEY is required");
      error.statusCode = 500;
      reject(error);
      return;
    }
    const req = https.request({
      method: "GET",
      hostname: ADVERT_HOST,
      path,
      headers: { Authorization: config.wbApiKey, Accept: "application/json" },
      timeout: 60000
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : [];
        } catch (error) {
          error.statusCode = 502;
          error.details = raw.slice(0, 500);
          reject(error);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(`WB advert API HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.details = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("WB advert API timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function adSummary({ month = "" } = {}) {
  const period = monthBounds(month);
  const now = Date.now();
  const cached = adSummaryCache.get(period.month);
  if (cached && cached.expiresAt > now) return cached.data;

  const path = `/adv/v1/upd?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`;
  const response = await requestAdvert(path);
  const records = Array.isArray(response) ? response : [];
  const paymentTotals = new Map();
  const campaigns = new Set();
  let totalAdSpend = 0;
  for (const record of records) {
    const amount = Number(record.updSum || 0);
    if (Number.isFinite(amount)) totalAdSpend += amount;
    const paymentType = String(record.paymentType || "未分类");
    paymentTotals.set(paymentType, Number(paymentTotals.get(paymentType) || 0) + (Number.isFinite(amount) ? amount : 0));
    if (record.advertId !== null && record.advertId !== undefined) campaigns.add(String(record.advertId));
  }

  const data = {
    month: period.month,
    from: period.from,
    to: period.to,
    currency: "RUB",
    totalAdSpend: Number(totalAdSpend.toFixed(2)),
    campaignCount: campaigns.size,
    recordCount: records.length,
    paymentBreakdown: Array.from(paymentTotals, ([paymentType, amount]) => ({
      paymentType,
      amount: Number(amount.toFixed(2))
    })),
    source: "WB Promotion API /adv/v1/upd",
    fetchedAt: new Date().toISOString()
  };
  const currentMonth = new Date().toISOString().slice(0, 7);
  const ttlMs = period.month === currentMonth ? 10 * 60 * 1000 : 24 * 60 * 60 * 1000;
  adSummaryCache.set(period.month, { data, expiresAt: now + ttlMs });
  return data;
}

function moscowDateOffset(daysOffset = 0) {
  const date = new Date(Date.now() + 3 * 60 * 60 * 1000);
  date.setUTCDate(date.getUTCDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

function doRequest(path) {
  return new Promise((resolve, reject) => {
    if (!config.wbApiKey) {
      const e = new Error("WB_API_KEY is required");
      e.statusCode = 500;
      reject(e);
      return;
    }

    const req = https.request({
      method: "GET",
      hostname: STATS_HOST,
      path,
      headers: { Authorization: config.wbApiKey, Accept: "application/json" },
      timeout: 60000
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : []; } catch (e) {
          e.statusCode = 502;
          e.details = data.slice(0, 500);
          reject(e);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`WB API HTTP ${res.statusCode}`);
          e.statusCode = res.statusCode;
          e.details = parsed;
          const retryAfter = Number(res.headers["retry-after"] || res.headers["Retry-After"] || 0);
          if (Number.isFinite(retryAfter) && retryAfter > 0) e.retryAfterSeconds = retryAfter;
          reject(e);
          return;
        }
        resolve(Array.isArray(parsed) ? parsed : []);
      });
    });

    req.on("timeout", () => req.destroy(new Error("WB API timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function requestStats(path) {
  return statsLimiter.run(() => doRequest(path));
}

function requestContent(path, body) {
  return new Promise((resolve, reject) => {
    if (!config.wbApiKey) {
      const e = new Error("WB_API_KEY is required");
      e.statusCode = 500;
      reject(e);
      return;
    }

    const payload = JSON.stringify(body || {});
    const req = https.request({
      method: "POST",
      hostname: CONTENT_HOST,
      path,
      headers: {
        Authorization: config.wbApiKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 45000
    }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = data ? JSON.parse(data) : {}; } catch (e) {
          e.statusCode = 502;
          e.details = data.slice(0, 500);
          reject(e);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const e = new Error(`WB content API HTTP ${res.statusCode}`);
          e.statusCode = res.statusCode;
          e.details = parsed;
          reject(e);
          return;
        }
        resolve(parsed || {});
      });
    });

    req.on("timeout", () => req.destroy(new Error("WB content API timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}


function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.stocks)) return data.stocks;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.warehouses)) return data.warehouses;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function requestMarketplace(path, { method = "GET", body = null } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (attempt > 0) await sleep(Math.min(120000, 10000 * attempt));
      return await new Promise((resolve, reject) => {
        if (!config.wbApiKey) {
          const e = new Error("WB_API_KEY is required");
          e.statusCode = 500;
          reject(e);
          return;
        }
        const payload = body === null ? "" : JSON.stringify(body);
        const req = https.request({
          method,
          hostname: MARKETPLACE_HOST,
          path,
          headers: {
            Authorization: config.wbApiKey,
            Accept: "application/json",
            ...(payload ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload)
            } : {})
          },
          timeout: 180000
        }, res => {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", chunk => raw += chunk);
          res.on("end", () => {
            let parsed;
            try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) {
              e.statusCode = 502;
              e.details = raw.slice(0, 500);
              reject(e);
              return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const e = new Error(`WB marketplace API HTTP ${res.statusCode}`);
              e.statusCode = res.statusCode;
              e.details = parsed;
              const retryAfter = Number(res.headers["retry-after"] || res.headers["Retry-After"] || 0);
              if (Number.isFinite(retryAfter) && retryAfter > 0) e.retryAfterSeconds = retryAfter;
              reject(e);
              return;
            }
            resolve(parsed || {});
          });
        });
        req.on("timeout", () => req.destroy(new Error("WB marketplace API timeout")));
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
      });
    } catch (error) {
      lastError = error;
      if (error.statusCode !== 429 || attempt === 5) throw error;
      const retryAfterMs = error.retryAfterSeconds ? error.retryAfterSeconds * 1000 : 15000 * (attempt + 1);
      await sleep(Math.min(180000, retryAfterMs));
    }
  }
  throw lastError;
}

async function fetchAllCards() {
  const cards = [];
  const seenCursors = new Set();
  let cursor = { limit: 100 };
  for (let page = 0; page < 50; page += 1) {
    const data = await requestContent("/content/v2/get/cards/list", {
      settings: { cursor, filter: { withPhoto: -1 } }
    });
    const batch = data.cards || data.data?.cards || [];
    cards.push(...batch);
    const nextCursor = data.cursor || data.data?.cursor || {};
    const total = Number(nextCursor.total || batch.length || 0);
    if (!batch.length || total < 100) break;
    cursor = {
      limit: 100,
      updatedAt: nextCursor.updatedAt,
      nmID: nextCursor.nmID
    };
    if (!cursor.updatedAt || !cursor.nmID) break;
    const cursorKey = `${cursor.updatedAt}:${cursor.nmID}`;
    if (seenCursors.has(cursorKey)) break;
    seenCursors.add(cursorKey);
    await sleep(600);
  }
  return cards;
}

function extractCardSkuMap(cards) {
  const skuToNm = new Map();
  const cardByNm = new Map();
  for (const card of cards || []) {
    const nmId = String(card.nmID || card.nmId || card.nmid || "").trim();
    if (!nmId) continue;
    cardByNm.set(nmId, card);
    for (const size of Array.isArray(card.sizes) ? card.sizes : []) {
      for (const sku of Array.isArray(size.skus) ? size.skus : []) {
        const key = String(sku || "").trim();
        if (key) skuToNm.set(key, nmId);
      }
    }
  }
  return { skuToNm, cardByNm };
}

function sellerWarehouseKey(name) {
  const value = String(name || "");
  if (value.includes("林挺")) return "linting";
  if (value.includes("世晟")) return "shisheng";
  return "";
}

async function persistDashboardWarehouseStock(market, stockByNm, allNmIds) {
  const nmIds = new Set([...allNmIds, ...stockByNm.keys()]);
  for (const nmId of nmIds) {
    const totals = stockByNm.get(nmId) || new Map();
    for (const key of ["linting", "shisheng"]) {
      await query(`
        INSERT INTO inventory_wb_card_warehouse_stock
          (market, nm_id, warehouse_key, stock, source_note, updated_at)
        VALUES ($1,$2,$3,$4,'api_seller_warehouse',NOW())
        ON CONFLICT (market, nm_id, warehouse_key) DO UPDATE SET
          stock = EXCLUDED.stock,
          source_note = EXCLUDED.source_note,
          updated_at = NOW()
      `, [market, nmId, key, Number(totals.get(key) || 0)]);
    }
  }
}

async function syncCards() {
  const cards = await fetchAllCards();
  for (const card of cards) {
    const nmId = String(card.nmID || card.nmId || card.nmid || "");
    if (!nmId) continue;

    const photos = Array.isArray(card.photos) ? card.photos : [];
    const firstPhoto = photos[0] || {};
    const imageUrl = firstPhoto.big || firstPhoto.c246x328 || firstPhoto.tm || null;

    await query(
      `INSERT INTO wb_products (nm_id, vendor_code, title, brand, subject_name, image_url, stock, fbs_stock, fbw_stock)
       VALUES ($1,$2,$3,$4,$5,$6,0,0,0)
       ON CONFLICT (nm_id) DO UPDATE SET
         vendor_code = COALESCE(NULLIF(EXCLUDED.vendor_code, ''), wb_products.vendor_code),
         title = COALESCE(NULLIF(EXCLUDED.title, ''), wb_products.title),
         brand = COALESCE(NULLIF(EXCLUDED.brand, ''), wb_products.brand),
         subject_name = COALESCE(NULLIF(EXCLUDED.subject_name, ''), wb_products.subject_name),
         image_url = COALESCE(EXCLUDED.image_url, wb_products.image_url),
         fbw_stock = 0,
         stock = COALESCE(wb_products.fbs_stock, 0)`,
      [
        nmId,
        String(card.vendorCode || ""),
        String(card.title || card.vendorCode || nmId),
        String(card.brand || ""),
        String(card.subjectName || ""),
        imageUrl
      ]
    );
  }

  return { cards: cards.length, rawCards: cards };
}

function normalizeMetricDateInput(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

async function defaultMetricDate() {
  const result = await query("SELECT ((NOW() AT TIME ZONE 'Asia/Shanghai')::date - 1)::text AS metric_date");
  return result.rows[0]?.metric_date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
}

async function resolveMetricDate(requestedDate) {
  const result = await query(
    `WITH selected AS (
       SELECT $1::date AS requested_date
     ),
     exact_day AS (
       SELECT m.metric_date::date AS metric_date
       FROM wb_daily_metrics m, selected
       WHERE m.metric_date = selected.requested_date
       GROUP BY m.metric_date
       HAVING COALESCE(SUM(m.sales_units), 0) > 0 OR COALESCE(SUM(m.revenue), 0) > 0
     ),
     recent_day AS (
       SELECT m.metric_date::date AS metric_date
       FROM wb_daily_metrics m, selected
       WHERE m.metric_date <= selected.requested_date
         AND m.metric_date >= selected.requested_date - interval '60 days'
       GROUP BY m.metric_date
       HAVING COALESCE(SUM(m.sales_units), 0) > 0 OR COALESCE(SUM(m.revenue), 0) > 0
       ORDER BY m.metric_date DESC
       LIMIT 1
     )
     SELECT
       to_char(selected.requested_date, 'YYYY-MM-DD') AS requested_date,
       to_char(COALESCE((SELECT metric_date FROM exact_day), (SELECT metric_date FROM recent_day), selected.requested_date), 'YYYY-MM-DD') AS metric_date
     FROM selected`,
    [requestedDate]
  );
  return result.rows[0] || { requested_date: requestedDate, metric_date: requestedDate };
}

function productSelect() {
  return `id, nm_id, vendor_code, title, brand, subject_name, image_url, stock, fbs_stock, fbw_stock,
    yesterday_sales, commission_rate, purchase_cost, shipping_cost, weight, freight_rate, tail_delivery_rate, return_rate, price,
    front_price, front_price_source, front_price_updated_at, ad_ratio, competitor_compare,
    strategy, COALESCE(hidden, false) AS hidden, created_at, updated_at`;
}

async function dashboard({ date = "", dateFrom = "", dateTo = "", showHidden = false } = {}) {
  await ensureWbHiddenSchema();
  await refreshYesterdaySalesFromMetrics();
  const requestedDate = normalizeMetricDateInput(date) || await defaultMetricDate();
  const selectedDateFrom = normalizeMetricDateInput(dateFrom) || requestedDate;
  const selectedDateTo = normalizeMetricDateInput(dateTo) || selectedDateFrom;
  if (selectedDateFrom > selectedDateTo) {
    const error = new Error("date_from must not be after date_to"); error.statusCode = 400; throw error;
  }
  const singleDay = selectedDateFrom === selectedDateTo;
  const resolvedDate = singleDay ? await resolveMetricDate(selectedDateFrom) : null;
  const rangeFrom = resolvedDate?.metric_date || selectedDateFrom;
  const rangeTo = resolvedDate?.metric_date || selectedDateTo;
  const includeHidden = showHidden === true || showHidden === "true" || showHidden === "1" || showHidden === 1;
  const result = await query(`SELECT ${productSelect()} FROM wb_products ${includeHidden ? "" : "WHERE COALESCE(hidden, false) = false"} ORDER BY yesterday_sales DESC NULLS LAST, updated_at DESC`);
  const products = result.rows;
  const metrics = await query(
    `SELECT nm_id, COALESCE(SUM(sales_units), 0) AS sales_units, COALESCE(SUM(revenue), 0) AS revenue
     FROM wb_daily_metrics
     WHERE metric_date BETWEEN $1::date AND $2::date
     GROUP BY nm_id`,
    [rangeFrom, rangeTo]
  );
  const byNm = new Map(metrics.rows.map(row => [String(row.nm_id), row]));
  for (const product of products) {
    const metric = byNm.get(String(product.nm_id));
    product.selected_sales = Number(metric?.sales_units || 0);
    product.selected_revenue = Number(metric?.revenue || 0);
    product.metric_date = rangeTo;
    product.yesterday_sales = product.selected_sales;
  }
  return {
    summary: {
      productCount: products.length,
      totalStock: products.reduce((s, x) => s + Number(x.stock || 0), 0),
      totalYesterdaySales: products.reduce((s, x) => s + Number(x.yesterday_sales || 0), 0),
      totalSales: products.reduce((s, x) => s + Number(x.selected_sales || 0), 0),
      totalRevenue: products.reduce((s, x) => s + Number(x.selected_revenue || 0), 0),
      selectedDate: rangeTo,
      selectedDateFrom: rangeFrom,
      selectedDateTo: rangeTo,
      requestedDate,
      dateFallback: singleDay && rangeTo !== requestedDate
    },
    products,
    fetchedAt: new Date().toISOString(),
    source: { provider: "wildberries", selectedDateFrom: rangeFrom, selectedDateTo: rangeTo, requestedDate, dateFallback: singleDay && rangeTo !== requestedDate }
  };
}

async function updateProduct(nmId, payload) {
  await ensureWbHiddenSchema();
  const allowed = ["commission_rate", "purchase_cost", "shipping_cost", "weight", "freight_rate", "tail_delivery_rate", "return_rate", "price", "front_price", "front_price_source", "front_price_updated_at", "ad_ratio", "competitor_compare", "strategy", "image_url", "hidden"];
  const fields = Object.keys(payload || {}).filter(f => allowed.includes(f));
  if (!fields.length) return null;
  const params = fields.map(f => payload[f]);
  params.push(nmId);
  const sets = fields.map((f, i) => `${f} = $${i + 1}`).join(", ");
  const r = await query(`UPDATE wb_products SET ${sets}, updated_at = now() WHERE nm_id = $${params.length} RETURNING ${productSelect()}`, params);
  const product = r.rows[0] || null;
  if (product) await wbMapping.syncFrom("wb", nmId, payload);
  return product;
}

async function storeMetrics({ days = 30 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 120);
  const result = await query(
    `WITH days AS (
       SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day')::date AS metric_date
     )
     SELECT
       to_char(days.metric_date, 'YYYY-MM-DD') AS metric_date,
       COALESCE(SUM(m.sales_units), 0) AS sales_units,
       COALESCE(SUM(m.revenue), 0) AS revenue
     FROM days LEFT JOIN wb_daily_metrics m ON m.metric_date = days.metric_date
     GROUP BY days.metric_date
     ORDER BY days.metric_date ASC`,
    [safeDays]
  );
  return result.rows;
}async function listMetrics(nmId, { days = 30, dateFrom = "", dateTo = "" } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 366);
  const rangeTo = normalizeMetricDateInput(dateTo) || moscowDateOffset(0);
  const fallbackFrom = new Date(`${rangeTo}T00:00:00Z`);
  fallbackFrom.setUTCDate(fallbackFrom.getUTCDate() - safeDays + 1);
  const rangeFrom = normalizeMetricDateInput(dateFrom) || fallbackFrom.toISOString().slice(0, 10);
  const r = await query(
    `SELECT metric_date::text AS metric_date, sales_units, revenue, updated_at
     FROM wb_daily_metrics
     WHERE nm_id = $1 AND metric_date BETWEEN $2::date AND $3::date
     ORDER BY metric_date ASC`,
    [nmId, rangeFrom, rangeTo]
  );

  const byDate = new Map(r.rows.map(row => [String(row.metric_date).slice(0, 10), row]));
  const out = [];
  const totalDays = Math.min(366, Math.floor((new Date(`${rangeTo}T00:00:00Z`) - new Date(`${rangeFrom}T00:00:00Z`)) / 86400000) + 1);
  for (let offset = 0; offset < totalDays; offset += 1) {
    const date = new Date(`${rangeFrom}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + offset);
    const key = date.toISOString().slice(0, 10);
    const existing = byDate.get(key);
    out.push(existing || { metric_date: key, sales_units: 0, revenue: 0 });
  }
  return out;
}

async function refreshYesterdaySalesFromMetrics() {
  const yesterday = moscowDateOffset(-1);

  await query("UPDATE wb_products SET yesterday_sales = 0");
  await query(
    `UPDATE wb_products p
     SET yesterday_sales = COALESCE(m.sales_units, 0),
         updated_at = now()
     FROM wb_daily_metrics m
     WHERE p.nm_id = m.nm_id
       AND m.metric_date = $1::date`,
    [yesterday]
  );

  const result = await query("SELECT COALESCE(SUM(yesterday_sales), 0) AS total FROM wb_products");
  return Number(result.rows[0]?.total || 0);
}

async function currentYesterdaySalesTotal() {
  const result = await query("SELECT COALESCE(SUM(yesterday_sales), 0) AS total FROM wb_products");
  return Number(result.rows[0]?.total || 0);
}

function syncErrorInfo(error) {
  return {
    ok: false,
    error: error && error.message ? error.message : String(error),
    statusCode: error && error.statusCode ? error.statusCode : null,
    retryAfterSeconds: error && error.retryAfterSeconds ? error.retryAfterSeconds : null,
    details: error && error.details ? error.details : null
  };
}

function syncOkInfo(extra = {}) {
  return { ok: true, ...extra };
}

async function sync({ days = 30, onPhase } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
  const fromDate = moscowDateOffset(-(safeDays - 1));
  const result = {
    ok: true,
    partialFailure: false,
    phases: {},
    cards: 0,
    products: 0,
    stockRows: 0,
    salesRows: 0,
    metricsSaved: 0,
    yesterdayTotal: null
  };

  function markPhase(name, state) {
    result.phases[name] = state;
    if (typeof onPhase === "function") onPhase(name, state, { ...result });
  }

  let cardsResult = { cards: 0, rawCards: [] };
  try {
    markPhase("cards", { ok: null, running: true, startedAt: new Date().toISOString() });
    cardsResult = await syncCards();
    result.cards = cardsResult.cards;
    markPhase("cards", syncOkInfo({ cards: cardsResult.cards, finishedAt: new Date().toISOString() }));
  } catch (error) {
    result.ok = false;
    result.partialFailure = true;
    markPhase("cards", { ...syncErrorInfo(error), finishedAt: new Date().toISOString() });
  }

  let orders = [];
  let daily = new Map();
  let products = new Map();
  let salesSucceeded = false;
  try {
    markPhase("sales", { ok: null, running: true, fromDate, startedAt: new Date().toISOString() });
    orders = await requestStats(`/api/v1/supplier/orders?dateFrom=${fromDate}&flag=0`);
    for (const order of orders) {
      const nmId = String(order.nmId || order.nmID || "");
      const date = String(order.date || order.lastChangeDate || "").slice(0, 10);
      if (!nmId || !date || date < fromDate) continue;
      if (order.isCancel === true || String(order.isCancel).toLowerCase() === "true") continue;

      const item = products.get(nmId) || {
        nm_id: nmId,
        vendor_code: order.supplierArticle || "",
        title: order.supplierArticle || nmId,
        brand: order.brand || "",
        subject_name: order.subject || order.category || "",
        stock: 0
      };
      products.set(nmId, item);

      const key = `${nmId}:${date}`;
      const metric = daily.get(key) || { nm_id: nmId, metric_date: date, sales_units: 0, revenue: 0 };
      metric.sales_units += 1;
      metric.revenue += Number(order.finishedPrice || order.priceWithDisc || 0);
      daily.set(key, metric);
    }

    for (const item of products.values()) {
      await query(
        `INSERT INTO wb_products (nm_id, vendor_code, title, brand, subject_name, stock)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (nm_id) DO UPDATE SET
           vendor_code = COALESCE(NULLIF(EXCLUDED.vendor_code, ''), wb_products.vendor_code),
           title = COALESCE(NULLIF(EXCLUDED.title, ''), wb_products.title),
           brand = COALESCE(NULLIF(EXCLUDED.brand, ''), wb_products.brand),
           subject_name = COALESCE(NULLIF(EXCLUDED.subject_name, ''), wb_products.subject_name),
           stock = CASE WHEN EXCLUDED.stock > 0 THEN EXCLUDED.stock ELSE wb_products.stock END,
           updated_at = NOW()`,
        [item.nm_id, item.vendor_code, item.title, item.brand, item.subject_name, item.stock]
      );
    }

    await query(`DELETE FROM wb_daily_metrics WHERE metric_date >= $1`, [fromDate]);
    for (const item of daily.values()) {
      await query(
        `INSERT INTO wb_daily_metrics (nm_id, metric_date, sales_units, revenue)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (nm_id, metric_date) DO UPDATE SET
           sales_units = EXCLUDED.sales_units,
           revenue = EXCLUDED.revenue,
           updated_at = NOW()`,
        [item.nm_id, item.metric_date, item.sales_units, item.revenue]
      );
    }

    result.products = products.size;
    result.salesRows = Array.isArray(orders) ? orders.length : 0;
    result.metricsSaved = daily.size;
    salesSucceeded = true;
    markPhase("sales", syncOkInfo({ orders: result.salesRows, metricsSaved: result.metricsSaved, fromDate, finishedAt: new Date().toISOString() }));
  } catch (error) {
    result.ok = false;
    result.partialFailure = true;
    markPhase("sales", { ...syncErrorInfo(error), fromDate, finishedAt: new Date().toISOString() });
  }

  if (salesSucceeded) {
    try {
      markPhase("yesterday", { ok: null, running: true, startedAt: new Date().toISOString() });
      result.yesterdayTotal = await refreshYesterdaySalesFromMetrics();
      markPhase("yesterday", syncOkInfo({ yesterdayTotal: result.yesterdayTotal, finishedAt: new Date().toISOString() }));
    } catch (error) {
      result.ok = false;
      result.partialFailure = true;
      markPhase("yesterday", { ...syncErrorInfo(error), finishedAt: new Date().toISOString() });
    }
  } else {
    try {
      result.yesterdayTotal = await currentYesterdaySalesTotal();
    } catch {
      result.yesterdayTotal = null;
    }
    markPhase("yesterday", {
      ok: null,
      skipped: true,
      reason: "sales_sync_failed_preserved_previous_value",
      yesterdayTotal: result.yesterdayTotal,
      finishedAt: new Date().toISOString()
    });
  }

  try {
    markPhase("mapping", { ok: null, running: true, startedAt: new Date().toISOString() });
    await wbMapping.autoMapByVendorCode();
    markPhase("mapping", syncOkInfo({ finishedAt: new Date().toISOString() }));
  } catch (error) {
    result.ok = false;
    result.partialFailure = true;
    markPhase("mapping", { ...syncErrorInfo(error), finishedAt: new Date().toISOString() });
  }

  if (result.partialFailure) {
    const failed = Object.entries(result.phases).filter(([, phase]) => phase && phase.ok === false);
    const first = failed[0]?.[1];
    result.error = failed.map(([name, phase]) => `${name}: ${phase.error}`).join("; ") || "WB 同步部分失败";
    result.errorDetails = first && first.details ? first.details : null;
    result.retryAfterSeconds = first && first.retryAfterSeconds ? first.retryAfterSeconds : null;
  }

  return result;
}

async function syncStocks() {
  const cardsResult = await syncCards();
  const cards = cardsResult.rawCards || [];
  const { skuToNm, cardByNm } = extractCardSkuMap(cards);
  const skus = Array.from(skuToNm.keys());
  const stockByNm = new Map();
  let stockRows = 0;

  const sellerWarehouses = rows(await requestMarketplace("/api/v3/warehouses"));
  for (const warehouse of sellerWarehouses) {
    const warehouseId = warehouse.id || warehouse.warehouseId;
    if (!warehouseId) continue;
    const warehouseName = String(warehouse.name || warehouse.officeName || warehouse.warehouseName || warehouseId);
    const warehouseKey = sellerWarehouseKey(warehouseName);
    for (let index = 0; index < skus.length; index += 1000) {
      const chunk = skus.slice(index, index + 1000);
      if (!chunk.length) continue;
      const response = await requestMarketplace(`/api/v3/stocks/${encodeURIComponent(warehouseId)}`, {
        method: "POST",
        body: { skus: chunk }
      });
      for (const row of rows(response)) {
        stockRows += 1;
        const nmId = skuToNm.get(String(row.sku || "").trim());
        if (!nmId) continue;
        const amount = Number(row.amount || 0);
        const totals = stockByNm.get(nmId) || new Map();
        if (warehouseKey) totals.set(warehouseKey, Number(totals.get(warehouseKey) || 0) + amount);
        totals.set("__total", Number(totals.get("__total") || 0) + amount);
        stockByNm.set(nmId, totals);
      }
      await sleep(350);
    }
  }

  await persistDashboardWarehouseStock("wb", stockByNm, cardByNm.keys());

  for (const [nmId, card] of cardByNm.entries()) {
    const sellerStock = Number((stockByNm.get(nmId) || new Map()).get("__total") || 0);
    await query(
      `INSERT INTO wb_products (nm_id, vendor_code, title, brand, subject_name, stock, fbs_stock, fbw_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$6,0)
       ON CONFLICT (nm_id) DO UPDATE SET
         vendor_code = COALESCE(NULLIF(EXCLUDED.vendor_code, ''), wb_products.vendor_code),
         title = COALESCE(NULLIF(EXCLUDED.title, ''), wb_products.title),
         brand = COALESCE(NULLIF(EXCLUDED.brand, ''), wb_products.brand),
         subject_name = COALESCE(NULLIF(EXCLUDED.subject_name, ''), wb_products.subject_name),
         fbs_stock = EXCLUDED.fbs_stock,
         fbw_stock = 0,
         stock = EXCLUDED.fbs_stock,
         updated_at = NOW()`,
      [
        nmId,
        String(card.vendorCode || ""),
        String(card.title || card.vendorCode || nmId),
        String(card.brand || ""),
        String(card.subjectName || ""),
        sellerStock
      ]
    );
  }

  await wbMapping.autoMapByVendorCode();
  return {
    cards: cards.length,
    products: cardByNm.size,
    sellerWarehouses: sellerWarehouses.length,
    stockRows,
    dashboardRows: cardByNm.size * 2
  };
}

module.exports = { dashboard, storeMetrics, listMetrics, updateProduct, sync, syncStocks, syncCards, adSummary };
