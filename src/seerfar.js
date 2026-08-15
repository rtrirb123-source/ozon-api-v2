const https = require("https");
const http = require("http");
const { URL } = require("url");
const { config } = require("./config");
const { query } = require("./db");
const products = require("./products");

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/[??%\s]/g, "").replace(/,/g, ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function firstValue(source, keys) {
  const seen = new Set();
  const queue = [source];
  while (queue.length) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(item, key) && item[key] !== null && item[key] !== undefined && item[key] !== "") {
        return item[key];
      }
    }
    for (const value of Object.values(item)) {
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return null;
}

function unwrap(raw) {
  return raw && typeof raw === "object" ? (raw.data || raw.result || raw.item || raw.product || raw) : {};
}

function normalizeCompetitor(raw, { platform = "OZON", sku = "" } = {}) {
  const data = unwrap(raw);
  return {
    platform: String(platform || firstValue(data, ["platform"]) || "OZON").toUpperCase(),
    sku: String(sku || firstValue(data, ["sku", "productSku", "productId", "id", "nmId"]) || "").trim(),
    title: firstValue(data, ["title", "name", "productName"]),
    image_url: firstValue(data, ["imageUrl", "image_url", "image", "mainImage", "cover"]),
    brand: firstValue(data, ["brandName", "brand", "brand_name"]),
    seller_name: firstValue(data, ["sellerName", "seller", "storeName", "shopName"]),
    category_name: firstValue(data, ["categoryName", "category", "categoryInfo", "subjectName"]),
    price: toNumber(firstValue(data, ["price", "salePrice", "finalPrice"])),
    sales_30d: toNumber(firstValue(data, ["sales30d", "sales_30d", "sales", "saleCount", "orderCount"])),
    revenue_30d: toNumber(firstValue(data, ["revenue30d", "revenue_30d", "revenue", "salesAmount", "gmv"])),
    daily_avg_sales: toNumber(firstValue(data, ["dailyAvgSales", "daily_avg_sales", "avgSales", "dayAvgSales"])),
    stock: toNumber(firstValue(data, ["stock", "inventory", "availableStock"])),
    rating: toNumber(firstValue(data, ["reviewRating", "rating", "score"])),
    review_count: toNumber(firstValue(data, ["reviewCount", "review_count", "comments", "feedbacks"])),
    exposure: toNumber(firstValue(data, ["exposure", "exposureCount", "impressions"])),
    card_views: toNumber(firstValue(data, ["cardViews", "card-views", "card_views", "views"])),
    cart_rate: toNumber(firstValue(data, ["cartRate", "cart-rate", "cart_rate", "addToCartRate"])),
    order_conversion_rate: toNumber(firstValue(data, ["orderConvRate", "order-conv-rate", "order_conversion_rate", "conversionRate"])),
    ad_share: toNumber(firstValue(data, ["adShare", "ad-share", "ad_share", "adExpenseShare"])),
    return_cancel_rate: toNumber(firstValue(data, ["returnCancelRate", "return-cancel-rate", "return_cancel_rate"])),
    gross_margin: toNumber(firstValue(data, ["grossMargin", "gross_margin", "margin"])),
    raw_json: raw && typeof raw === "object" ? raw : null
  };
}

