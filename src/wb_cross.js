const https = require("https");
const fs = require("fs");
const path = require("path");
const { query } = require("./db");
const wbMapping = require("./wb_mapping");

const API_HOST = "statistics-api.wildberries.ru";
const MARKETPLACE_HOST = "marketplace-api.wildberries.ru";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatMoscowDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function moscowDateOffset(daysOffset) {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + daysOffset);
  return formatMoscowDate(now);
}

function requestStats(pathname) {
  const key = process.env.WB_CROSS_API_KEY;
  if (!key) throw new Error("WB_CROSS_API_KEY is required");

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: API_HOST,
        path: pathname,
        method: "GET",
        headers: { Authorization: key },
        timeout: 180000
      },
      res => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { raw += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`WB cross API HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw || "[]"));
          } catch (error) {
            reject(new Error(`WB cross API JSON parse failed: ${error.message}`));
          }
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("WB cross API timeout after 180s")));
    req.on("error", reject);
    req.end();
  });
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS wb_cross_products (
      id BIGSERIAL PRIMARY KEY,
      nm_id TEXT UNIQUE NOT NULL,
      vendor_code TEXT,
      title TEXT,
      brand TEXT,
      subject_name TEXT,
      image_url TEXT,
      stock NUMERIC,
      fbs_stock NUMERIC,
      fbw_stock NUMERIC,
      yesterday_sales NUMERIC,
      commission_rate NUMERIC,
      purchase_cost NUMERIC,
      shipping_cost NUMERIC,
      weight NUMERIC,
      freight_rate NUMERIC,
      return_rate NUMERIC,
      price NUMERIC,
      ad_ratio NUMERIC,
      competitor_compare TEXT,
      strategy TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wb_cross_daily_metrics (
      id BIGSERIAL PRIMARY KEY,
      nm_id TEXT NOT NULL,
      metric_date DATE NOT NULL,
      sales_units NUMERIC DEFAULT 0,
      revenue NUMERIC DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE (nm_id, metric_date)
    )
  `);
}

function getNmId(row) {
  return String(row.nmId || row.nmID || row.nmid || "").trim();
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

function getVendorCode(row) {
  return String(row.supplierArticle || row.vendorCode || "").trim();
}

function isFbs(row) {
  const text = String(row.warehouseType || row.warehouseName || "").toLowerCase();
  return text.includes("продав") || text.includes("seller");
}

async function dashboard({ date = "" } = {}) {
  await ensureSchema();
  await refreshYesterdaySalesFromMetrics();
  const selectedDate = normalizeMetricDateInput(date) || await defaultMetricDate();

  const productsResult = await query(`
    SELECT *
    FROM wb_cross_products
    ORDER BY COALESCE(yesterday_sales, 0) DESC, updated_at DESC, id DESC
  `);
  const products = productsResult.rows;

  const metrics = await query(
    `SELECT nm_id, COALESCE(sales_units, 0) AS sales_units, COALESCE(revenue, 0) AS revenue
     FROM wb_cross_daily_metrics
     WHERE metric_date = $1::date`,
    [selectedDate]
  );
  const byNm = new Map(metrics.rows.map(row => [String(row.nm_id), row]));
  for (const product of products) {
    const metric = byNm.get(String(product.nm_id));
    product.selected_sales = Number(metric?.sales_units || 0);
    product.selected_revenue = Number(metric?.revenue || 0);
    product.metric_date = selectedDate;
    product.yesterday_sales = product.selected_sales;
  }

  return {
    summary: {
      productCount: products.length,
      totalStock: products.reduce((s, x) => s + Number(x.stock || 0), 0),
      totalYesterdaySales: products.reduce((s, x) => s + Number(x.yesterday_sales || 0), 0),
      totalSales: products.reduce((s, x) => s + Number(x.selected_sales || 0), 0),
      totalRevenue: products.reduce((s, x) => s + Number(x.selected_revenue || 0), 0),
      selectedDate
    },
    products,
    fetchedAt: new Date().toISOString(),
    source: { provider: "wildberries-cross", selectedDate }
  };
}
async function storeMetrics({ days = 30 } = {}) {
  await ensureSchema();
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 120);
  const result = await query(
    `WITH days AS (
       SELECT generate_series(CURRENT_DATE - ($1::int - 1), CURRENT_DATE, interval '1 day')::date AS metric_date
     )
     SELECT
       to_char(days.metric_date, 'YYYY-MM-DD') AS metric_date,
       COALESCE(SUM(m.sales_units), 0) AS sales_units,
       COALESCE(SUM(m.revenue), 0) AS revenue
     FROM days LEFT JOIN wb_cross_daily_metrics m ON m.metric_date = days.metric_date
     GROUP BY days.metric_date
     ORDER BY days.metric_date ASC`,
    [safeDays]
  );
  return result.rows;
}async function listMetrics(nmId, options = {}) {
  await ensureSchema();

  const days = Math.max(1, Number(options.days || 7));
  const id = String(nmId || "").trim();
  if (!id) return [];

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setUTCDate(today.getUTCDate() - (days - 1));
  const fromDate = from.toISOString().slice(0, 10);

  const result = await query(
    `SELECT metric_date::text AS metric_date,
            COALESCE(sales_units, 0) AS sales_units,
            COALESCE(revenue, 0) AS revenue,
            updated_at
     FROM wb_cross_daily_metrics
     WHERE nm_id = $1 AND metric_date >= $2
     ORDER BY metric_date ASC`,
    [id, fromDate]
  );

  const byDate = new Map(result.rows.map(row => [
    String(row.metric_date).slice(0, 10),
    {
      metric_date: String(row.metric_date).slice(0, 10),
      sales_units: Number(row.sales_units || 0),
      revenue: Number(row.revenue || 0),
      updated_at: row.updated_at,
    },
  ]));

  const rows = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(from);
    d.setUTCDate(from.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    rows.push(byDate.get(key) || { metric_date: key, sales_units: 0, revenue: 0 });
  }

  return rows;
}

