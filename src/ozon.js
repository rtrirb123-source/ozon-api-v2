const https = require("https");
const { config } = require("./config");
const products = require("./products");

const OZON_API_HOST = "api-seller.ozon.ru";

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function requestJson(path, body) {
  return new Promise((resolve, reject) => {
    if (!config.ozonClientId || !config.ozonApiKey) {
      const error = new Error("OZON_CLIENT_ID and OZON_API_KEY are required");
      error.statusCode = 500;
      reject(error);
      return;
    }

    const payload = JSON.stringify(body);
    const req = https.request(
      {
        method: "POST",
        hostname: OZON_API_HOST,
        path,
        headers: {
          "Client-Id": config.ozonClientId,
          "Api-Key": config.ozonApiKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload)
        },
        timeout: 30000
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch (error) {
            error.statusCode = 502;
            error.details = data.slice(0, 500);
            reject(error);
            return;
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const error = new Error(parsed.message || `Ozon API HTTP ${res.statusCode}`);
            error.statusCode = 502;
            error.details = parsed;
            reject(error);
            return;
          }
          resolve(parsed);
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Ozon API request timeout")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function dimensionValue(row, names) {
  for (const dimension of row.dimensions || []) {
    if (names.includes(dimension.key) || names.includes(dimension.name)) {
      return dimension.id || dimension.name;
    }
  }
  return "";
}

function dimensionAt(row, index) {
  const dimension = (row.dimensions || [])[index];
  return dimension ? dimension.id || dimension.name || "" : "";
}

function metricValue(row, index) {
  const value = (row.metrics || [])[index];
  if (value === "" || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function buildProductLookup(productRows) {
  const lookup = new Map();
  for (const product of productRows) {
    if (product.offer_id) lookup.set(String(product.offer_id), product.offer_id);
    if (product.product_id) lookup.set(String(product.product_id), product.offer_id);
    if (product.ozon_sku) lookup.set(String(product.ozon_sku), product.offer_id);
  }
  return lookup;
}

async function fetchProductInfo(offerIds) {
  const items = [];
  const chunkSize = 100;
  for (let index = 0; index < offerIds.length; index += chunkSize) {
    const chunk = offerIds.slice(index, index + chunkSize);
    const response = await requestJson("/v3/product/info/list", {
      offer_id: chunk,
      product_id: [],
      sku: []
    });
    items.push(...(response.items || []));
  }
  return items;
}

async function syncOzonProducts() {
  const productRows = await products.listProducts({ limit: 1000 });
  const offerIds = productRows.map((product) => product.offer_id).filter(Boolean);
  const items = await fetchProductInfo(offerIds);
  let updated = 0;

  for (const item of items) {
    const sku = item.sku || item.sources?.[0]?.sku || item.stocks?.stocks?.[0]?.sku;
    if (!item.offer_id || !sku) continue;
    const primaryImage = Array.isArray(item.primary_image) ? item.primary_image[0] : "";
    await products.updateProduct(item.offer_id, {
      product_id: String(item.id || ""),
      ozon_sku: String(sku),
      title: item.name || "",
      image_url: primaryImage || item.images?.[0] || ""
    });
    updated += 1;
  }

  return {
    requested: offerIds.length,
    returned: items.length,
    updated
  };
}

async function fetchSalesAnalytics(days = 30) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - safeDays + 1);

  const rows = [];
  let offset = 0;
  const limit = 1000;

  while (true) {
    const response = await requestJson("/v1/analytics/data", {
      date_from: formatDate(from),
      date_to: formatDate(to),
      metrics: ["ordered_units", "revenue"],
      dimension: ["sku", "day"],
      filters: [],
      sort: [{ key: "ordered_units", order: "DESC" }],
      limit,
      offset
    });

    const chunk = response.result?.data || [];
    rows.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }

  return rows;
}

async function syncOzonMetrics({ days = 30 } = {}) {
  await syncOzonProducts();
  const productRows = await products.listProducts({ limit: 1000 });
  const lookup = buildProductLookup(productRows);
  const analyticsRows = await fetchSalesAnalytics(days);
  const grouped = new Map();

  for (const row of analyticsRows) {
    const sku = String(dimensionAt(row, 0) || dimensionValue(row, ["sku", "SKU"]));
    const day = dimensionAt(row, 1) || dimensionValue(row, ["day", "День"]);
    const offerId = lookup.get(sku);
    if (!offerId || !day) continue;

    const key = `${offerId}:${day}`;
    const existing = grouped.get(key) || {
      metric_date: day,
      sales_units: 0,
      revenue: 0,
      ad_ratio: null
    };
    existing.sales_units += metricValue(row, 0) || 0;
    existing.revenue += metricValue(row, 1) || 0;
    grouped.set(key, existing);
  }

  const byOffer = new Map();
  for (const [key, metric] of grouped.entries()) {
    const offerId = key.split(":")[0];
    if (!byOffer.has(offerId)) byOffer.set(offerId, []);
    byOffer.get(offerId).push(metric);
  }

  let savedCount = 0;
  for (const [offerId, metrics] of byOffer.entries()) {
    const saved = await products.upsertMetrics(offerId, metrics);
    savedCount += saved.length;
  }

  return {
    productsMatched: byOffer.size,
    rowsFromOzon: analyticsRows.length,
    metricsSaved: savedCount
  };
}

async function previewOzonAnalytics({ days = 3, limit = 10 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 3, 1), 30);
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - safeDays + 1);
  const response = await requestJson("/v1/analytics/data", {
    date_from: formatDate(from),
    date_to: formatDate(to),
    metrics: ["ordered_units", "revenue"],
    dimension: ["sku", "day"],
    filters: [],
    sort: [{ key: "ordered_units", order: "DESC" }],
    limit: Math.min(Number(limit) || 10, 50),
    offset: 0
  });
  return response.result?.data || [];
}

module.exports = { previewOzonAnalytics, syncOzonMetrics, syncOzonProducts };