function requestJson(pathname, options = {}) {
  if (!config.seerfarCookie && !config.seerfarAuthorization) {
    const error = new Error("SEERFAR_COOKIE or SEERFAR_AUTHORIZATION is required for Seerfar sync");
    error.statusCode = 400;
    throw error;
  }

  const url = new URL(pathname, config.seerfarBaseUrl);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${config.seerfarBaseUrl.replace(/\/$/, "")}/admin/product-detail.html`
  };
  if (config.seerfarCookie) headers.Cookie = config.seerfarCookie;
  if (config.seerfarAuthorization) headers.Authorization = config.seerfarAuthorization;

  const method = String(options.method || "GET").toUpperCase();
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  headers["Client-Language"] = "zh-CN";

  return new Promise((resolve, reject) => {
    const client = url.protocol === "http:" ? http : https;
    const req = client.request(url, { method, headers, timeout: 60000 }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Seerfar HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw || "{}"));
        } catch (error) {
          reject(new Error(`Seerfar JSON parse failed: ${error.message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("Seerfar API timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function extractTrackedSkus(text = "") {
  return String(text).split(/[；;\n]+/).map((segment) => segment.match(/\b(\d{8,12})\b/)?.[1]).filter(Boolean);
}

function buildMonitorRequest({ dateRange = "past_7_days", pageNumber = 1, pageSize = 100 } = {}) {
  return {
    dateRange,
    page: {
      pageNumber: Math.max(1, Number(pageNumber) || 1),
      pageSize: Math.min(100, Math.max(1, Number(pageSize) || 100)),
      orders: [{ field: "addMonitorTime", direction: "DESC" }]
    }
  };
}

async function trackedSkuSet() {
  const trackedProducts = await products.listDailyTrackedProducts();
  return new Set(trackedProducts.flatMap((row) => extractTrackedSkus(row.competitor_compare)));
}

async function syncMonitorCompetitors({ platform = "OZON", dateRange = config.seerfarMonitorDateRange, pageSize = 100 } = {}) {
  await ensureSchema();
  const wanted = await trackedSkuSet();
  if (wanted.size === 0) {
    return {
      source: "seerfar_package_monitor",
      platform,
      dateRange,
      monitoredTotal: 0,
      trackedTotal: 0,
      recordsRead: 0,
      matched: 0,
      updated: 0,
      ready: 0,
      pending: 0,
      pages: 0
    };
  }
  let pageNumber = 1;
  let total = 0;
  let seen = 0;
  let matched = 0;
  let ready = 0;
  const updatedSkus = new Set();

  do {
    const response = await requestJson(`/product-report/productMonitor/report/search/${encodeURIComponent(platform)}`, {
      method: "POST",
      body: buildMonitorRequest({ dateRange, pageNumber, pageSize })
    });
    if (Number(response.code) !== 200 || !response.data) {
      throw new Error(`Seerfar monitor response failed: ${response.msg || response.message || response.code || "unknown"}`);
    }
    const records = Array.isArray(response.data.records) ? response.data.records : [];
    total = Number(response.data.total) || records.length;
    seen += records.length;
    for (const raw of records) {
      const normalized = normalizeCompetitor(raw, { platform });
      if (!normalized.sku || !wanted.has(normalized.sku)) continue;
      matched += 1;
      if (normalized.price !== null || normalized.sales_30d !== null || normalized.revenue_30d !== null) ready += 1;
      await upsertCompetitor({ platform, sku: normalized.sku, raw, source: "seerfar_monitor" });
      updatedSkus.add(normalized.sku);
    }
    if (!records.length) break;
    pageNumber += 1;
  } while (seen < total && pageNumber <= 50);

  return {
    source: "seerfar_package_monitor",
    platform,
    dateRange,
    monitoredTotal: total,
    trackedTotal: wanted.size,
    recordsRead: seen,
    matched,
    updated: updatedSkus.size,
    ready,
    pending: Math.max(0, updatedSkus.size - ready),
    pages: pageNumber - 1
  };
}

async function monitorStatus() {
  await ensureSchema();
  const wanted = await trackedSkuSet();
  const result = await query(`
    SELECT sku, price, sales_30d, revenue_30d, stock, rating, review_count, fetched_at
    FROM seerfar_competitors
    WHERE platform = 'OZON' AND source = 'seerfar_monitor'
  `);
  const rows = result.rows.filter((row) => wanted.has(String(row.sku)));
  const ready = rows.filter((row) => row.price !== null || row.sales_30d !== null || row.revenue_30d !== null).length;
  const latest = rows.reduce((value, row) => {
    const time = row.fetched_at ? new Date(row.fetched_at).getTime() : 0;
    return time > value ? time : value;
  }, 0);
  const syncedSkus = new Set(rows.map((row) => String(row.sku)));
  return {
    configured: Boolean(config.seerfarCookie || config.seerfarAuthorization),
    source: "seerfar_package_monitor",
    trackedTotal: wanted.size,
    synced: rows.length,
    ready,
    pending: Math.max(0, rows.length - ready),
    coverage: wanted.size ? Number((rows.length / wanted.size * 100).toFixed(1)) : 0,
    latestFetchedAt: latest ? new Date(latest).toISOString() : null,
    missingSkus: [...wanted].filter((sku) => !syncedSkus.has(sku)).sort(),
    collectionBlockedReason: !(config.seerfarCookie || config.seerfarAuthorization)
      ? "服务器未配置 Seerfar 只读授权"
      : wanted.size === 0
        ? "尚未配置需要监控的竞品SKU"
        : null,
    paidOpenApiUsed: false
  };
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS seerfar_competitors (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL DEFAULT 'OZON',
      sku TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'seerfar',
      title TEXT,
      image_url TEXT,
      brand TEXT,
      seller_name TEXT,
      category_name TEXT,
      price NUMERIC,
      sales_30d NUMERIC,
      revenue_30d NUMERIC,
      daily_avg_sales NUMERIC,
      stock NUMERIC,
      rating NUMERIC,
      review_count NUMERIC,
      exposure NUMERIC,
      card_views NUMERIC,
      cart_rate NUMERIC,
      order_conversion_rate NUMERIC,
      ad_share NUMERIC,
      return_cancel_rate NUMERIC,
      gross_margin NUMERIC,
      raw_json JSONB,
      fetched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (platform, sku)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS product_competitor_links (
      id BIGSERIAL PRIMARY KEY,
      offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
      competitor_id BIGINT NOT NULL REFERENCES seerfar_competitors (id) ON DELETE CASCADE,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (offer_id, competitor_id)
    )
  `);
}

async function upsertCompetitor(input) {
  await ensureSchema();
  const row = normalizeCompetitor(input.raw || input.snapshot || input, input);
  if (!row.sku) {
    const error = new Error("competitor sku is required");
    error.statusCode = 400;
    throw error;
  }
  const result = await query(
    `INSERT INTO seerfar_competitors (
       platform, sku, source, title, image_url, brand, seller_name, category_name,
       price, sales_30d, revenue_30d, daily_avg_sales, stock, rating, review_count,
       exposure, card_views, cart_rate, order_conversion_rate, ad_share, return_cancel_rate,
       gross_margin, raw_json, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
     ON CONFLICT (platform, sku) DO UPDATE SET
       source = EXCLUDED.source,
       title = COALESCE(EXCLUDED.title, seerfar_competitors.title),
       image_url = COALESCE(EXCLUDED.image_url, seerfar_competitors.image_url),
       brand = COALESCE(EXCLUDED.brand, seerfar_competitors.brand),
       seller_name = COALESCE(EXCLUDED.seller_name, seerfar_competitors.seller_name),
       category_name = COALESCE(EXCLUDED.category_name, seerfar_competitors.category_name),
       price = COALESCE(EXCLUDED.price, seerfar_competitors.price),
       sales_30d = COALESCE(EXCLUDED.sales_30d, seerfar_competitors.sales_30d),
       revenue_30d = COALESCE(EXCLUDED.revenue_30d, seerfar_competitors.revenue_30d),
       daily_avg_sales = COALESCE(EXCLUDED.daily_avg_sales, seerfar_competitors.daily_avg_sales),
       stock = COALESCE(EXCLUDED.stock, seerfar_competitors.stock),
       rating = COALESCE(EXCLUDED.rating, seerfar_competitors.rating),
       review_count = COALESCE(EXCLUDED.review_count, seerfar_competitors.review_count),
       exposure = COALESCE(EXCLUDED.exposure, seerfar_competitors.exposure),
       card_views = COALESCE(EXCLUDED.card_views, seerfar_competitors.card_views),
       cart_rate = COALESCE(EXCLUDED.cart_rate, seerfar_competitors.cart_rate),
       order_conversion_rate = COALESCE(EXCLUDED.order_conversion_rate, seerfar_competitors.order_conversion_rate),
       ad_share = COALESCE(EXCLUDED.ad_share, seerfar_competitors.ad_share),
       return_cancel_rate = COALESCE(EXCLUDED.return_cancel_rate, seerfar_competitors.return_cancel_rate),
       gross_margin = COALESCE(EXCLUDED.gross_margin, seerfar_competitors.gross_margin),
       raw_json = COALESCE(EXCLUDED.raw_json, seerfar_competitors.raw_json),
       fetched_at = EXCLUDED.fetched_at
     RETURNING *`,
    [
      row.platform, row.sku, input.source || "seerfar", row.title, row.image_url, row.brand, row.seller_name, row.category_name,
      row.price, row.sales_30d, row.revenue_30d, row.daily_avg_sales, row.stock, row.rating, row.review_count,
      row.exposure, row.card_views, row.cart_rate, row.order_conversion_rate, row.ad_share, row.return_cancel_rate,
      row.gross_margin, row.raw_json ? JSON.stringify(row.raw_json) : null
    ]
  );
  return result.rows[0];
}

async function linkCompetitor(offerId, competitorId, notes = "") {
  await ensureSchema();
  const result = await query(
    `INSERT INTO product_competitor_links (offer_id, competitor_id, notes)
     VALUES ($1, $2, $3)
     ON CONFLICT (offer_id, competitor_id) DO UPDATE SET notes = COALESCE(EXCLUDED.notes, product_competitor_links.notes)
     RETURNING *`,
    [offerId, competitorId, notes || null]
  );
  return result.rows[0];
}

async function syncCompetitor({ offer_id, sku, platform = "OZON", dateRange = "past_30_days", raw, snapshot, notes = "" }) {
  await ensureSchema();
  let sourceRaw = raw || snapshot || null;
  let synced = false;
  let message = "linked only";
  if (!sourceRaw && (config.seerfarCookie || config.seerfarAuthorization)) {
    sourceRaw = await requestJson(`/product-report/product/detail/search/${encodeURIComponent(sku)}?platform=${encodeURIComponent(platform)}&dateRange=${encodeURIComponent(dateRange)}`);
    synced = true;
    message = "synced from Seerfar";
  } else if (!sourceRaw) {
    message = "missing Seerfar session config; saved competitor link only";
  }

  const competitor = await upsertCompetitor({ platform, sku, raw: sourceRaw || { sku, platform }, source: "seerfar" });
  let link = null;
  if (offer_id) link = await linkCompetitor(String(offer_id), competitor.id, notes);
  const insights = offer_id ? await getInsights(String(offer_id)) : null;
  return { competitor, link, insights, synced, message };
}

function buildDiagnosis(product, competitors) {
  const notes = [];
  const primary = competitors[0];
  const price = toNumber(product && product.price);
  const compPrice = toNumber(primary && primary.price);
  if (!competitors.length) notes.push("No Seerfar competitor SKU is linked yet. Add 1-3 direct competitors first.");
  if (price && compPrice) {
    if (price > compPrice * 1.08) notes.push(`Current price is about ${Math.round((price / compPrice - 1) * 100)}% higher than the main competitor. Check image, reviews, and selling points before keeping the premium.`);
    else if (price < compPrice * 0.9) notes.push("Current price is much lower than the main competitor. Check margin before trading profit for sales.");
    else notes.push("Current price is close to the main competitor. Prioritize image, keywords, and conversion before price changes.");
  }
  if (primary && toNumber(primary.exposure) && toNumber(primary.card_views)) {
    const viewRate = toNumber(primary.card_views) / Math.max(1, toNumber(primary.exposure));
    if (viewRate < 0.18) notes.push("Competitor exposure-to-card-view rate is low. Review main image, title opening, and price anchor.");
  }
  if (primary && toNumber(primary.cart_rate) && toNumber(primary.order_conversion_rate)) {
    if (toNumber(primary.cart_rate) > 5 && toNumber(primary.order_conversion_rate) < 8) notes.push("Competitor has add-to-cart interest but weak order conversion. Review price, delivery, reviews, and trust signals.");
  }
  if (product && !product.image_url) notes.push("This product has no image. Fix the main image before comparing conversion.");
  if (product && !product.competitor_compare) notes.push("Competitor comparison is empty. Add competitor SKU, price gap, and key selling-point differences.");
  return notes;
}

async function getInsights(offerId) {
  await ensureSchema();
  const product = await products.getProduct(offerId);
  if (!product) {
    const error = new Error("Product not found");
    error.statusCode = 404;
    throw error;
  }
  const result = await query(
    `SELECT c.*, l.notes, l.created_at AS linked_at
     FROM product_competitor_links l
     JOIN seerfar_competitors c ON c.id = l.competitor_id
     WHERE l.offer_id = $1
     ORDER BY c.fetched_at DESC NULLS LAST, l.updated_at DESC`,
    [offerId]
  );
  const competitors = result.rows;
  return { product, competitors, diagnosis: buildDiagnosis(product, competitors) };
}

module.exports = {
  buildMonitorRequest,
  ensureSchema,
  extractTrackedSkus,
  getInsights,
  monitorStatus,
  normalizeCompetitor,
  syncCompetitor,
  syncMonitorCompetitors,
  upsertCompetitor
};
