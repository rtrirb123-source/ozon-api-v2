const https = require("https");
const { config } = require("./config");
const { query, getPool } = require("./db");

const cache = { payload: null, fetchedAt: 0 };
const refreshState = globalThis.__inventoryRefreshState || (globalThis.__inventoryRefreshState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastOkAt: null,
  lastError: ""
});
const CACHE_MS = 4 * 60 * 1000;
// Keep the FBW field and total formula ready, but do not expose historical values
// until a current, reliable WB warehouse source is explicitly connected.
const FBW_STOCK_SOURCE_ENABLED = process.env.WB_FBW_RELIABLE_SOURCE_ENABLED === "1";
const wbSourceCache = globalThis.__inventoryWbSourceCache || (globalThis.__inventoryWbSourceCache = { wb: null, wb_cross: null });

function requestJson({ host, path, method = "GET", headers = {}, body, timeout = 120000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const finalHeaders = { Accept: "application/json", ...headers };
    if (payload) {
      finalHeaders["Content-Type"] = "application/json";
      finalHeaders["Content-Length"] = Buffer.byteLength(payload);
    }
    const req = https.request({ hostname: host, path, method, headers: finalHeaders, timeout }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try {
          data = raw ? JSON.parse(raw) : null;
        } catch (error) {
          error.statusCode = 502;
          error.details = raw.slice(0, 500);
          reject(error);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(data?.message || data?.title || `HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.details = data;
          error.retryAfter = Number(res.headers['retry-after'] || 0);
          reject(error);
          return;
        }
        resolve(data);
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJsonWithBackoff(options, attempts = 8, label = "wb") {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(options);
    } catch (error) {
      lastError = error;
      const statusCode = Number(error.statusCode || 0);
      const retryable = statusCode === 429 || (statusCode >= 500 && statusCode <= 504);
      if (!retryable || attempt === attempts) throw error;
      const retryAfter = Number(error.retryAfter || 0);
      const delaySeconds = statusCode === 429
        ? (retryAfter > 0
          ? Math.max(8, Math.min(180, retryAfter))
          : Math.min(120, 15 * (2 ** (attempt - 1))))
        : Math.min(30, 3 * attempt);
      console.warn(`[inventory:${label}] HTTP ${statusCode}, retry ${attempt}/${attempts} after ${delaySeconds}s`);
      await sleep(delaySeconds * 1000);
    }
  }
  throw lastError;
}

function sellerWarehouseKey(name) {
  const value = String(name || "");
  if (value.includes("林挺")) return "linting";
  if (value.includes("世晟")) return "shisheng";
  return "";
}

async function persistSellerWarehouseStock(market, byNm) {
  for (const [compound, item] of byNm.entries()) {
    const nmId = String(compound).split(":").slice(1).join(":");
    const totals = new Map();
    for (const warehouse of item.warehouses || []) {
      const key = sellerWarehouseKey(warehouse.warehouse_name);
      if (key) totals.set(key, Number(totals.get(key) || 0) + Number(warehouse.amount || 0));
    }
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

function rows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.warehouses)) return data.warehouses;
  if (Array.isArray(data?.orders)) return data.orders;
  if (Array.isArray(data?.stocks)) return data.stocks;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_hidden_products (
      offer_id TEXT PRIMARY KEY REFERENCES products (offer_id) ON DELETE CASCADE,
      hidden BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_product_links (
      id BIGSERIAL PRIMARY KEY,
      offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
      market TEXT NOT NULL CHECK (market IN ('wb', 'wb_cross')),
      nm_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (offer_id, market, nm_id)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS inventory_product_links_offer_idx ON inventory_product_links (offer_id)`);
  await query(`CREATE INDEX IF NOT EXISTS inventory_product_links_market_nm_idx ON inventory_product_links (market, nm_id)`);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_product_barcodes (
      offer_id TEXT PRIMARY KEY REFERENCES products (offer_id) ON DELETE CASCADE,
      barcode TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_manual_warehouse_fbs_stock (
      offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
      warehouse_key TEXT NOT NULL CHECK (warehouse_key IN ('linting', 'shisheng')),
      manual_stock NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (offer_id, warehouse_key)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_wb_card_warehouse_stock (
      market TEXT NOT NULL CHECK (market IN ('wb', 'wb_cross')),
      nm_id TEXT NOT NULL,
      warehouse_key TEXT NOT NULL CHECK (warehouse_key IN ('linting', 'shisheng')),
      stock NUMERIC NOT NULL DEFAULT 0,
      source_note TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (market, nm_id, warehouse_key)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_manual_fbs_stock (
      offer_id TEXT PRIMARY KEY REFERENCES products (offer_id) ON DELETE CASCADE,
      manual_fbs_stock NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_manual_first_leg_transit (
      offer_id TEXT PRIMARY KEY,
      quantity NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_first_leg_transit_lines (
      id BIGSERIAL PRIMARY KEY,
      source_file TEXT NOT NULL,
      source_sheet TEXT NOT NULL DEFAULT '',
      source_row INTEGER NOT NULL DEFAULT 0,
      box_mark TEXT NOT NULL DEFAULT '',
      normalized_box_mark TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL,
      normalized_sku TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS inventory_first_leg_transit_lines_sku_idx ON inventory_first_leg_transit_lines (normalized_sku)`);
  await query(`CREATE INDEX IF NOT EXISTS inventory_first_leg_transit_lines_box_idx ON inventory_first_leg_transit_lines (normalized_box_mark)`);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_unallocated_stock_lines (
      id BIGSERIAL PRIMARY KEY,
      source_file TEXT NOT NULL,
      source_sheet TEXT NOT NULL DEFAULT '',
      source_row INTEGER NOT NULL DEFAULT 0,
      box_mark TEXT NOT NULL DEFAULT '',
      box_numbers TEXT NOT NULL DEFAULT '',
      sku TEXT NOT NULL,
      product_name TEXT NOT NULL DEFAULT '',
      normalized_sku TEXT NOT NULL,
      per_box_qty NUMERIC NOT NULL DEFAULT 0,
      box_count INTEGER NOT NULL DEFAULT 0,
      pieces NUMERIC NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE inventory_unallocated_stock_lines ADD COLUMN IF NOT EXISTS product_name TEXT NOT NULL DEFAULT ''`);
  await query(`CREATE INDEX IF NOT EXISTS inventory_unallocated_stock_sku_idx ON inventory_unallocated_stock_lines (normalized_sku)`);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_unallocated_sync_log (
      id BIGSERIAL PRIMARY KEY,
      file_count INTEGER NOT NULL DEFAULT 0,
      line_count INTEGER NOT NULL DEFAULT 0,
      box_count INTEGER NOT NULL DEFAULT 0,
      piece_count NUMERIC NOT NULL DEFAULT 0,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_manual_warehouse_actual_stock (
      offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
      warehouse_key TEXT NOT NULL CHECK (warehouse_key IN ('linting', 'shisheng')),
      manual_stock NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (offer_id, warehouse_key)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_manual_daily_shipments (
      offer_id TEXT NOT NULL REFERENCES products (offer_id) ON DELETE CASCADE,
      warehouse_key TEXT NOT NULL CHECK (warehouse_key IN ('linting', 'shisheng')),
      shipment_date DATE NOT NULL,
      manual_quantity NUMERIC NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (offer_id, warehouse_key, shipment_date)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_wb_stock_snapshots (
      market TEXT PRIMARY KEY CHECK (market IN ('wb', 'wb_cross')),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_ozon_stock_snapshot (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function serializeWbStockSource(value) {
  return {
    warehouses: Array.isArray(value?.warehouses) ? value.warehouses : [],
    statsWarehouses: Array.isArray(value?.statsWarehouses) ? value.statsWarehouses : [],
    byNm: Array.from(value?.byNm instanceof Map ? value.byNm.entries() : [])
  };
}

function hydrateWbStockSource(payload, updatedAt = null) {
  const value = payload && typeof payload === "object" ? payload : {};
  return {
    warehouses: Array.isArray(value.warehouses) ? value.warehouses : [],
    statsWarehouses: Array.isArray(value.statsWarehouses) ? value.statsWarehouses : [],
    byNm: new Map(Array.isArray(value.byNm) ? value.byNm : []),
    fromCache: true,
    cacheUpdatedAt: updatedAt
  };
}

async function saveWbStockSnapshot(market, value) {
  await query(`
    INSERT INTO inventory_wb_stock_snapshots (market, payload, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (market) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
  `, [market, JSON.stringify(serializeWbStockSource(value))]);
}

async function loadWbStockSnapshot(market) {
  const result = await query(
    `SELECT payload, updated_at FROM inventory_wb_stock_snapshots WHERE market = $1`,
    [market]
  );
  if (!result.rows[0]) return null;
  return hydrateWbStockSource(result.rows[0].payload, result.rows[0].updated_at);
}

function serializeOzonStockMap(value) {
  return Array.from(value instanceof Map ? value.entries() : []);
}

function hydrateOzonStockMap(payload, updatedAt = null) {
  const map = new Map(Array.isArray(payload) ? payload : []);
  map.fromCache = true;
  map.cacheUpdatedAt = updatedAt;
  return map;
}

async function saveOzonStockSnapshot(value) {
  await query(`
    INSERT INTO inventory_ozon_stock_snapshot (id, payload, updated_at)
    VALUES (1, $1::jsonb, NOW())
    ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
  `, [JSON.stringify(serializeOzonStockMap(value))]);
}

async function loadOzonStockSnapshot() {
  const result = await query(`SELECT payload, updated_at FROM inventory_ozon_stock_snapshot WHERE id = 1`);
  if (!result.rows[0]) return null;
  return hydrateOzonStockMap(result.rows[0].payload, result.rows[0].updated_at);
}

async function refreshOzonStockSnapshot() {
  await ensureSchema();
  const allProducts = await listProducts(true);
  const ozonProducts = allProducts.filter((item) =>
    item.source_market === "ozon" && String(item.ozon_sku || "").trim()
  );
  const value = await fetchOzonWarehouseStocks(ozonProducts);
  await saveOzonStockSnapshot(value);
  cache.payload = null;
  const totals = Array.from(value.values()).reduce((result, item) => {
    result.available += Number(item.totalAvailable || 0);
    result.transit += Number(item.totalTransit || 0);
    return result;
  }, { available: 0, transit: 0 });
  return {
    products: ozonProducts.length,
    mapped_products: value.size,
    available_total: totals.available,
    transit_total: totals.transit,
    updated_at: new Date().toISOString()
  };
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenSet(value) {
  return new Set(normalizeText(value).split(/\s+/).filter((item) => item.length >= 2));
}

function commonTokenScore(a, b) {
  const left = tokenSet(a);
  const right = tokenSet(b);
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.max(left.size, right.size);
}

function compactCode(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchScore(ozon, wb) {
  let score = 0;
  const offer = compactCode(ozon.offer_id);
  const wbVendor = compactCode(wb.vendor_code);
  const wbNm = compactCode(wb.nm_id);
  if (offer && wbVendor && offer === wbVendor) score += 100;
  if (offer && wbVendor && (offer.includes(wbVendor) || wbVendor.includes(offer))) score += 45;
  if (offer && wbNm && offer === wbNm) score += 30;
  score += commonTokenScore(ozon.title || ozon.offer_id, `${wb.title || ""} ${wb.vendor_code || ""}`) * 50;
  if (ozon.image_url && wb.image_url) score += 3;
  return Math.round(score);
}

function buildCandidates(ozon, products, market, linkedSet) {
  return products
    .map((item) => ({
      market,
      nm_id: String(item.nm_id),
      vendor_code: item.vendor_code || "",
      title: item.title || item.vendor_code || item.nm_id,
      image_url: item.image_url || "",
      stock: Number(item.stock || 0),
      fbs_stock: Number(item.fbs_stock || 0),
      score: matchScore(ozon, item),
      linked: linkedSet.has(`${market}:${item.nm_id}`)
    }))
    .filter((item) => item.score > 0 || item.linked)
    .sort((a, b) => Number(b.linked) - Number(a.linked) || b.score - a.score)
    .slice(0, 10);
}

async function listProducts(showHidden = false) {
  const hiddenResult = await query(`SELECT offer_id FROM inventory_hidden_products WHERE hidden = true`);
  const hidden = new Set(hiddenResult.rows.map((row) => String(row.offer_id)));
  const result = await query(`
    SELECT offer_id, product_id, ozon_sku, title, image_url, fbo_stock, fbs_stock, updated_at
    FROM products
    ORDER BY COALESCE(fbo_stock, 0) + COALESCE(fbs_stock, 0) DESC, updated_at DESC, id DESC
  `);
  return result.rows
    .filter((item) => showHidden || !hidden.has(String(item.offer_id)))
    .map((item) => {
      const offerId = String(item.offer_id || "");
      const sourceMarket = offerId.startsWith("WBLOCAL-") ? "wb" : offerId.startsWith("WBCROSS-") ? "wb_cross" : "ozon";
      return {
        ...item,
        source_market: sourceMarket,
        source_label: sourceMarket === "wb" ? "WB本土" : sourceMarket === "wb_cross" ? "WB跨境" : "Ozon",
        hidden: hidden.has(offerId)
      };
    });
}

async function listWbProducts(table) {
  const result = await query(`
    SELECT nm_id, vendor_code, title, image_url, stock, fbs_stock, fbw_stock, updated_at
    FROM ${table}
    ORDER BY COALESCE(stock, 0) DESC, updated_at DESC, id DESC
  `);
  return result.rows;
}

async function listLinks() {
  // Oldest mapping is the stable owner when one WB card is linked to multiple inventory SKUs.
  const result = await query(`SELECT id, offer_id, market, nm_id FROM inventory_product_links ORDER BY id ASC`);
  return result.rows;
}

async function listBarcodes() {
  const result = await query(`SELECT offer_id, barcode FROM inventory_product_barcodes`);
  return result.rows;
}

async function listWbCardWarehouseStock() {
  const result = await query(`
    SELECT market, nm_id, warehouse_key, stock, source_note, updated_at
    FROM inventory_wb_card_warehouse_stock
  `);
  return result.rows;
}

async function listManualFirstLegTransit() {
  const result = await query(`SELECT offer_id, quantity FROM inventory_manual_first_leg_transit`);
  return result.rows;
}

async function listManualFbsStock() {
  const result = await query(`SELECT offer_id, manual_fbs_stock FROM inventory_manual_fbs_stock`);
  return result.rows;
}

async function listManualWarehouseFbsStock() {
  const result = await query(`SELECT offer_id, warehouse_key, manual_stock FROM inventory_manual_warehouse_fbs_stock`);
  return result.rows;
}

async function listManualWarehouseActualStock() {
  const result = await query(`SELECT offer_id, warehouse_key, manual_stock FROM inventory_manual_warehouse_actual_stock`);
  return result.rows;
}

function chinaDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value);
}

async function listManualDailyShipments(date = chinaDate()) {
  const result = await query(`
    SELECT offer_id, warehouse_key, shipment_date, manual_quantity
    FROM inventory_manual_daily_shipments
    WHERE shipment_date = $1::date
  `, [date]);
  return result.rows;
}

function addAmount(map, key, amount) {
  map.set(key, Number(map.get(key) || 0) + Number(amount || 0));
}

async function fetchOzonWarehouseStocks(products) {
  const byOffer = new Map();
  const skuToOffer = new Map();
  for (const item of products) {
    if (item.ozon_sku) skuToOffer.set(String(item.ozon_sku), String(item.offer_id));
    byOffer.set(String(item.offer_id), { totalAvailable: 0, totalTransit: 0, warehouses: [] });
  }
  const skus = Array.from(skuToOffer.keys());
  if (!skus.length || !config.ozonClientId || !config.ozonApiKey) return byOffer;

  const headers = { "Client-Id": config.ozonClientId, "Api-Key": config.ozonApiKey };
  const raw = new Map();
  const chunkSize = 20;
  for (let index = 0; index < skus.length; index += chunkSize) {
    const chunk = skus.slice(index, index + chunkSize);
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const response = await requestJsonWithBackoff({
        host: "api-seller.ozon.ru",
        path: "/v1/analytics/stocks",
        method: "POST",
        headers,
        body: { skus: chunk, limit: 1000, offset }
      }, 6, "ozon");
      const items = rows(response);
      for (const row of items) {
        const offerId = skuToOffer.get(String(row.sku || ""));
        if (!offerId) continue;
        const key = `${offerId}|${row.warehouse_id || 0}|${row.warehouse_name || ""}|${row.cluster_name || ""}`;
        const current = raw.get(key) || {
          offer_id: offerId,
          warehouse_id: row.warehouse_id || 0,
          warehouse_name: row.warehouse_name || "",
          cluster_name: row.cluster_name || "",
          available: 0,
          requested: 0,
          transit: 0,
          valid: 0
        };
        current.available += Number(row.available_stock_count || 0);
        current.requested += Number(row.requested_stock_count || 0);
        current.transit += Number(row.transit_stock_count || 0);
        current.valid += Number(row.valid_stock_count || 0);
        raw.set(key, current);
      }
      if (items.length < 1000) break;
      offset += 1000;
    }
  }

  for (const row of raw.values()) {
    const summary = byOffer.get(row.offer_id) || { totalAvailable: 0, totalTransit: 0, warehouses: [] };
    summary.totalAvailable += Number(row.available || 0);
    summary.totalTransit += Number(row.transit || 0);
    summary.warehouses.push(row);
    byOffer.set(row.offer_id, summary);
  }
  for (const summary of byOffer.values()) {
    summary.warehouses.sort((a, b) => b.available - a.available);
  }
  return byOffer;
}

async function fetchWbStockSource({ market, token }) {
  if (!token) return { warehouses: [], byNm: new Map(), statsWarehouses: [] };
  const statsRows = rows(await requestJsonWithBackoff({
    host: "statistics-api.wildberries.ru",
    path: "/api/v1/supplier/stocks?dateFrom=2019-01-01",
    headers: { Authorization: token },
    timeout: 180000
  }));

  const barcodeToNm = new Map();
  const statsWh = new Map();
  for (const row of statsRows) {
    const nmId = String(row.nmId || row.nmID || row.nmid || "");
    if (row.barcode && nmId) barcodeToNm.set(String(row.barcode), nmId);
    addAmount(statsWh, String(row.warehouseName || row.warehouse_name || "UNKNOWN"), row.quantity || row.quantityFull || 0);
  }
  const statsWarehouses = Array.from(statsWh.entries())
    .map(([warehouse_name, quantity]) => ({ warehouse_name, name: warehouse_name, quantity }))
    .sort((a, b) => b.quantity - a.quantity);

  const sellerWarehouses = rows(await requestJsonWithBackoff({
    host: "marketplace-api.wildberries.ru",
    path: "/api/v3/warehouses",
    headers: { Authorization: token }
  }));
  const barcodes = Array.from(barcodeToNm.keys());
  const byNm = new Map();
  for (const warehouse of sellerWarehouses) {
    for (let index = 0; index < barcodes.length; index += 1000) {
      const chunk = barcodes.slice(index, index + 1000);
      if (!chunk.length) continue;
      const response = await requestJsonWithBackoff({
        host: "marketplace-api.wildberries.ru",
        path: `/api/v3/stocks/${encodeURIComponent(warehouse.id)}`,
        method: "POST",
        headers: { Authorization: token },
        body: { skus: chunk },
        timeout: 180000
      });
      for (const row of rows(response)) {
        const nmId = barcodeToNm.get(String(row.sku || ""));
        if (!nmId) continue;
        const key = `${market}:${nmId}`;
        const current = byNm.get(key) || { total: 0, warehouses: [] };
        const amount = Number(row.amount || 0);
        current.total += amount;
        if (amount > 0) current.warehouses.push({
          warehouse_id: warehouse.id,
          warehouse_name: warehouse.name,
          office_id: warehouse.officeId,
          sku: row.sku,
          chrt_id: row.chrtId,
          amount,
          source: "seller_warehouse_api"
        });
        byNm.set(key, current);
      }
    }
  }
  for (const item of byNm.values()) item.warehouses.sort((a, b) => b.amount - a.amount);
  await persistSellerWarehouseStock(market, byNm);
  return { warehouses: sellerWarehouses, byNm, statsWarehouses };
}

async function safeInventorySource(label, fallback, fn) {
  try {
    const value = await fn();
    if (label === "wb" || label === "wb_cross") {
      wbSourceCache[label] = value;
      await saveWbStockSnapshot(label, value);
    }
    if (label === "ozon") {
      await saveOzonStockSnapshot(value);
    }
    return value;
  } catch (error) {
    console.warn("[inventory:" + label + "]", error.message);
    let cached = (label === "wb" || label === "wb_cross") ? wbSourceCache[label] : null;
    if (!cached && (label === "wb" || label === "wb_cross")) {
      try {
        cached = await loadWbStockSnapshot(label);
        if (cached) wbSourceCache[label] = cached;
      } catch (cacheError) {
        console.warn("[inventory:" + label + ":cache]", cacheError.message);
      }
    }
    if (!cached && label === "ozon") {
      try {
        cached = await loadOzonStockSnapshot();
      } catch (cacheError) {
        console.warn("[inventory:" + label + ":cache]", cacheError.message);
      }
    }
    if (cached) {
      if (cached instanceof Map) {
        cached.error = error.message;
        cached.fromCache = true;
        return cached;
      }
      return { ...cached, error: error.message, fromCache: true };
    }
    if (fallback instanceof Map) {
      fallback.error = error.message;
      return fallback;
    }
    return { ...fallback, error: error.message };
  }
}

function inferFallbackWarehouseName(offerId, manualWarehouseByOffer, ozonByOffer) {
  const manual = manualWarehouseByOffer.get(String(offerId)) || {};
  const ozonFbs = Number(ozonByOffer.get(String(offerId))?.fbs_stock || 0);
  const linting = Number(manual.linting || 0) - ozonFbs;
  const shisheng = Number(manual.shisheng || 0);
  if (shisheng > 0 && linting <= 0) return "世晟";
  if (linting > 0 && shisheng <= 0) return "林挺";
  if (shisheng > linting) return "世晟";
  return "林挺";
}

function enrichLinkStock(links, wbLocalStock, wbCrossStock, wbProducts = [], wbCrossProducts = [], manualWarehouseByOffer = new Map(), ozonByOffer = new Map(), wbCardWarehouseByKey = new Map()) {
  const byOffer = new Map();
  const productMaps = {
    wb: new Map(wbProducts.map((item) => [String(item.nm_id), item])),
    wb_cross: new Map(wbCrossProducts.map((item) => [String(item.nm_id), item]))
  };
  const fbwOwnerByCard = new Map();
  for (const link of links) {
    const cardKey = `${link.market}:${link.nm_id}`;
    if (!fbwOwnerByCard.has(cardKey)) fbwOwnerByCard.set(cardKey, String(link.offer_id));
  }
  for (const link of links) {
    const offerId = String(link.offer_id);
    const current = byOffer.get(offerId) || { wb: 0, wb_cross: 0, links: [] };
    const stock = link.market === "wb"
      ? wbLocalStock.byNm.get(`wb:${link.nm_id}`)
      : wbCrossStock.byNm.get(`wb_cross:${link.nm_id}`);
    const product = productMaps[link.market]?.get(String(link.nm_id)) || {};
    const cardKey = `${link.market}:${link.nm_id}`;
    const rawFbwStock = Number(product.fbw_stock || 0);
    const ownsFbwStock = fbwOwnerByCard.get(cardKey) === offerId;
    const effectiveFbwStock = FBW_STOCK_SOURCE_ENABLED && ownsFbwStock ? rawFbwStock : 0;
    const apiAmount = Number(stock?.total || 0);
    const fallbackAmount = Math.max(
      Number(product.fbs_stock || 0),
      Number(product.fbs_stock || 0) + effectiveFbwStock
    );
    const manualCardWarehouses = wbCardWarehouseByKey.get(cardKey) || [];
    const manualCardAmount = manualCardWarehouses.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    // The scheduled seller-warehouse sync writes the freshest per-card values to
    // inventory_wb_card_warehouse_stock. Prefer those rows over legacy snapshots.
    const hasCardWarehouseStock = manualCardWarehouses.length > 0;
    const hasApiStock = Boolean(stock);
    const amount = hasCardWarehouseStock
      ? manualCardAmount
      : (hasApiStock ? apiAmount : fallbackAmount);
    const warehouses = hasCardWarehouseStock
      ? manualCardWarehouses
      : (hasApiStock
      ? (Array.isArray(stock.warehouses) ? stock.warehouses : [])
      : (fallbackAmount > 0 ? [{
          warehouse_id: "fallback",
          warehouse_name: inferFallbackWarehouseName(offerId, manualWarehouseByOffer, ozonByOffer),
          warehouse_key: inferFallbackWarehouseName(offerId, manualWarehouseByOffer, ozonByOffer) === "世晟" ? "shisheng" : "linting",
          amount: fallbackAmount,
          source: "product_stock",
          stock: Number(product.fbs_stock || 0) + effectiveFbwStock,
          fbs_stock: Number(product.fbs_stock || 0),
          fbw_stock: effectiveFbwStock
        }] : []));
    current[link.market] += amount;
    current.links.push({
      ...link,
      vendor_code: product.vendor_code || link.vendor_code || "",
      title: product.title || link.title || "",
      image_url: product.image_url || "",
      stock: Number(product.fbs_stock || 0) + effectiveFbwStock,
      fbs_stock: amount,
      table_fbs_stock: Number(product.fbs_stock || 0),
      raw_fbw_stock: rawFbwStock,
      fbw_stock: effectiveFbwStock,
      fbw_owner: ownsFbwStock,
      fbw_source_enabled: FBW_STOCK_SOURCE_ENABLED,
      warehouses
    });
    byOffer.set(offerId, current);
  }
  return byOffer;
}

function normalizeInventorySku(value) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

function normalizeBoxMark(value) {
  return String(value || "").replace(/\s+/g, "").trim().toUpperCase();
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row && row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") return row[key];
  }
  return "";
}

async function listReplenishmentDemand(days = 30) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 7), 90);
  const result = await query(`
    WITH demand AS (
      SELECT offer_id, 'fbo'::text AS channel, COALESCE(SUM(sales_units), 0)::numeric AS units
      FROM product_daily_metrics
      WHERE metric_date >= CURRENT_DATE - $1::int AND metric_date < CURRENT_DATE
      GROUP BY offer_id
      UNION ALL
      SELECT link.offer_id, 'wb_local'::text AS channel, COALESCE(SUM(metric.sales_units), 0)::numeric AS units
      FROM inventory_product_links link
      JOIN wb_daily_metrics metric ON metric.nm_id::text = link.nm_id::text
      WHERE link.market = 'wb'
        AND metric.metric_date >= CURRENT_DATE - $1::int AND metric.metric_date < CURRENT_DATE
      GROUP BY link.offer_id
      UNION ALL
      SELECT link.offer_id, 'wb_cross'::text AS channel, COALESCE(SUM(metric.sales_units), 0)::numeric AS units
      FROM inventory_product_links link
      JOIN wb_cross_daily_metrics metric ON metric.nm_id::text = link.nm_id::text
      WHERE link.market = 'wb_cross'
        AND metric.metric_date >= CURRENT_DATE - $1::int AND metric.metric_date < CURRENT_DATE
      GROUP BY link.offer_id
    )
    SELECT offer_id, channel, SUM(units)::numeric AS units
    FROM demand
    GROUP BY offer_id, channel
  `, [safeDays]);
  return { days: safeDays, rows: result.rows };
}

async function listUnallocatedStockLines() {
  const result = await query(`
    SELECT source_file, source_sheet, source_row, box_mark, box_numbers,
           sku, product_name, normalized_sku, per_box_qty, box_count, pieces, note, imported_at
    FROM inventory_unallocated_stock_lines
    ORDER BY box_mark, source_file, source_sheet, source_row, id
  `);
  return result.rows;
}

async function listArrivedBoxMarks(client = null) {
  const runner = client || { query };
  const result = await runner.query(`
    SELECT DISTINCT box_mark
    FROM inventory_unallocated_stock_lines
    WHERE TRIM(box_mark) <> ''
  `);
  return new Set((result.rows || []).map((row) => normalizeBoxMark(row.box_mark)).filter(Boolean));
}

async function buildFirstLegTransitTotals(rowsToEvaluate, client = null) {
  const runner = client || { query };
  const arrivedBoxMarks = await listArrivedBoxMarks(client);
  const includedRows = [];
  const excludedRows = [];

  for (const row of rowsToEvaluate) {
    const normalizedBox = normalizeBoxMark(row.normalized_box_mark || row.box_mark);
    if (normalizedBox && arrivedBoxMarks.has(normalizedBox)) {
      excludedRows.push({ ...row, normalized_box_mark: normalizedBox });
      continue;
    }
    includedRows.push(row);
  }

  const skuTotals = new Map();
  for (const row of includedRows) {
    skuTotals.set(row.normalized_sku, (skuTotals.get(row.normalized_sku) || 0) + Number(row.quantity || 0));
  }

  const [productsResult, barcodesResult] = await Promise.all([
    runner.query(`SELECT offer_id FROM products`),
    runner.query(`SELECT offer_id, barcode FROM inventory_product_barcodes`)
  ]);
  const matches = new Map();
  const addMatch = (key, offerId) => {
    const normalized = normalizeInventorySku(key);
    if (!normalized) return;
    const offers = matches.get(normalized) || new Set();
    offers.add(String(offerId));
    matches.set(normalized, offers);
  };
  for (const row of productsResult.rows || []) addMatch(row.offer_id, row.offer_id);
  for (const row of barcodesResult.rows || []) addMatch(row.barcode, row.offer_id);

  const byOffer = new Map();
  const unmatched = [];
  const ambiguous = [];
  for (const [sku, quantity] of skuTotals.entries()) {
    const offers = Array.from(matches.get(sku) || []);
    if (offers.length !== 1) {
      (offers.length ? ambiguous : unmatched).push(sku);
      continue;
    }
    byOffer.set(offers[0], (byOffer.get(offers[0]) || 0) + quantity);
  }

  return {
    arrived_box_mark_count: arrivedBoxMarks.size,
    includedRows,
    excludedRows,
    excluded_arrived_quantity: excludedRows.reduce((sum, row) => sum + Number(row.quantity || 0), 0),
    excluded_arrived_box_marks: Array.from(new Set(excludedRows.map((row) => row.normalized_box_mark).filter(Boolean))).slice(0, 50),
    skuTotals,
    byOffer,
    unmatched,
    ambiguous
  };
}

async function rebuildFirstLegTransitFromLines(client = null, { skipWhenEmpty = true } = {}) {
  const runner = client || { query };
  const lineResult = await runner.query(`
    SELECT source_file, source_sheet, source_row, box_mark, normalized_box_mark, sku, normalized_sku, quantity
    FROM inventory_first_leg_transit_lines
    WHERE quantity > 0
  `);
  const rowsToEvaluate = lineResult.rows || [];
  if (!rowsToEvaluate.length && skipWhenEmpty) {
    return {
      skipped: true,
      reason: "no_first_leg_detail_lines",
      row_count: 0,
      included_row_count: 0,
      excluded_arrived_box_mark_count: 0,
      excluded_arrived_quantity: 0,
      excluded_arrived_box_marks: []
    };
  }

  const totals = await buildFirstLegTransitTotals(rowsToEvaluate, client);
  await runner.query("DELETE FROM inventory_manual_first_leg_transit");
  for (const [offerId, quantity] of totals.byOffer.entries()) {
    await runner.query(`
      INSERT INTO inventory_manual_first_leg_transit (offer_id, quantity, updated_at)
      VALUES ($1, $2, NOW())
    `, [offerId, quantity]);
  }

  return {
    skipped: false,
    row_count: rowsToEvaluate.length,
    included_row_count: totals.includedRows.length,
    excluded_arrived_box_mark_count: totals.excludedRows.length,
    excluded_arrived_quantity: totals.excluded_arrived_quantity,
    excluded_arrived_box_marks: totals.excluded_arrived_box_marks,
    sku_count: totals.skuTotals.size,
    matched_sku_count: totals.skuTotals.size - totals.unmatched.length - totals.ambiguous.length,
    product_count: totals.byOffer.size,
    total_quantity: Array.from(totals.byOffer.values()).reduce((sum, value) => sum + value, 0),
    unmatched_skus: totals.unmatched,
    ambiguous_skus: totals.ambiguous
  };
}

async function importUnallocatedStock(payload = {}) {
  await ensureSchema();
  const files = Array.isArray(payload.files) ? payload.files : [];
  const lines = files.flatMap((file) => {
    const sourceFile = String(file.source_file || "").trim();
    return (Array.isArray(file.records) ? file.records : []).map((row) => ({
      source_file: sourceFile,
      source_sheet: String(row.source_sheet || "").trim(),
      source_row: Math.max(0, Number(row.source_row || 0)),
      box_mark: String(row.box_mark || "").trim(),
      box_numbers: String(row.box_numbers || "").trim(),
      sku: String(row.sku || "").trim(),
      product_name: String(row.product_name || "").trim(),
      normalized_sku: normalizeInventorySku(row.sku),
      per_box_qty: Math.max(0, Number(row.per_box_qty || 0)),
      box_count: Math.max(0, Math.trunc(Number(row.box_count || 0))),
      pieces: Math.max(0, Number(row.pieces || 0)),
      note: String(row.note || "").trim()
    })).filter((row) => row.source_file && row.normalized_sku && row.pieces > 0);
  });
  if (!files.length) throw new Error("files is required");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM inventory_unallocated_stock_lines");
    for (const row of lines) {
      await client.query(`
        INSERT INTO inventory_unallocated_stock_lines
          (source_file, source_sheet, source_row, box_mark, box_numbers, sku, product_name, normalized_sku,
           per_box_qty, box_count, pieces, note, imported_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
      `, [row.source_file, row.source_sheet, row.source_row, row.box_mark, row.box_numbers,
          row.sku, row.product_name, row.normalized_sku, row.per_box_qty, row.box_count, row.pieces, row.note]);
    }
    const totals = lines.reduce((sum, row) => ({
      boxes: sum.boxes + row.box_count,
      pieces: sum.pieces + row.pieces
    }), { boxes: 0, pieces: 0 });
    await client.query(`
      INSERT INTO inventory_unallocated_sync_log (file_count, line_count, box_count, piece_count, synced_at)
      VALUES ($1,$2,$3,$4,NOW())
    `, [files.length, lines.length, totals.boxes, totals.pieces]);
    const firstLegRebuild = await rebuildFirstLegTransitFromLines(client, { skipWhenEmpty: true });
    await client.query("COMMIT");
    cache.payload = null;
    return {
      file_count: files.length,
      line_count: lines.length,
      box_count: totals.boxes,
      piece_count: totals.pieces,
      first_leg_rebuild: firstLegRebuild
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}


async function importFirstLegTransit(payload = {}) {
  await ensureSchema();
  const files = Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) throw new Error("files is required");
  const rows = files.flatMap((file) => (Array.isArray(file.records) ? file.records : []).map((row) => ({
    source_file: String(file.source_file || "").trim(),
    source_sheet: String(firstValue(row, ["source_sheet", "sheet", "工作表"]) || "").trim(),
    source_row: Math.max(0, Number(firstValue(row, ["source_row", "row", "行号"]) || 0)),
    box_mark: String(firstValue(row, ["box_mark", "boxMark", "box", "箱唛", "箱唛号", "箱号"]) || "").trim(),
    normalized_box_mark: normalizeBoxMark(firstValue(row, ["box_mark", "boxMark", "box", "箱唛", "箱唛号", "箱号"])),
    sku: String(row.sku || "").trim(),
    normalized_sku: normalizeInventorySku(row.sku),
    quantity: Math.max(0, Number(row.quantity || 0))
  })).filter((row) => row.source_file && row.normalized_sku && row.quantity > 0));

  const client = await getPool().connect();
  let rebuildResult = null;
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM inventory_first_leg_transit_lines");
    for (const row of rows) {
      await client.query(`
        INSERT INTO inventory_first_leg_transit_lines
          (source_file, source_sheet, source_row, box_mark, normalized_box_mark, sku, normalized_sku, quantity, imported_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      `, [row.source_file, row.source_sheet, row.source_row, row.box_mark, row.normalized_box_mark,
          row.sku, row.normalized_sku, row.quantity]);
    }
    rebuildResult = await rebuildFirstLegTransitFromLines(client, { skipWhenEmpty: false });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  cache.payload = null;
  return {
    file_count: files.length,
    row_count: rows.length,
    ...rebuildResult
  };
}

async function dashboard({ showHidden = false, refresh = false } = {}) {
  await ensureSchema();
  if (!refresh && cache.payload && Date.now() - cache.fetchedAt < CACHE_MS) {
    if (showHidden === cache.payload.showHidden) return cache.payload.data;
  }

  const [ozonProducts, wbProducts, wbCrossProducts, links, manualFbsRows, manualWarehouseRows, manualWarehouseActualRows, manualDailyShipmentRows, firstLegRows, barcodeRows, wbCardWarehouseRows, unallocatedRows, replenishmentDemand] = await Promise.all([
    listProducts(showHidden),
    listWbProducts("wb_products"),
    listWbProducts("wb_cross_products"),
    listLinks(),
    listManualFbsStock(),
    listManualWarehouseFbsStock(),
    listManualWarehouseActualStock(),
    listManualDailyShipments(),
    listManualFirstLegTransit(),
    listBarcodes(),
    listWbCardWarehouseStock(),
    listUnallocatedStockLines(),
    listReplenishmentDemand(30)
  ]);

  const barcodeByOffer = new Map(
    (barcodeRows || []).map((row) => [String(row.offer_id), String(row.barcode || "")])
  );

  const firstLegByOffer = new Map(
    (firstLegRows || []).map((row) => [String(row.offer_id), Number(row.quantity || 0)])
  );

  const demandByOffer = new Map();
  for (const row of replenishmentDemand.rows || []) {
    const offerId = String(row.offer_id || "");
    if (!offerId) continue;
    const value = demandByOffer.get(offerId) || { fbo: 0, wb_local: 0, wb_cross: 0 };
    if (row.channel === "fbo") value.fbo += Number(row.units || 0);
    if (row.channel === "wb_local") value.wb_local += Number(row.units || 0);
    if (row.channel === "wb_cross") value.wb_cross += Number(row.units || 0);
    demandByOffer.set(offerId, value);
  }

  const manualFbsByOffer = new Map(
    manualFbsRows.map((row) => [String(row.offer_id), Number(row.manual_fbs_stock || 0)])
  );

  const manualWarehouseByOffer = new Map();
  for (const row of manualWarehouseRows || []) {
    const offerId = String(row.offer_id);
    const value = manualWarehouseByOffer.get(offerId) || {};
    value[row.warehouse_key] = Number(row.manual_stock || 0);
    manualWarehouseByOffer.set(offerId, value);
  }

  const manualWarehouseActualByOffer = new Map();
  for (const row of manualWarehouseActualRows || []) {
    const offerId = String(row.offer_id);
    const value = manualWarehouseActualByOffer.get(offerId) || {};
    value[row.warehouse_key] = Number(row.manual_stock || 0);
    manualWarehouseActualByOffer.set(offerId, value);
  }

  const manualDailyShipmentsByOffer = new Map();
  for (const row of manualDailyShipmentRows || []) {
    const offerId = String(row.offer_id);
    const value = manualDailyShipmentsByOffer.get(offerId) || {};
    value[row.warehouse_key] = Number(row.manual_quantity || 0);
    manualDailyShipmentsByOffer.set(offerId, value);
  }

  const wbCardWarehouseByKey = new Map();
  for (const row of wbCardWarehouseRows || []) {
    const key = `${row.market}:${row.nm_id}`;
    const values = wbCardWarehouseByKey.get(key) || [];
    values.push({
      warehouse_id: `manual:${row.warehouse_key}`,
      warehouse_name: row.warehouse_key === "shisheng" ? "世晟" : "林挺",
      warehouse_key: row.warehouse_key,
      amount: Number(row.stock || 0),
      source: "manual_card_warehouse",
      source_note: row.source_note || "",
      updated_at: row.updated_at
    });
    wbCardWarehouseByKey.set(key, values);
  }

  const linkedSetByOffer = new Map();
  for (const link of links) {
    const set = linkedSetByOffer.get(String(link.offer_id)) || new Set();
    set.add(`${link.market}:${link.nm_id}`);
    linkedSetByOffer.set(String(link.offer_id), set);
  }

  const emptyWbStock = () => ({ warehouses: [], byNm: new Map(), statsWarehouses: [] });
  let ozonWarehouseStock = new Map();
  let wbLocalStock = emptyWbStock();
  let wbCrossStock = emptyWbStock();
  // Ozon FBO available/transit is cached to avoid Ozon API 429 on every page open.
  // Refresh submits a live pull; normal page loads use the latest successful cache.
  const ozonPromise = refresh
    ? safeInventorySource("ozon", new Map(), () => fetchOzonWarehouseStocks(ozonProducts))
    : loadOzonStockSnapshot().then((value) => value || new Map());
  // WB's legacy statistics stock endpoint is retired. The dashboard reads the
  // current seller-warehouse values persisted by /api/sync/wb*/stocks instead.
  // A manual dashboard refresh only refreshes Ozon live data and keeps WB reads local.
  wbLocalStock = await loadWbStockSnapshot("wb") || emptyWbStock();
  wbCrossStock = await loadWbStockSnapshot("wb_cross") || emptyWbStock();
  ozonWarehouseStock = await ozonPromise;
  const ozonByOffer = new Map(ozonProducts.map((item) => [String(item.offer_id), item]));
  const linkStockByOffer = enrichLinkStock(
    links,
    wbLocalStock,
    wbCrossStock,
    wbProducts,
    wbCrossProducts,
    manualWarehouseByOffer,
    ozonByOffer,
    wbCardWarehouseByKey
  );

  const unallocatedBySku = new Map();
  for (const row of unallocatedRows || []) {
    const key = normalizeInventorySku(row.normalized_sku || row.sku);
    const value = unallocatedBySku.get(key) || { sku: row.sku || key, product_name: row.product_name || "", pieces: 0, boxes: 0, details: [] };
    if (!value.product_name && row.product_name) value.product_name = row.product_name;
    value.pieces += Number(row.pieces || 0);
    value.boxes += Number(row.box_count || 0);
    value.details.push({
      box_mark: row.box_mark || "",
      box_numbers: row.box_numbers || "",
      per_box_qty: Number(row.per_box_qty || 0),
      box_count: Number(row.box_count || 0),
      pieces: Number(row.pieces || 0),
      source_file: row.source_file || "",
      note: row.note || ""
    });
    unallocatedBySku.set(key, value);
  }

  const unallocatedAssignmentByOffer = new Map();
  const matchedUnallocatedSkus = new Set();
  for (const item of ozonProducts) {
    const offerId = String(item.offer_id);
    const linked = linkStockByOffer.get(offerId) || { wb: 0, wb_cross: 0, links: [] };
    // The NAS workbook SKU is stored in the dashboard's editable barcode field.
    // Prefer that explicit mapping, while retaining offer/vendor-code compatibility.
    const keys = new Set();
    const barcode = barcodeByOffer.get(offerId) || "";
    keys.add(normalizeInventorySku(barcode));
    keys.add(normalizeInventorySku(offerId));
    for (const link of linked.links || []) keys.add(normalizeInventorySku(link.vendor_code));
    const aggregate = { pieces: 0, boxes: 0, details: [] };
    for (const key of keys) {
      if (!key || matchedUnallocatedSkus.has(key) || !unallocatedBySku.has(key)) continue;
      const value = unallocatedBySku.get(key);
      aggregate.pieces += Number(value.pieces || 0);
      aggregate.boxes += Number(value.boxes || 0);
      aggregate.details.push(...(value.details || []));
      matchedUnallocatedSkus.add(key);
    }
    unallocatedAssignmentByOffer.set(offerId, aggregate);
  }

  const products = ozonProducts.map((item) => {
    const offerId = String(item.offer_id);
    const linkedSet = linkedSetByOffer.get(offerId) || new Set();
    const linked = linkStockByOffer.get(offerId) || { wb: 0, wb_cross: 0, links: [] };
    const ozonStock = ozonWarehouseStock.get(offerId) || { totalAvailable: 0, totalTransit: 0, warehouses: [] };
    const unallocated = unallocatedAssignmentByOffer.get(offerId) || { pieces: 0, boxes: 0, details: [] };
    const ozonFbs = Number(item.fbs_stock || 0);
    const wbLocalFbs = Number(linked.wb || 0);
    const wbCrossFbs = Number(linked.wb_cross || 0);
    const fbwStock = (linked.links || []).reduce(
      (sum, link) => sum + Number(link.fbw_stock || 0),
      0
    );
    return {
      ...item,
      fbo_stock: Number(item.fbo_stock || 0),
      fbs_stock: ozonFbs,
      fbw_stock: fbwStock,
      fbw_stock_source: FBW_STOCK_SOURCE_ENABLED ? "reliable_wb_source" : "disabled_no_reliable_api",
      ozon_warehouse_available: ozonStock.totalAvailable,
      ozon_warehouse_transit: ozonStock.totalTransit,
      ozon_warehouses: ozonStock.warehouses.slice(0, 15),
      wb_local_fbs_stock: wbLocalFbs,
      wb_cross_fbs_stock: wbCrossFbs,
      linked_fbs_stock: ozonFbs + wbLocalFbs + wbCrossFbs,
      manual_fbs_stock: manualFbsByOffer.has(offerId) ? manualFbsByOffer.get(offerId) : null,
      manual_warehouse_fbs_stock: manualWarehouseByOffer.get(offerId) || {},
      manual_warehouse_actual_stock: manualWarehouseActualByOffer.get(offerId) || {},
      manual_daily_shipments: manualDailyShipmentsByOffer.get(offerId) || {},
      first_leg_transit: firstLegByOffer.has(offerId) ? firstLegByOffer.get(offerId) : null,
      barcode: barcodeByOffer.get(offerId) || "",
      unallocated_stock: Number(unallocated.pieces || 0),
      unallocated_boxes: Number(unallocated.boxes || 0),
      unallocated_details: unallocated.details || [],
      replenishment_demand: (() => {
        const demand = demandByOffer.get(offerId) || { fbo: 0, wb_local: 0, wb_cross: 0 };
        const total = Number(demand.fbo || 0) + Number(demand.wb_local || 0) + Number(demand.wb_cross || 0);
        return { days: replenishmentDemand.days, ...demand, total, daily_avg: total / replenishmentDemand.days };
      })(),
      links: linked.links,
      candidates: { wb: [], wb_cross: [] }
    };
  });

  for (const [key, value] of unallocatedBySku.entries()) {
    if (matchedUnallocatedSkus.has(key)) continue;
    products.push({
      offer_id: value.sku || key,
      product_id: "",
      ozon_sku: "",
      title: value.product_name || value.sku || key,
      image_url: "",
      source_label: "未分配库存",
      hidden: false,
      fbo_stock: 0,
      fbw_stock: 0,
      fbs_stock: 0,
      wb_local_fbs_stock: 0,
      wb_cross_fbs_stock: 0,
      linked_fbs_stock: 0,
      manual_fbs_stock: null,
      manual_warehouse_fbs_stock: {},
      manual_warehouse_actual_stock: {},
      manual_daily_shipments: {},
      first_leg_transit: firstLegByOffer.has(String(value.sku || key)) ? firstLegByOffer.get(String(value.sku || key)) : null,
      barcode: "",
      unallocated_stock: Number(value.pieces || 0),
      unallocated_boxes: Number(value.boxes || 0),
      unallocated_details: value.details || [],
      replenishment_demand: { days: replenishmentDemand.days, fbo: 0, wb_local: 0, wb_cross: 0, total: 0, daily_avg: 0 },
      links: [],
      candidates: { wb: [], wb_cross: [] }
    });
  }

  const data = {
    products,
    summary: {
      productCount: products.filter((item) => !item.hidden).length,
      hiddenCount: products.filter((item) => item.hidden).length,
      // The product stock sync is the authoritative FBO total. The warehouse snapshot
      // remains useful for transit and tooltip details, but must not override a newer total.
      ozonFbo: products.reduce((sum, item) => sum + Number(item.fbo_stock || 0), 0),
      ozonFboTransit: products.reduce((sum, item) => sum + Number(item.ozon_warehouse_transit || 0), 0),
      fbwStock: products.reduce((sum, item) => sum + Number(item.fbw_stock || 0), 0),
      fbwStockEnabled: FBW_STOCK_SOURCE_ENABLED,
      fbwStockSource: FBW_STOCK_SOURCE_ENABLED ? "reliable_wb_source" : "disabled_no_reliable_api",
      ozonFbs: products.reduce((sum, item) => sum + Number(item.fbs_stock || 0), 0),
      wbLocalLinkedFbs: products.reduce((sum, item) => sum + Number(item.wb_local_fbs_stock || 0), 0),
      wbCrossLinkedFbs: products.reduce((sum, item) => sum + Number(item.wb_cross_fbs_stock || 0), 0),
      manualFbs: products.reduce((sum, item) => sum + Number(item.manual_fbs_stock || 0), 0),
      linkedFbs: products.reduce((sum, item) => sum + Number(item.linked_fbs_stock || 0), 0),
      unallocatedStock: products.reduce((sum, item) => sum + Number(item.unallocated_stock || 0), 0),
      unallocatedBoxes: products.reduce((sum, item) => sum + Number(item.unallocated_boxes || 0), 0),
      overAllocatedCount: products.filter((item) => {
        const manual = item.manual_warehouse_fbs_stock || {};
        const hasManual = manual.linting !== undefined || manual.shisheng !== undefined;
        const manualTotal = Number(manual.linting || 0) + Number(manual.shisheng || 0);
        return hasManual && Number(item.linked_fbs_stock || 0) > manualTotal;
      }).length
    },
    source: {
      fetchedAt: new Date().toISOString(),
      sourceErrors: {
        ozon: ozonWarehouseStock.error || "",
        wb: wbLocalStock.error || "",
        wb_cross: wbCrossStock.error || ""
      },
      wbLocalWarehouses: wbLocalStock.warehouses,
      wbCrossWarehouses: wbCrossStock.warehouses,
      wbLocalStatsWarehouses: wbLocalStock.statsWarehouses.slice(0, 20),
      wbCrossStatsWarehouses: wbCrossStock.statsWarehouses.slice(0, 20)
    }
  };
  cache.payload = { showHidden, data };
  cache.fetchedAt = Date.now();
  return data;
}

async function productCandidates(offerId) {
  await ensureSchema();
  const products = await listProducts(true);
  const item = products.find((row) => String(row.offer_id) === String(offerId));
  if (!item) {
    const error = new Error("Inventory product not found");
    error.statusCode = 404;
    throw error;
  }
  const [wbProducts, wbCrossProducts, links] = await Promise.all([
    listWbProducts("wb_products"),
    listWbProducts("wb_cross_products"),
    listLinks()
  ]);
  const linkedSet = new Set(
    links
      .filter((link) => String(link.offer_id) === String(offerId))
      .map((link) => `${link.market}:${link.nm_id}`)
  );
  return {
    wb: buildCandidates(item, wbProducts, "wb", linkedSet),
    wb_cross: buildCandidates(item, wbCrossProducts, "wb_cross", linkedSet)
  };
}

function refreshStatus() {
  return { ...refreshState };
}

function startBackgroundRefresh({ showHidden = false } = {}) {
  if (refreshState.running) return { ...refreshState, accepted: false, running: true };
  refreshState.running = true;
  refreshState.lastStartedAt = new Date().toISOString();
  refreshState.lastFinishedAt = null;
  refreshState.lastError = "";
  Promise.resolve()
    .then(() => dashboard({ showHidden, refresh: true }))
    .then(() => {
      refreshState.lastOkAt = new Date().toISOString();
    })
    .catch((error) => {
      refreshState.lastError = error && error.message ? error.message : String(error);
      console.error("[inventory-background-refresh]", refreshState.lastError);
    })
    .finally(() => {
      refreshState.running = false;
      refreshState.lastFinishedAt = new Date().toISOString();
    });
  return { ...refreshState, accepted: true };
}

async function setBarcode(offerId, barcode = "") {
  await ensureSchema();
  const value = String(barcode || "").trim();
  if (!value) {
    await query(`DELETE FROM inventory_product_barcodes WHERE offer_id = $1`, [String(offerId)]);
    cache.payload = null;
    return { offer_id: String(offerId), barcode: "" };
  }
  const result = await query(`
    INSERT INTO inventory_product_barcodes (offer_id, barcode, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (offer_id) DO UPDATE SET barcode = EXCLUDED.barcode, updated_at = NOW()
    RETURNING offer_id, barcode, updated_at
  `, [String(offerId), value]);
  cache.payload = null;
  return result.rows[0];
}

async function setWbCardWarehouseStock({ market, nm_id, warehouse_key, stock, source_note = "" }) {
  await ensureSchema();
  const safeMarket = market === "wb_cross" ? "wb_cross" : "wb";
  const safeWarehouse = warehouse_key === "shisheng" ? "shisheng" : "linting";
  const safeNmId = String(nm_id || "").trim();
  if (!safeNmId) throw new Error("nm_id is required");
  const value = Math.max(0, Number(stock || 0));
  const result = await query(`
    INSERT INTO inventory_wb_card_warehouse_stock (market, nm_id, warehouse_key, stock, source_note, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (market, nm_id, warehouse_key) DO UPDATE SET
      stock = EXCLUDED.stock,
      source_note = EXCLUDED.source_note,
      updated_at = NOW()
    RETURNING market, nm_id, warehouse_key, stock, source_note, updated_at
  `, [safeMarket, safeNmId, safeWarehouse, value, String(source_note || "")]);
  cache.payload = null;
  return result.rows[0];
}

async function setManualWarehouseFbsStock(offerId, warehouseKey, manualStock) {
  await ensureSchema();
  const safeWarehouse = warehouseKey === "shisheng" ? "shisheng" : "linting";
  if (manualStock === null || manualStock === undefined || manualStock === "") {
    await query(
      `DELETE FROM inventory_manual_warehouse_fbs_stock WHERE offer_id = $1 AND warehouse_key = $2`,
      [String(offerId), safeWarehouse]
    );
    cache.payload = null;
    return { offer_id: String(offerId), warehouse_key: safeWarehouse, manual_stock: null };
  }
  const value = Math.max(0, Number(manualStock || 0));
  const result = await query(`
    INSERT INTO inventory_manual_warehouse_fbs_stock (offer_id, warehouse_key, manual_stock, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (offer_id, warehouse_key) DO UPDATE SET manual_stock = EXCLUDED.manual_stock, updated_at = NOW()
    RETURNING offer_id, warehouse_key, manual_stock, updated_at
  `, [String(offerId), safeWarehouse, value]);
  cache.payload = null;
  return result.rows[0];
}

async function setManualWarehouseActualStock(offerId, warehouseKey, manualStock) {
  await ensureSchema();
  const safeWarehouse = warehouseKey === "shisheng" ? "shisheng" : "linting";
  if (manualStock === null || manualStock === undefined || manualStock === "") {
    await query(
      `DELETE FROM inventory_manual_warehouse_actual_stock WHERE offer_id = $1 AND warehouse_key = $2`,
      [String(offerId), safeWarehouse]
    );
    cache.payload = null;
    return { offer_id: String(offerId), warehouse_key: safeWarehouse, manual_stock: null };
  }
  const value = Math.max(0, Number(manualStock || 0));
  const result = await query(`
    INSERT INTO inventory_manual_warehouse_actual_stock (offer_id, warehouse_key, manual_stock, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (offer_id, warehouse_key) DO UPDATE SET manual_stock = EXCLUDED.manual_stock, updated_at = NOW()
    RETURNING offer_id, warehouse_key, manual_stock, updated_at
  `, [String(offerId), safeWarehouse, value]);
  cache.payload = null;
  return result.rows[0];
}

async function setFirstLegTransit(offerId, quantity) {
  await ensureSchema();
  const safeOffer = String(offerId || "").trim();
  if (!safeOffer) throw new Error("offer_id is required");
  if (quantity === null || quantity === undefined || quantity === "") {
    await query(`DELETE FROM inventory_manual_first_leg_transit WHERE offer_id = $1`, [safeOffer]);
    cache.payload = null;
    return { offer_id: safeOffer, quantity: null };
  }
  const value = Math.max(0, Number(quantity || 0));
  const result = await query(`
    INSERT INTO inventory_manual_first_leg_transit (offer_id, quantity, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (offer_id) DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()
    RETURNING offer_id, quantity, updated_at
  `, [safeOffer, value]);
  cache.payload = null;
  return result.rows[0];
}

async function setManualDailyShipment(offerId, warehouseKey, shipmentDate, manualQuantity) {
  await ensureSchema();
  const safeOffer = String(offerId);
  const safeWarehouse = warehouseKey === "shisheng" ? "shisheng" : "linting";
  const safeDate = String(shipmentDate || chinaDate()).slice(0, 10);
  const clearing = manualQuantity === null || manualQuantity === undefined || manualQuantity === "";
  const nextValue = clearing ? null : Math.max(0, Number(manualQuantity || 0));
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const previousResult = await client.query(
      `SELECT manual_quantity FROM inventory_manual_daily_shipments
       WHERE offer_id = $1 AND warehouse_key = $2 AND shipment_date = $3::date
       FOR UPDATE`,
      [safeOffer, safeWarehouse, safeDate]
    );
    const previousValue = previousResult.rows[0] ? Number(previousResult.rows[0].manual_quantity || 0) : 0;
    let shipmentRow;
    if (clearing) {
      await client.query(
        `DELETE FROM inventory_manual_daily_shipments WHERE offer_id = $1 AND warehouse_key = $2 AND shipment_date = $3::date`,
        [safeOffer, safeWarehouse, safeDate]
      );
      shipmentRow = { offer_id: safeOffer, warehouse_key: safeWarehouse, shipment_date: safeDate, manual_quantity: null };
    } else {
      const result = await client.query(`
        INSERT INTO inventory_manual_daily_shipments (offer_id, warehouse_key, shipment_date, manual_quantity, updated_at)
        VALUES ($1, $2, $3::date, $4, NOW())
        ON CONFLICT (offer_id, warehouse_key, shipment_date) DO UPDATE SET manual_quantity = EXCLUDED.manual_quantity, updated_at = NOW()
        RETURNING offer_id, warehouse_key, shipment_date, manual_quantity, updated_at
      `, [safeOffer, safeWarehouse, safeDate, nextValue]);
      shipmentRow = result.rows[0];
    }

    const delta = (nextValue === null ? 0 : nextValue) - previousValue;
    let adjustedManualStock = null;
    if (delta !== 0) {
      const stockResult = await client.query(`
        UPDATE inventory_manual_warehouse_actual_stock
        SET manual_stock = GREATEST(0, manual_stock - $3::numeric), updated_at = NOW()
        WHERE offer_id = $1 AND warehouse_key = $2
        RETURNING manual_stock
      `, [safeOffer, safeWarehouse, delta]);
      if (stockResult.rows[0]) adjustedManualStock = Number(stockResult.rows[0].manual_stock || 0);
    }

    await client.query("COMMIT");
    cache.payload = null;
    return { ...shipmentRow, adjusted_manual_stock: adjustedManualStock, deducted_delta: delta };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function setManualFbsStock(offerId, manualFbsStock = 0) {
  await ensureSchema();
  const value = Math.max(0, Number(manualFbsStock || 0));
  const result = await query(`
    INSERT INTO inventory_manual_fbs_stock (offer_id, manual_fbs_stock, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (offer_id) DO UPDATE SET manual_fbs_stock = EXCLUDED.manual_fbs_stock, updated_at = NOW()
    RETURNING offer_id, manual_fbs_stock, updated_at
  `, [String(offerId), value]);
  cache.payload = null;
  return result.rows[0];
}

async function setHidden(offerId, hidden = true) {
  await ensureSchema();
  await query(`
    INSERT INTO inventory_hidden_products (offer_id, hidden, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (offer_id) DO UPDATE SET hidden = EXCLUDED.hidden, updated_at = NOW()
  `, [String(offerId), Boolean(hidden)]);
  cache.payload = null;
  return { offer_id: String(offerId), hidden: Boolean(hidden) };
}

async function createLink({ offer_id, market, nm_id }) {
  await ensureSchema();
  const safeMarket = market === "wb_cross" ? "wb_cross" : "wb";
  const result = await query(`
    INSERT INTO inventory_product_links (offer_id, market, nm_id, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (offer_id, market, nm_id) DO UPDATE SET updated_at = NOW()
    RETURNING *
  `, [String(offer_id), safeMarket, String(nm_id)]);
  cache.payload = null;
  return result.rows[0];
}

async function deleteLink(id) {
  await ensureSchema();
  const result = await query(`DELETE FROM inventory_product_links WHERE id = $1 RETURNING *`, [id]);
  cache.payload = null;
  return result.rows[0] || null;
}

async function searchCards({ market = "wb", q = "", limit = 20 } = {}) {
  await ensureSchema();
  const table = market === "wb_cross" ? "wb_cross_products" : "wb_products";
  const result = await query(
    `SELECT nm_id, vendor_code, title, image_url, stock, fbs_stock
     FROM ${table}
     WHERE nm_id ILIKE $1 OR vendor_code ILIKE $1 OR title ILIKE $1
     ORDER BY COALESCE(stock, 0) DESC, updated_at DESC
     LIMIT $2`,
    [`%${q}%`, Math.min(Math.max(Number(limit) || 20, 1), 50)]
  );
  return result.rows;
}

function syntheticWbOfferId(market, nmId) {
  const prefix = market === "wb_cross" ? "WBCROSS" : "WBLOCAL";
  return `${prefix}-${String(nmId).replace(/[^0-9A-Za-z_-]/g, "_")}`;
}

async function getWbCard(market, nmId) {
  const safeMarket = market === "wb_cross" ? "wb_cross" : "wb";
  const table = safeMarket === "wb_cross" ? "wb_cross_products" : "wb_products";
  const result = await query(
    `SELECT nm_id, vendor_code, title, image_url, stock, fbs_stock, fbw_stock
     FROM ${table}
     WHERE nm_id::text = $1
     LIMIT 1`,
    [String(nmId)]
  );
  return result.rows[0] || null;
}

async function createProductFromWbCard({ market = "wb", nm_id }) {
  await ensureSchema();
  const safeMarket = market === "wb_cross" ? "wb_cross" : "wb";
  const nmId = String(nm_id || "").trim();
  if (!nmId) {
    const error = new Error("nm_id is required");
    error.statusCode = 400;
    throw error;
  }
  const card = await getWbCard(safeMarket, nmId);
  if (!card) {
    const error = new Error("WB card not found");
    error.statusCode = 404;
    throw error;
  }
  const offerId = syntheticWbOfferId(safeMarket, nmId);
  const title = card.title || card.vendor_code || nmId;
  const productId = card.vendor_code || nmId;
  const inserted = await query(`
    INSERT INTO products (offer_id, product_id, ozon_sku, title, image_url, fbo_stock, fbs_stock, updated_at)
    VALUES ($1, $2, '', $3, $4, 0, 0, NOW())
    ON CONFLICT (offer_id) DO UPDATE SET
      product_id = COALESCE(NULLIF(products.product_id, ''), EXCLUDED.product_id),
      title = COALESCE(NULLIF(products.title, ''), EXCLUDED.title),
      image_url = COALESCE(NULLIF(products.image_url, ''), EXCLUDED.image_url),
      updated_at = NOW()
    RETURNING offer_id, product_id, ozon_sku, title, image_url, fbo_stock, fbs_stock, updated_at
  `, [offerId, productId, title, card.image_url || ""]);

  await createLink({ offer_id: offerId, market: safeMarket, nm_id: nmId });
  cache.payload = null;
  return {
    ...inserted.rows[0],
    source_market: safeMarket,
    source_label: safeMarket === "wb_cross" ? "WB跨境" : "WB本土",
    linked_card: card
  };
}

module.exports = { dashboard, refreshOzonStockSnapshot, importUnallocatedStock, importFirstLegTransit, setBarcode, setWbCardWarehouseStock, setManualWarehouseFbsStock, setManualWarehouseActualStock, setFirstLegTransit, setManualDailyShipment, setManualFbsStock, setHidden, createLink, deleteLink, searchCards, createProductFromWbCard, productCandidates, refreshStatus, startBackgroundRefresh };
