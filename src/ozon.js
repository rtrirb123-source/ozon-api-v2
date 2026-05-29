const https = require("https");
const { config } = require("./config");
const products = require("./products");

const OZON_API_HOST = "api-seller.ozon.ru";
const OZON_PERFORMANCE_HOST = "api-performance.ozon.ru";

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function moscowDateOffset(daysOffset = 0) {
  const date = new Date(Date.now() + 3 * 60 * 60 * 1000);
  date.setUTCDate(date.getUTCDate() + daysOffset);
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

function performanceRequestJson(path, { method = "GET", body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = {
      Accept: "application/json"
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        method,
        hostname: OZON_PERFORMANCE_HOST,
        path,
        headers,
        timeout: 45000
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
            const error = new Error(parsed.error || parsed.message || `Ozon Performance API HTTP ${res.statusCode}`);
            error.statusCode = res.statusCode === 429 ? 429 : 502;
            error.details = parsed;
            reject(error);
            return;
          }
          resolve(parsed);
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("Ozon Performance API request timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function getPerformanceToken() {
  if (!config.ozonPerformanceClientId || !config.ozonPerformanceClientSecret) {
    const error = new Error("OZON_PERFORMANCE_CLIENT_ID and OZON_PERFORMANCE_CLIENT_SECRET are required");
    error.statusCode = 500;
    throw error;
  }

  const response = await performanceRequestJson("/api/client/token", {
    method: "POST",
    body: {
      client_id: config.ozonPerformanceClientId,
      client_secret: config.ozonPerformanceClientSecret,
      grant_type: "client_credentials"
    }
  });
  if (!response.access_token) {
    const error = new Error("Ozon Performance token response did not include access_token");
    error.statusCode = 502;
    throw error;
  }
  return response.access_token;
}

async function fetchPerformanceCampaigns(token) {
  const states = ["CAMPAIGN_STATE_RUNNING", "CAMPAIGN_STATE_INACTIVE"];
  const campaigns = [];
  for (const state of states) {
    const response = await performanceRequestJson(`/api/client/campaign?state=${encodeURIComponent(state)}`, { token });
    campaigns.push(...(response.list || []));
  }
  return campaigns;
}

async function fetchCampaignProducts(token, campaignId) {
  try {
    const response = await performanceRequestJson(`/api/client/campaign/${encodeURIComponent(campaignId)}/v2/products`, { token });
    return (response.products || []).map((product) => String(product.sku || "")).filter(Boolean);
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404) return [];
    throw error;
  }
}

async function requestPerformanceReport(token, campaigns, from, to) {
  const response = await performanceRequestJson("/api/client/statistics/json", {
    method: "POST",
    token,
    body: {
      campaigns,
      dateFrom: formatDate(from),
      dateTo: formatDate(to),
      groupBy: "DATE"
    }
  });
  return response.UUID || response.uuid;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPerformanceReport(token, uuid) {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const status = await performanceRequestJson(`/api/client/statistics/${encodeURIComponent(uuid)}`, { token });
    const state = String(status.state || "").toUpperCase();
    if (["OK", "DONE", "SUCCESS", "COMPLETED", "READY"].includes(state)) {
      return performanceRequestJson(`/api/client/statistics/report?UUID=${encodeURIComponent(uuid)}`, { token });
    }
    if (["ERROR", "FAILED", "CANCELED", "CANCELLED"].includes(state)) {
      const error = new Error(`Ozon Performance report ${state}`);
      error.statusCode = 502;
      error.details = status;
      throw error;
    }
    await sleep(5000);
  }

  const error = new Error("Ozon Performance report was not ready in time");
  error.statusCode = 202;
  throw error;
}

function normalizeReportRows(report) {
  if (Array.isArray(report)) return report;
  if (Array.isArray(report.rows)) return report.rows;
  if (Array.isArray(report.data)) return report.data;
  if (Array.isArray(report.result?.rows)) return report.result.rows;
  if (Array.isArray(report.result?.data)) return report.result.data;
  if (Array.isArray(report.report?.rows)) return report.report.rows;
  if (report && typeof report === "object") {
    const rows = [];
    for (const [campaignId, value] of Object.entries(report)) {
      const nestedRows = normalizeReportRows(value);
      for (const row of nestedRows) {
        rows.push({ campaignId, ...row });
      }
    }
    return rows;
  }
  return [];
}

function pick(row, names) {
  for (const name of names) {
    if (row && row[name] !== undefined && row[name] !== null && row[name] !== "") return row[name];
  }
  return null;
}

function rowDate(row) {
  const value = pick(row, ["date", "day", "metric_date", "dateFrom", "from"]);
  if (!value) return "";
  const text = String(value).slice(0, 10);
  const dotted = text.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  return text;
}

function rowSpend(row) {
  const value = pick(row, ["expense", "expenses", "spend", "cost", "moneySpent", "ad_spend"]);
  if (value === null) return 0;
  const normalized = String(value).replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : 0;
}

async function fetchPerformanceAdSpend({ days = 30, lookup }) {
  if (!config.ozonPerformanceClientId || !config.ozonPerformanceClientSecret) {
    return { rows: [], warning: "Ozon Performance credentials are not configured" };
  }

  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 90);
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - safeDays + 1);

  const token = await getPerformanceToken();
  const campaigns = await fetchPerformanceCampaigns(token);
  const skuCampaigns = campaigns.filter((campaign) => ["SKU", "ALL_SKU_PROMO"].includes(campaign.advObjectType));
  const campaignIds = skuCampaigns.map((campaign) => String(campaign.id)).filter(Boolean);
  if (!campaignIds.length) return { rows: [], warning: "No SKU performance campaigns found" };

  const campaignSkuMap = new Map();
  for (const campaignId of campaignIds) {
    campaignSkuMap.set(campaignId, await fetchCampaignProducts(token, campaignId));
  }

  const uuid = await requestPerformanceReport(token, campaignIds, from, to);
  if (!uuid) return { rows: [], warning: "Ozon Performance did not return a report UUID" };

  const report = await waitForPerformanceReport(token, uuid);
  const rows = [];
  for (const row of normalizeReportRows(report)) {
    const date = rowDate(row);
    const spend = rowSpend(row);
    if (!date || !Number.isFinite(spend) || spend <= 0) continue;

    const sku = String(pick(row, ["sku", "SKU", "objectId", "object_id", "productId", "product_id"]) || "");
    const campaignId = String(pick(row, ["campaignId", "campaign_id", "id"]) || "");
    if (sku && lookup.has(sku)) {
      rows.push({ offer_id: lookup.get(sku), metric_date: date, ad_spend: spend });
      continue;
    }

    const campaignSkus = campaignSkuMap.get(campaignId) || [];
    const offerIds = Array.from(new Set(campaignSkus.map((item) => lookup.get(item)).filter(Boolean)));
    if (!offerIds.length) continue;
    const allocatedSpend = spend / offerIds.length;
    for (const offerId of offerIds) {
      rows.push({ offer_id: offerId, metric_date: date, ad_spend: allocatedSpend });
    }
  }

  return {
    rows,
    reportRows: normalizeReportRows(report).length,
    campaigns: campaignIds.length
  };
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

async function fetchAllProductList() {
  const items = [];
  let lastId = "";
  const limit = 1000;

  while (true) {
    const response = await requestJson("/v3/product/list", {
      filter: { visibility: "ALL" },
      limit,
      last_id: lastId
    });
    const chunk = response.result?.items || [];
    items.push(...chunk);
    lastId = response.result?.last_id || "";
    if (!lastId || chunk.length < limit) break;
  }

  return items;
}

async function fetchCategoryLookup() {
  const response = await requestJson("/v1/description-category/tree", {
    language: "DEFAULT"
  });
  const lookup = new Map();

  function walk(nodes, categoryName = "") {
    for (const node of nodes || []) {
      const nextCategoryName = node.category_name || categoryName;
      if (node.type_id) {
        lookup.set(String(node.type_id), {
          category_name: categoryName,
          type_name: node.type_name || ""
        });
      }
      walk(node.children, nextCategoryName);
    }
  }

  walk(response.result || []);
  return lookup;
}

async function fetchAllStocks() {
  const items = [];
  let cursor = "";
  const limit = 1000;

  while (true) {
    const response = await requestJson("/v4/product/info/stocks", {
      filter: { visibility: "ALL" },
      limit,
      cursor
    });
    const chunk = response.items || [];
    items.push(...chunk);
    cursor = response.cursor || "";
    if (!cursor || chunk.length < limit) break;
  }

  return items;
}

function summarizeStock(item) {
  const summary = { fbo_stock: 0, fbs_stock: 0, ozon_sku: "" };
  for (const stock of item.stocks || []) {
    const present = Number(stock.present || 0);
    if (stock.sku && !summary.ozon_sku) summary.ozon_sku = String(stock.sku);
    if (stock.type === "fbo") summary.fbo_stock += present;
    if (stock.type === "fbs") summary.fbs_stock += present;
  }
  return summary;
}

async function fetchYesterdaySales() {
  const yesterday = moscowDateOffset(-1);
  const response = await requestJson("/v1/analytics/data", {
    date_from: yesterday,
    date_to: yesterday,
    metrics: ["ordered_units"],
    dimension: ["sku", "day"],
    filters: [],
    sort: [{ key: "ordered_units", order: "DESC" }],
    limit: 1000,
    offset: 0
  });

  const sales = new Map();
  for (const row of response.result?.data || []) {
    const sku = String(dimensionAt(row, 0) || dimensionValue(row, ["sku", "SKU"]));
    if (!sku) continue;
    sales.set(sku, (sales.get(sku) || 0) + (metricValue(row, 0) || 0));
  }
  return { date: yesterday, sales };
}

async function syncOzonProducts() {
  const listItems = await fetchAllProductList();
  const offerIds = listItems.map((product) => product.offer_id).filter(Boolean);
  const items = await fetchProductInfo(offerIds);
  const stockItems = await fetchAllStocks();
  const { date: yesterdayDate, sales: yesterdaySales } = await fetchYesterdaySales();
  const categoryLookup = await fetchCategoryLookup();
  const infoByOffer = new Map(items.map((item) => [String(item.offer_id || ""), item]));
  const stockByOffer = new Map(stockItems.map((item) => [String(item.offer_id || ""), summarizeStock(item)]));
  let updated = 0;

  for (const listItem of listItems) {
    const item = infoByOffer.get(String(listItem.offer_id || "")) || {};
    const stock = stockByOffer.get(String(listItem.offer_id || "")) || {};
    const sku = item.sku || item.sources?.[0]?.sku || item.stocks?.stocks?.[0]?.sku;
    const ozonSku = sku || stock.ozon_sku || "";
    const category = categoryLookup.get(String(item.type_id || "")) || {};
    if (!listItem.offer_id) continue;
    const primaryImage = Array.isArray(item.primary_image) ? item.primary_image[0] : "";
    await products.createProduct({
      offer_id: String(listItem.offer_id),
      product_id: String(item.id || ""),
      ozon_sku: String(ozonSku),
      description_category_id: item.description_category_id ? String(item.description_category_id) : "",
      type_id: item.type_id ? String(item.type_id) : "",
      category_name: category.category_name || "",
      type_name: category.type_name || "",
      title: item.name || "",
      image_url: primaryImage || item.images?.[0] || "",
      fbo_stock: stock.fbo_stock || 0,
      fbs_stock: stock.fbs_stock || 0,
      yesterday_sales: ozonSku ? yesterdaySales.get(String(ozonSku)) || 0 : 0
    });
    updated += 1;
  }

  return {
    requested: offerIds.length,
    returned: items.length,
    stockRows: stockItems.length,
    yesterdayDate,
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
  let adSync = { rows: [] };

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

  try {
    adSync = await fetchPerformanceAdSpend({ days, lookup });
    for (const row of adSync.rows) {
      const key = `${row.offer_id}:${row.metric_date}`;
      const existing = grouped.get(key) || {
        metric_date: row.metric_date,
        sales_units: 0,
        revenue: 0,
        ad_ratio: null
      };
      existing.ad_spend = (Number(existing.ad_spend) || 0) + (Number(row.ad_spend) || 0);
      existing.ad_ratio = existing.revenue > 0 ? Number(((existing.ad_spend / existing.revenue) * 100).toFixed(2)) : null;
      grouped.set(key, existing);
    }
  } catch (error) {
    adSync = {
      rows: [],
      warning: error.message,
      statusCode: error.statusCode || 500
    };
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
    adRowsFromOzon: adSync.rows.length,
    adWarning: adSync.warning || null,
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