async function updateProduct(nmId, patch) {
  await ensureSchema();

  const allowed = [
    "vendor_code", "title", "brand", "subject_name", "image_url",
    "stock", "fbs_stock", "fbw_stock", "yesterday_sales",
    "commission_rate", "purchase_cost", "shipping_cost", "weight", "freight_rate",
    "return_rate", "price", "ad_ratio", "competitor_compare", "strategy"
  ];

  await query(
    `INSERT INTO wb_cross_products (nm_id, updated_at)
     VALUES ($1, now())
     ON CONFLICT (nm_id) DO NOTHING`,
    [String(nmId)]
  );

  const entries = Object.entries(patch || {}).filter(([key]) => allowed.includes(key));
  if (entries.length) {
    const sets = entries.map(([key], index) => `${key} = $${index + 2}`);
    const values = entries.map(([, value]) => value);
    const result = await query(
      `UPDATE wb_cross_products
       SET ${sets.join(", ")}, updated_at = now()
       WHERE nm_id = $1
       RETURNING *`,
      [String(nmId), ...values]
    );
    const product = result.rows[0] || null;
    if (product) await wbMapping.syncFrom("wb-cross", nmId, patch);
    return product;
  }

  return (await query("SELECT * FROM wb_cross_products WHERE nm_id = $1", [String(nmId)])).rows[0] || null;
}


async function requestContent(pathname, body) {
  const https = require("https");
  const apiKey = process.env.WB_CROSS_API_KEY || "";
  if (!apiKey) throw new Error("WB_CROSS_API_KEY is required");

  const payload = JSON.stringify(body || {});

  return await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "content-api.wildberries.ru",
      path: pathname,
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 180000
    }, res => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch (error) {
          return reject(new Error("WB content JSON parse failed: " + raw.slice(0, 200)));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("WB content HTTP " + res.statusCode + ": " + raw.slice(0, 200)));
        }
        resolve(data);
      });
    });

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("WB content timeout")));
    req.write(payload);
    req.end();
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function stripDimensionMeta(dimensions) {
  const source = dimensions || {};
  const out = {};
  for (const key of ["length", "width", "height", "weightBrutto"]) {
    if (source[key] !== undefined && source[key] !== null && source[key] !== "") {
      out[key] = Number(source[key]);
    }
  }
  return out;
}

function normalizeCharacteristics(characteristics) {
  return (characteristics || [])
    .filter(item => item && item.id !== undefined)
    .map(item => ({
      id: Number(item.id),
      value: Array.isArray(item.value) ? item.value : item.value === undefined ? [] : [item.value]
    }));
}

function normalizeSizes(sizes) {
  return (sizes || []).map(size => {
    const out = {};
    if (size.chrtID !== undefined) out.chrtID = Number(size.chrtID);
    if (size.techSize !== undefined) out.techSize = String(size.techSize);
    if (size.wbSize !== undefined) out.wbSize = String(size.wbSize);
    if (Array.isArray(size.skus)) out.skus = size.skus.map(item => String(item));
    return out;
  });
}

async function getOfficialCard(nmId) {
  const id = String(nmId || "").trim();
  if (!id) {
    const error = new Error("nm_id is required");
    error.statusCode = 400;
    throw error;
  }

  const data = await requestContent("/content/v2/get/cards/list", {
    settings: {
      filter: {
        textSearch: id,
        withPhoto: -1
      },
      cursor: { limit: 100 }
    }
  });

  const cards = data.cards || data.data?.cards || [];
  const card = cards.find(item => String(item.nmID || item.nmId || item.nmid || "") === id) || null;
  if (!card) {
    const error = new Error("WB cross product card not found");
    error.statusCode = 404;
    throw error;
  }
  return card;
}

function summarizeCard(card) {
  return {
    nmID: card.nmID,
    imtID: card.imtID,
    vendorCode: card.vendorCode,
    subjectID: card.subjectID,
    subjectName: card.subjectName,
    brand: card.brand || "",
    title: card.title || "",
    description: card.description || "",
    photos: card.photos || [],
    photoCount: (card.photos || []).length,
    video: card.video || "",
    dimensions: card.dimensions || {},
    characteristics: card.characteristics || [],
    characteristicsCount: (card.characteristics || []).length,
    sizes: card.sizes || [],
    sizesCount: (card.sizes || []).length,
    tags: card.tags || [],
    createdAt: card.createdAt || "",
    updatedAt: card.updatedAt || "",
    needKiz: card.needKiz,
    kizMarked: card.kizMarked
  };
}

function buildUpdateCard(card, updates = {}) {
  const next = cloneJson(card);

  if (updates.title !== undefined) next.title = normalizeText(updates.title);
  if (updates.description !== undefined) next.description = normalizeText(updates.description);
  if (updates.brand !== undefined) next.brand = normalizeText(updates.brand);
  if (updates.dimensions !== undefined) next.dimensions = {
    ...stripDimensionMeta(card.dimensions),
    ...stripDimensionMeta(updates.dimensions)
  };
  if (Array.isArray(updates.characteristics)) next.characteristics = updates.characteristics;
  if (updates.kizMarked !== undefined) next.kizMarked = Boolean(updates.kizMarked);

  const item = {
    nmID: Number(next.nmID),
    vendorCode: String(next.vendorCode || ""),
    brand: String(next.brand || ""),
    title: String(next.title || ""),
    description: String(next.description || ""),
    dimensions: stripDimensionMeta(next.dimensions),
    characteristics: normalizeCharacteristics(next.characteristics),
    sizes: normalizeSizes(next.sizes)
  };

  if (next.kizMarked !== undefined) item.kizMarked = Boolean(next.kizMarked);

  const changedFields = [];
  for (const key of ["title", "description", "brand", "kizMarked"]) {
    if (updates[key] !== undefined && JSON.stringify(card[key] ?? "") !== JSON.stringify(next[key] ?? "")) {
      changedFields.push(key);
    }
  }
  if (updates.dimensions !== undefined) changedFields.push("dimensions");
  if (Array.isArray(updates.characteristics)) changedFields.push("characteristics");

  return { item, changedFields, next };
}

async function getWbCrossOfficialCard(nmId) {
  const card = await getOfficialCard(nmId);
  return {
    card,
    summary: summarizeCard(card),
    warning: "Photos, video, and tags are read for analysis only. WB /content/v2/cards/update does not update media or tags."
  };
}

async function buildWbCrossUpdatePreview(nmId, updates = {}) {
  const card = await getOfficialCard(nmId);
  const { item, changedFields, next } = buildUpdateCard(card, updates);
  return {
    nm_id: String(nmId),
    confirmText: `UPDATE_WB_CROSS_${nmId}`,
    changedFields,
    current: summarizeCard(card),
    next: summarizeCard(next),
    updatePayload: [item],
    preserved: {
      photos: (card.photos || []).length,
      video: Boolean(card.video),
      tags: (card.tags || []).length,
      sizes: (card.sizes || []).length,
      characteristics: (card.characteristics || []).length
    },
    warning: "Preview only. Submit requires confirmText. Media and tags are not changed by this endpoint."
  };
}

function writeWbCrossBackup(nmId, payload) {
  const dir = path.join(process.cwd(), "backups", "wb-cross-products");
  fs.mkdirSync(dir, { recursive: true });
  const safeNmId = String(nmId).replace(/[^0-9A-Za-z_-]/g, "_");
  const filename = `${safeNmId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2));
  return fullPath;
}

async function submitWbCrossUpdate(nmId, updates = {}, confirm = "") {
  const preview = await buildWbCrossUpdatePreview(nmId, updates);
  if (confirm !== preview.confirmText) {
    const error = new Error(`Confirmation required: ${preview.confirmText}`);
    error.statusCode = 400;
    error.details = { confirmText: preview.confirmText, preview };
    throw error;
  }

  const backupPath = writeWbCrossBackup(nmId, preview);
  const response = await requestContent("/content/v2/cards/update", preview.updatePayload);
  return {
    backupPath,
    response,
    preview: {
      nm_id: preview.nm_id,
      changedFields: preview.changedFields,
      current: preview.current,
      next: preview.next,
      preserved: preview.preserved
    }
  };
}


function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.stocks)) return data.stocks;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.warehouses)) return data.warehouses;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function requestMarketplace(pathname, { method = "GET", body = null } = {}) {
  const apiKey = process.env.WB_CROSS_API_KEY || "";
  if (!apiKey) throw new Error("WB_CROSS_API_KEY is required");
  let lastError;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      if (attempt > 0) await sleep(Math.min(120000, 10000 * attempt));
      const payload = body === null ? "" : JSON.stringify(body);
      return await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: MARKETPLACE_HOST,
          path: pathname,
          method,
          headers: {
            Authorization: apiKey,
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
            let data = null;
            try { data = raw ? JSON.parse(raw) : {}; } catch (error) {
              error.statusCode = 502;
              error.details = raw.slice(0, 500);
              reject(error);
              return;
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const error = new Error(`WB marketplace API HTTP ${res.statusCode}: ${raw.slice(0, 200)}`);
              error.statusCode = res.statusCode;
              const retryAfter = Number(res.headers["retry-after"] || res.headers["Retry-After"] || 0);
              if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
              reject(error);
              return;
            }
            resolve(data || {});
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
  await ensureSchema();

  const cards = await fetchAllCards();
  for (const card of cards) {
    const nmId = String(card.nmID || card.nmId || card.nmid || "");
    if (!nmId) continue;

    const vendorCode = String(card.vendorCode || "");
    const title = String(card.title || vendorCode || nmId);
    const brand = String(card.brand || "");
    const subjectName = String(card.subjectName || "");

    await query(
      `
        INSERT INTO wb_cross_products (nm_id, vendor_code, title, brand, subject_name, stock, fbs_stock, fbw_stock, updated_at)
        VALUES ($1, $2, $3, $4, $5, 0, 0, 0, now())
        ON CONFLICT (nm_id) DO UPDATE SET
          vendor_code = COALESCE(NULLIF(EXCLUDED.vendor_code, ''), wb_cross_products.vendor_code),
          title = COALESCE(NULLIF(EXCLUDED.title, ''), wb_cross_products.title),
          brand = COALESCE(NULLIF(EXCLUDED.brand, ''), wb_cross_products.brand),
          subject_name = COALESCE(NULLIF(EXCLUDED.subject_name, ''), wb_cross_products.subject_name),
          updated_at = now()
      `,
      [nmId, vendorCode, title, brand, subjectName]
    );
  }

  await wbMapping.autoMapByVendorCode();
  return { cards: cards.length, rawCards: cards };
}

async function syncStocks() {
  await ensureSchema();

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

  await persistDashboardWarehouseStock("wb_cross", stockByNm, cardByNm.keys());

  for (const [nmId, card] of cardByNm.entries()) {
    const sellerStock = Number((stockByNm.get(nmId) || new Map()).get("__total") || 0);
    await query(
      `
        INSERT INTO wb_cross_products (nm_id, vendor_code, title, brand, subject_name, stock, fbs_stock, fbw_stock, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $6, 0, now())
        ON CONFLICT (nm_id) DO UPDATE SET
          vendor_code = COALESCE(NULLIF(EXCLUDED.vendor_code, ''), wb_cross_products.vendor_code),
          title = COALESCE(NULLIF(EXCLUDED.title, ''), wb_cross_products.title),
          brand = COALESCE(NULLIF(EXCLUDED.brand, ''), wb_cross_products.brand),
          subject_name = COALESCE(NULLIF(EXCLUDED.subject_name, ''), wb_cross_products.subject_name),
          stock = EXCLUDED.stock,
          fbs_stock = EXCLUDED.fbs_stock,
          fbw_stock = 0,
          updated_at = now()
      `,
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
    stockRows,
    stockProducts: cardByNm.size,
    sellerWarehouses: sellerWarehouses.length,
    dashboardRows: cardByNm.size * 2
  };
}

async function syncSales(days = 30) {
  await ensureSchema();

  const span = Math.max(1, Number(days || 30));
  const fromDate = moscowDateOffset(-(span - 1));
  const rows = await requestStats(`/api/v1/supplier/orders?dateFrom=${fromDate}&flag=0`);

  const daily = new Map();
  const yesterdayKey = moscowDateOffset(-1);
  const yesterdaySales = new Map();

  for (const row of rows || []) {
    const nmId = getNmId(row);
    if (!nmId) continue;
    if (row.isCancel === true || String(row.isCancel).toLowerCase() === "true") continue;

    const dateKey = String(row.date || row.lastChangeDate || "").slice(0, 10);
    if (!dateKey || dateKey < fromDate) continue;

    const key = `${nmId}:${dateKey}`;
    const item = daily.get(key) || {
      nm_id: nmId,
      metric_date: dateKey,
      sales_units: 0,
      revenue: 0,
      vendor_code: getVendorCode(row),
      title: getVendorCode(row) || nmId,
      subject_name: row.subject || row.category || ""
    };

    item.sales_units += 1;
    item.revenue += Number(row.finishedPrice || row.priceWithDisc || row.totalPrice || 0) || 0;
    daily.set(key, item);

    if (dateKey === yesterdayKey) {
      yesterdaySales.set(nmId, (yesterdaySales.get(nmId) || 0) + 1);
    }
  }

  for (const item of daily.values()) {
    await query(
      `INSERT INTO wb_cross_products (nm_id, vendor_code, title, subject_name, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (nm_id) DO UPDATE SET
         vendor_code = COALESCE(NULLIF(wb_cross_products.vendor_code, ''), EXCLUDED.vendor_code),
         title = COALESCE(NULLIF(wb_cross_products.title, ''), EXCLUDED.title),
         subject_name = COALESCE(NULLIF(wb_cross_products.subject_name, ''), EXCLUDED.subject_name),
         updated_at = now()`,
      [item.nm_id, item.vendor_code, item.title, item.subject_name]
    );
  }

  await query(`DELETE FROM wb_cross_daily_metrics WHERE metric_date >= $1`, [fromDate]);

  for (const item of daily.values()) {
    await query(
      `INSERT INTO wb_cross_daily_metrics (nm_id, metric_date, sales_units, revenue, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (nm_id, metric_date) DO UPDATE SET
         sales_units = EXCLUDED.sales_units,
         revenue = EXCLUDED.revenue,
         updated_at = now()`,
      [item.nm_id, item.metric_date, item.sales_units, item.revenue]
    );
  }

  const yesterdayTotal = await refreshYesterdaySalesFromMetrics();

  return {
    accepted: true,
    salesRows: Array.isArray(rows) ? rows.length : 0,
    activeRows: daily.size,
    metricsSaved: daily.size,
    yesterdayProducts: yesterdaySales.size,
    yesterdayTotal
  };
}

async function refreshYesterdaySalesFromMetrics() {
  const yesterdayKey = moscowDateOffset(-1);

  await query("UPDATE wb_cross_products SET yesterday_sales = 0");

  await query(
    `
      UPDATE wb_cross_products p
      SET yesterday_sales = COALESCE(m.sales_units, 0),
          updated_at = now()
      FROM wb_cross_daily_metrics m
      WHERE p.nm_id = m.nm_id
        AND m.metric_date = $1::date
    `,
    [yesterdayKey]
  );

  const result = await query(
    "SELECT COALESCE(SUM(yesterday_sales), 0) AS total FROM wb_cross_products"
  );

  return Number(result.rows[0]?.total || 0);
}

async function sync(options = {}) {
  await ensureSchema();
  const days = Math.max(1, Math.min(90, Number(options.days || 30)));

  const result = { accepted: true, salesFirst: true, errors: [] };

  try {
    Object.assign(result, await syncSales(days));
  } catch (error) {
    result.errors.push({ step: "sales", message: error && error.message ? error.message : String(error) });
  }

  await sleep(1500);

  try {
    Object.assign(result, await syncStocks());
  } catch (error) {
    result.errors.push({ step: "stocks", message: error && error.message ? error.message : String(error) });
    result.stockSyncSkipped = true;
  }

  if (result.errors.some((item) => item.step === "sales")) {
    const error = new Error(result.errors.map((item) => `${item.step}: ${item.message}`).join("; "));
    error.details = result;
    throw error;
  }

  return result;
}

module.exports = {
  ensureSchema,
  dashboard,
  storeMetrics,
  listMetrics,
  refreshYesterdaySalesFromMetrics,
  getWbCrossOfficialCard,
  buildWbCrossUpdatePreview,
  submitWbCrossUpdate,
  updateProduct,
  sync,
  syncStocks,
  syncSales
};
