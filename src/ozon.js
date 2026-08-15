const https = require("https");
const fs = require("fs");
const path = require("path");
const { config } = require("./config");
const products = require("./products");
const inventory = require("./inventory");
const { query } = require("./db");

const OZON_API_HOST = "api-seller.ozon.ru";
const OZON_PERFORMANCE_HOST = "api-performance.ozon.ru";
const SELLER_API_INTERVAL_MS = 700;
const SELLER_API_RETRY_BASE_MS = 1600;

let sellerApiChain = Promise.resolve();

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function moscowDateOffset(daysOffset = 0) {
  const date = new Date(Date.now() + 3 * 60 * 60 * 1000);
  date.setUTCDate(date.getUTCDate() + daysOffset);
  return date.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJsonOnce(path, body) {
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
            error.statusCode = res.statusCode;
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

async function queuedRequestJson(path, body) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (attempt > 0) await sleep(SELLER_API_RETRY_BASE_MS * Math.pow(2, attempt - 1));
    try {
      const result = await requestJsonOnce(path, body);
      await sleep(SELLER_API_INTERVAL_MS);
      return result;
    } catch (error) {
      lastError = error;
      const isRateLimit = error.statusCode === 429 || /rate limit/i.test(error.message || "");
      if (!isRateLimit || attempt === 4) throw error;
    }
  }
  throw lastError;
}

function requestJson(path, body) {
  const task = sellerApiChain.catch(() => {}).then(() => queuedRequestJson(path, body));
  sellerApiChain = task.catch(() => {});
  return task;
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
    campaigns.push(...(response.list || []).map((campaign) => ({ ...campaign, requestedState: state })));
  }
  return campaigns;
}

function selectRunningProductCampaigns(campaigns) {
  return (campaigns || []).filter((campaign) => (
    String(campaign.requestedState || campaign.state || "").toUpperCase() === "CAMPAIGN_STATE_RUNNING"
    && ["SKU", "ALL_SKU_PROMO"].includes(campaign.advObjectType)
  ));
}

async function fetchCampaignProducts(token, campaignId) {
  try {
    const response = await performanceRequestJson(`/api/client/campaign/${encodeURIComponent(campaignId)}/v2/products`, { token });
    return (response.products || []).map((product) => String(product.sku || "")).filter(Boolean);
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404 || /not found|\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430/i.test(error.message || "")) return [];
    throw error;
  }
}

async function fetchCampaignProductDetails(token, campaignId) {
  try {
    const response = await performanceRequestJson(`/api/client/campaign/${encodeURIComponent(campaignId)}/v2/products`, { token });
    return response.products || [];
  } catch (error) {
    if (error.statusCode === 400 || error.statusCode === 404 || /not found|\u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430/i.test(error.message || "")) return [];
    throw error;
  }
}

function performanceMoney(value) {
  const raw = Number(value || 0);
  if (!Number.isFinite(raw)) return 0;
  return Math.abs(raw) >= 1000000 ? raw / 1000000 : raw;
}

async function ensurePerformanceCampaignSchema() {
  await query(`CREATE TABLE IF NOT EXISTS ozon_ad_campaigns (
    campaign_id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    adv_object_type TEXT NOT NULL DEFAULT '',
    budget_type TEXT NOT NULL DEFAULT '',
    daily_budget NUMERIC NOT NULL DEFAULT 0,
    weekly_budget NUMERIC NOT NULL DEFAULT 0,
    total_budget NUMERIC NOT NULL DEFAULT 0,
    expense_strategy TEXT NOT NULL DEFAULT '',
    controllable BOOLEAN NOT NULL DEFAULT FALSE,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ozon_ad_campaign_products (
    campaign_id TEXT NOT NULL REFERENCES ozon_ad_campaigns(campaign_id) ON DELETE CASCADE,
    sku TEXT NOT NULL,
    bid NUMERIC,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(campaign_id, sku)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS ozon_ad_campaign_products_sku_idx ON ozon_ad_campaign_products(sku)`);
}

async function syncPerformanceCampaignSnapshot() {
  await ensurePerformanceCampaignSchema();
  const token = await getPerformanceToken();
  const campaigns = await fetchPerformanceCampaigns(token);
  const controllableTypes = new Set(["SKU", "ALL_SKU_PROMO"]);
  let productLinks = 0;
  for (const campaign of campaigns) {
    const campaignId = String(campaign.id || "");
    if (!campaignId) continue;
    const controllable = controllableTypes.has(String(campaign.advObjectType || ""));
    await query(`INSERT INTO ozon_ad_campaigns
      (campaign_id,title,state,adv_object_type,budget_type,daily_budget,weekly_budget,total_budget,expense_strategy,controllable,raw,fetched_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT(campaign_id) DO UPDATE SET title=EXCLUDED.title,state=EXCLUDED.state,
        adv_object_type=EXCLUDED.adv_object_type,budget_type=EXCLUDED.budget_type,
        daily_budget=EXCLUDED.daily_budget,weekly_budget=EXCLUDED.weekly_budget,total_budget=EXCLUDED.total_budget,
        expense_strategy=EXCLUDED.expense_strategy,controllable=EXCLUDED.controllable,raw=EXCLUDED.raw,fetched_at=NOW()`, [
      campaignId, campaign.title || "", campaign.requestedState || campaign.state || "", campaign.advObjectType || "",
      campaign.budgetType || "", performanceMoney(campaign.dailyBudget), performanceMoney(campaign.weeklyBudget),
      performanceMoney(campaign.budget), campaign.expenseStrategy || "", controllable, JSON.stringify(campaign)
    ]);
    await query(`DELETE FROM ozon_ad_campaign_products WHERE campaign_id=$1`, [campaignId]);
    if (!controllable) continue;
    for (const item of await fetchCampaignProductDetails(token, campaignId)) {
      const sku = String(item.sku || "");
      if (!sku) continue;
      await query(`INSERT INTO ozon_ad_campaign_products(campaign_id,sku,bid,raw,fetched_at)
        VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT(campaign_id,sku) DO UPDATE SET
        bid=EXCLUDED.bid,raw=EXCLUDED.raw,fetched_at=NOW()`, [campaignId, sku, item.bid == null ? null : performanceMoney(item.bid), JSON.stringify(item)]);
      productLinks += 1;
    }
  }
  const campaignIds = campaigns.map((item) => String(item.id || "")).filter(Boolean);
  if (campaignIds.length) await query(`DELETE FROM ozon_ad_campaigns WHERE NOT (campaign_id = ANY($1::text[]))`, [campaignIds]);
  const running = campaigns.filter((item) => String(item.requestedState || item.state || "") === "CAMPAIGN_STATE_RUNNING");
  return {
    campaigns: campaigns.length,
    running: running.length,
    runningControllable: running.filter((item) => controllableTypes.has(String(item.advObjectType || ""))).length,
    productLinks,
    types: Object.fromEntries(Object.entries(campaigns.reduce((acc, item) => {
      const key = String(item.advObjectType || "UNKNOWN"); acc[key] = (acc[key] || 0) + 1; return acc;
    }, {})).sort())
  };
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
  const skuCampaigns = selectRunningProductCampaigns(campaigns);
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

async function fetchProductAttributes(offerIds) {
  const result = [];
  let lastId = "";

  while (true) {
    const response = await requestJson("/v4/product/info/attributes", {
      filter: {
        offer_id: offerIds,
        visibility: "ALL"
      },
      limit: 100,
      last_id: lastId
    });
    result.push(...(response.result || []));
    lastId = response.last_id || "";
    if (!lastId) break;
  }

  return result;
}

async function fetchProductDescription(offerId) {
  const response = await requestJson("/v1/product/info/description", { offer_id: offerId });
  return response.result || null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstValue(attributes, id) {
  const attribute = (attributes || []).find((item) => Number(item.id) === Number(id));
  return attribute?.values?.[0]?.value || "";
}

function normalizeString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeHashtags(value) {
  if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean).join(" ");
  return normalizeString(value);
}

function normalizeRichContent(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") {
    JSON.parse(value);
    return value;
  }
  return JSON.stringify(value);
}

function setStringAttribute(attributes, id, value) {
  if (value === undefined) return false;
  const text = id === 23171 ? normalizeHashtags(value) : normalizeString(value);
  if (!text) return false;

  const existing = attributes.find((item) => Number(item.id) === Number(id));
  const nextValues = [{ dictionary_value_id: 0, value: text }];
  if (existing) {
    existing.values = nextValues;
  } else {
    attributes.push({ id: Number(id), complex_id: 0, values: nextValues });
  }
  return true;
}

function buildImportItem(info, attributesItem, updates = {}) {
  const attributes = cloneJson(attributesItem.attributes || []);
  const changedAttributes = [];

  if (setStringAttribute(attributes, 4180, updates.title)) changedAttributes.push("Название");
  if (setStringAttribute(attributes, 4191, updates.description)) changedAttributes.push("Аннотация");
  if (setStringAttribute(attributes, 23171, updates.hashtags ?? updates.keywords)) changedAttributes.push("#Хештеги");
  if (setStringAttribute(attributes, 4384, updates.packageContents)) changedAttributes.push("Комплектация");
  if (updates.richContent !== undefined || updates.richContentJson !== undefined) {
    const richContent = normalizeRichContent(updates.richContent ?? updates.richContentJson);
    if (richContent) {
      setStringAttribute(attributes, 11254, richContent);
      changedAttributes.push("Rich-контент JSON");
    }
  }

  const title = normalizeString(updates.title) || attributesItem.name || info.name || firstValue(attributes, 4180);
  const images = Array.isArray(updates.images) && updates.images.length
    ? updates.images.map(normalizeString).filter(Boolean)
    : cloneJson(attributesItem.images || info.images || []);
  const primaryImage = normalizeString(updates.primaryImage || updates.primary_image) || attributesItem.primary_image || info.primary_image?.[0] || images[0] || "";

  return {
    item: {
      attributes,
      barcode: attributesItem.barcode || info.barcodes?.[0] || "",
      barcodes: attributesItem.barcodes || info.barcodes || [],
      description_category_id: Number(attributesItem.description_category_id || info.description_category_id),
      type_id: Number(attributesItem.type_id || info.type_id),
      dimension_unit: attributesItem.dimension_unit || "mm",
      height: Number(attributesItem.height || 0),
      depth: Number(attributesItem.depth || 0),
      width: Number(attributesItem.width || 0),
      weight: Number(attributesItem.weight || 0),
      weight_unit: attributesItem.weight_unit || "g",
      images,
      primary_image: primaryImage,
      name: title,
      offer_id: attributesItem.offer_id || info.offer_id,
      old_price: info.old_price || "",
      price: info.price || "",
      vat: info.vat || "0"
    },
    changedAttributes
  };
}

async function getOzonProductCard(offerId) {
  const [info] = await fetchProductInfo([offerId]);
  if (!info) {
    const error = new Error("Ozon product not found");
    error.statusCode = 404;
    throw error;
  }

  const [attributes] = await fetchProductAttributes([offerId]);
  const description = await fetchProductDescription(offerId);

  return {
    info,
    attributes,
    description,
    summary: {
      offer_id: info.offer_id,
      product_id: info.id,
      sku: info.sku || info.sources?.[0]?.sku || attributes?.sku || "",
      title: info.name,
      description: description?.description || firstValue(attributes?.attributes, 4191),
      hashtags: firstValue(attributes?.attributes, 23171),
      packageContents: firstValue(attributes?.attributes, 4384),
      richContentJson: firstValue(attributes?.attributes, 11254),
      primaryImage: info.primary_image?.[0] || attributes?.primary_image || "",
      images: info.images || attributes?.images || [],
      status: info.statuses?.status_name || "",
      validationStatus: info.statuses?.validation_status || "",
      moderationStatus: info.statuses?.moderate_status || ""
    }
  };
}

async function buildOzonProductUpdatePreview(offerId, updates = {}) {
  const card = await getOzonProductCard(offerId);
  const { item, changedAttributes } = buildImportItem(card.info, card.attributes, updates);

  return {
    offer_id: offerId,
    confirmText: `UPDATE_${offerId}`,
    changedAttributes,
    current: card.summary,
    next: {
      title: item.name,
      description: firstValue(item.attributes, 4191),
      hashtags: firstValue(item.attributes, 23171),
      packageContents: firstValue(item.attributes, 4384),
      richContentJson: firstValue(item.attributes, 11254),
      primaryImage: item.primary_image,
      images: item.images
    },
    importPayload: { items: [item] }
  };
}

function writeProductBackup(offerId, payload) {
  const dir = path.join(process.cwd(), "backups", "ozon-products");
  fs.mkdirSync(dir, { recursive: true });
  const safeOfferId = String(offerId).replace(/[^0-9A-Za-z_-]/g, "_");
  const filename = `${safeOfferId}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2));
  return fullPath;
}

async function submitOzonProductUpdate(offerId, updates = {}, confirm = "") {
  const preview = await buildOzonProductUpdatePreview(offerId, updates);
  if (confirm !== preview.confirmText) {
    const error = new Error(`Confirmation required: ${preview.confirmText}`);
    error.statusCode = 400;
    error.details = { confirmText: preview.confirmText, preview };
    throw error;
  }

  const backupPath = writeProductBackup(offerId, preview);
  const response = await requestJson("/v3/product/import", preview.importPayload);
  return {
    backupPath,
    response,
    preview: {
      offer_id: preview.offer_id,
      changedAttributes: preview.changedAttributes,
      current: preview.current,
      next: preview.next
    }
  };
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

async function syncOzonMetrics({ days = 30, trackedOnly = false } = {}) {
  await syncOzonProducts();
  const productRows = trackedOnly
    ? await products.listDailyTrackedProducts()
    : await products.listProducts({ limit: 1000 });
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
    trackedOnly,
    productsMatched: byOffer.size,
    rowsFromOzon: analyticsRows.length,
    adRowsFromOzon: adSync.rows.length,
    adWarning: adSync.warning || null,
    metricsSaved: savedCount
  };
}

function normalizeFinanceDate(value, fallback, endOfDay = false) {
  const source = String(value || fallback || "").slice(0, 19);
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) {
    return `${source}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(source)) {
    return `${source.replace(/Z$/, "")}Z`;
  }
  const day = moscowDateOffset(endOfDay ? 0 : -7);
  return `${day}T${endOfDay ? "23:59:59" : "00:00:00"}Z`;
}

function financeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function summarizeFinanceOperation(item) {
  const servicesTotal = (item.services || []).reduce((sum, service) => sum + financeNumber(service.price), 0);
  return {
    operation_id: item.operation_id || "",
    operation_type: item.operation_type || "",
    operation_date: item.operation_date || "",
    posting_number: item.posting?.posting_number || item.posting_number || "",
    amount: financeNumber(item.amount),
    accruals_for_sale: financeNumber(item.accruals_for_sale),
    sale_commission: financeNumber(item.sale_commission),
    services_total: Number(servicesTotal.toFixed(2)),
    items: (item.items || []).map((entry) => ({
      name: entry.name || "",
      sku: entry.sku || "",
      quantity: financeNumber(entry.quantity)
    }))
  };
}

async function listFinanceTransactions({ from, to, pageSize = 1000, includeItems = false } = {}) {
  const safePageSize = Math.min(Math.max(Number(pageSize) || 1000, 1), 1000);
  const dateFrom = normalizeFinanceDate(from, moscowDateOffset(-7), false);
  const dateTo = normalizeFinanceDate(to, moscowDateOffset(0), true);
  const operations = [];
  const byOperation = new Map();
  const totals = {
    amount: 0,
    accrualsForSale: 0,
    saleCommission: 0,
    services: 0
  };
  let pageCount = 1;
  let rowCount = 0;

  for (let page = 1; page <= pageCount && page <= 50; page += 1) {
    const response = await requestJson("/v3/finance/transaction/list", {
      filter: {
        date: {
          from: dateFrom,
          to: dateTo
        },
        operation_type: [],
        posting_number: "",
        transaction_type: "all"
      },
      page,
      page_size: safePageSize
    });

    const result = response.result || {};
    const chunk = result.operations || [];
    pageCount = Number(result.page_count || pageCount || 1);
    rowCount = Number(result.row_count || rowCount || chunk.length);

    for (const rawItem of chunk) {
      const item = summarizeFinanceOperation(rawItem);
      const operationType = item.operation_type || "unknown";
      const bucket = byOperation.get(operationType) || {
        operationType,
        count: 0,
        amount: 0,
        accrualsForSale: 0,
        saleCommission: 0,
        services: 0
      };

      bucket.count += 1;
      bucket.amount += item.amount;
      bucket.accrualsForSale += item.accruals_for_sale;
      bucket.saleCommission += item.sale_commission;
      bucket.services += item.services_total;
      byOperation.set(operationType, bucket);

      totals.amount += item.amount;
      totals.accrualsForSale += item.accruals_for_sale;
      totals.saleCommission += item.sale_commission;
      totals.services += item.services_total;
      if (includeItems) operations.push(item);
    }
  }

  const topOperations = Array.from(byOperation.values())
    .map((item) => ({
      operationType: item.operationType,
      count: item.count,
      amount: Number(item.amount.toFixed(2)),
      accrualsForSale: Number(item.accrualsForSale.toFixed(2)),
      saleCommission: Number(item.saleCommission.toFixed(2)),
      services: Number(item.services.toFixed(2))
    }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

  return {
    from: dateFrom,
    to: dateTo,
    pageSize: safePageSize,
    pageCount,
    rowCount,
    operationsFetched: includeItems ? operations.length : rowCount,
    totals: {
      amount: Number(totals.amount.toFixed(2)),
      accrualsForSale: Number(totals.accrualsForSale.toFixed(2)),
      saleCommission: Number(totals.saleCommission.toFixed(2)),
      services: Number(totals.services.toFixed(2))
    },
    topOperations,
    operations: includeItems ? operations : undefined
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

function postingClusterOf(warehouseName) {
  const warehouse = String(warehouseName || "").toUpperCase();
  if (!warehouse) return "UNKNOWN";
  if (/ЖУКОВСК|ХОРУГВ|ПУШКИН|ТВЕР|ПЕТРОВСК|МОСК|СОФЬИНО|ДОМОДЕД|ГРИВНО|ЦЕНТР/.test(warehouse)) {
    return "Центр / Москва";
  }
  if (/ЕКАТЕРИН|УРАЛ|ПЕРМ|ЧЕЛЯБ|ТЮМЕН/.test(warehouse)) return "Урал / Екатеринбург";
  if (/КАЗАН|САМАР|НИЖНИЙ|ПОВОЛЖ|ВОЛГ|УФА/.test(warehouse)) return "Поволжье / Казань-Самара";
  if (/РОСТОВ|КРАСНОДАР|НЕВИННОМ|ЮГ|АДЫГ|ВОЛГОГРАД/.test(warehouse)) return "Юг";
  if (/САНКТ|СПБ|ШУШАР|СЕВЕРО|ПЕТЕРБ/.test(warehouse)) return "Северо-Запад / СПБ";
  if (/НОВОСИБ|СИБИР|КРАСНОЯР|ОМСК/.test(warehouse)) return "Сибирь";
  if (/ХАБАР|ДАЛЬ|ВЛАДИВ|ИРКУТ/.test(warehouse)) return "Дальний Восток";
  return `OTHER / ${warehouseName}`;
}

function allocateQuantity(total, buckets) {
  const safeTotal = Math.max(0, Math.round(Number(total) || 0));
  const entries = Object.entries(buckets || {}).filter(([, value]) => Number(value) > 0);
  const basis = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0);
  if (!safeTotal || !basis) return [];

  const allocated = entries.map(([key, value]) => {
    const exact = (safeTotal * Number(value || 0)) / basis;
    const qty = Math.floor(exact);
    return { key, qty, remainder: exact - qty, basis: Number(value || 0) };
  });
  let remaining = safeTotal - allocated.reduce((sum, item) => sum + item.qty, 0);
  allocated
    .sort((a, b) => b.remainder - a.remainder || b.basis - a.basis)
    .forEach((item) => {
      if (remaining > 0) {
        item.qty += 1;
        remaining -= 1;
      }
    });
  return allocated
    .filter((item) => item.qty > 0)
    .sort((a, b) => b.qty - a.qty)
    .map(({ key, qty }) => ({ key, qty }));
}

function attachUnallocatedPool(data, unallocatedSnapshot) {
  const ageSeconds = Number(data.cache_age_seconds || 0);
  const timeFresh = !data.cached || ageSeconds <= 24 * 60 * 60;
  const sourceComplete = data.source_complete === true;
  const dataFresh = timeFresh && sourceComplete;
  const days = Math.max(1, Number(data.days || 30));
  return {
    ...data,
    data_fresh: dataFresh,
    allocation_allowed: dataFresh,
    source_complete: sourceComplete,
    freshness_limit_hours: 24,
    items: (data.items || []).map((item) => {
      const unallocated = unallocatedSnapshot.byOffer.get(String(item.offer_id)) || { pieces: 0, boxes: 0 };
      const pool = Number(unallocated.pieces || 0);
      const baseClusters = item.target_demand_clusters || item.recommended_demand_clusters || [];
      const deficits = baseClusters.map((cluster) => {
        const current = Number(cluster.current_stock || 0);
        const requested = Number(cluster.requested_stock || 0);
        const transit = Number(cluster.transit_stock || 0);
        const inbound = requested + transit;
        const target = Number(cluster.target_qty || 0);
        const gap = Math.max(0, target - current - inbound);
        const daily = Number(cluster.sales_basis || 0) / days;
        const coverDays = daily > 0 ? (current + inbound) / daily : null;
        const outOfStock = Number(cluster.sales_basis || 0) > 0 && current + inbound <= 0;
        const shortageLevel = outOfStock ? "out_of_stock" : coverDays !== null && coverDays < 3
          ? "under_3_days" : coverDays !== null && coverDays < 7 ? "under_7_days" : "low";
        return { ...cluster, inbound_stock: inbound, qty: gap, cover_days: coverDays === null ? null : Number(coverDays.toFixed(1)), out_of_stock: outOfStock, shortage_level: shortageLevel };
      }).filter((cluster) => cluster.qty > 0).sort((a, b) => {
        const rank = { out_of_stock: 0, under_3_days: 1, under_7_days: 2, low: 3 };
        return rank[a.shortage_level] - rank[b.shortage_level]
          || Number(b.sales_basis || 0) - Number(a.sales_basis || 0)
          || Number(b.qty || 0) - Number(a.qty || 0);
      });
      let remainingPool = dataFresh ? pool : 0;
      const allocations = deficits.map((cluster) => {
        const allocateQty = Math.min(Number(cluster.qty || 0), remainingPool);
        remainingPool -= allocateQty;
        return { ...cluster, allocate_from_unallocated: allocateQty, remaining_gap: Number(cluster.qty || 0) - allocateQty };
      });
      const recommendedTotal = deficits.reduce((sum, cluster) => sum + Number(cluster.qty || 0), 0);
      const allocatedTotal = allocations.reduce((sum, cluster) => sum + Number(cluster.allocate_from_unallocated || 0), 0);
      const shortfall = Math.max(0, recommendedTotal - allocatedTotal);
      const totalAvailableStock = Number(item.stock_total || 0) + pool;
      const totalCoverDays = Number(item.avg_daily || 0) > 0 ? totalAvailableStock / Number(item.avg_daily) : null;
      let suggestion = item.suggestion;
      if (!sourceComplete) suggestion = "Ozon地区库存源不完整，禁止生成分配数量";
      else if (!timeFresh) suggestion = "地区补仓数据超过24小时，请刷新后分配";
      else if (recommendedTotal > 0 && pool <= 0) suggestion = `地区缺口${recommendedTotal}件，未分配库存为0，需要采购或调拨`;
      else if (shortfall > 0) suggestion = `从未分配库存分配${allocatedTotal}件，仍缺${shortfall}件`;
      else if (allocatedTotal > 0) suggestion = `从未分配库存分配${allocatedTotal}件，可覆盖当前地区缺口`;
      return {
        ...item,
        unallocated_stock: pool,
        unallocated_boxes: Number(unallocated.boxes || 0),
        total_available_stock: totalAvailableStock,
        total_available_cover_days: totalCoverDays === null ? null : Number(totalCoverDays.toFixed(1)),
        recommended_total: recommendedTotal,
        recommended_demand_clusters: allocations,
        regional_out_of_stock_count: deficits.filter((cluster) => cluster.out_of_stock).length,
        unallocated_allocated_total: allocatedTotal,
        unallocated_remaining: Math.max(0, pool - allocatedTotal),
        replenishment_shortfall: shortfall,
        suggestion,
      };
    })
  };
}

async function fetchClusterStocksBySku(skus) {
  const cleanSkus = Array.from(
    new Set((skus || []).map((sku) => String(sku || "").trim()).filter(Boolean))
  );
  const bySku = new Map();
  const errors = [];
  const chunkSize = 20;

  for (let index = 0; index < cleanSkus.length; index += chunkSize) {
    const chunk = cleanSkus.slice(index, index + chunkSize);
    let offset = 0;
    const limit = 1000;

    for (let page = 0; page < 20; page += 1) {
      let response;
      try {
        response = await requestJson("/v1/analytics/stocks", {
          skus: chunk,
          limit,
          offset
        });
      } catch (error) {
        console.warn("[cluster-stocks]", error.message);
        errors.push(error.message);
        break;
      }
      const rows = response.items || [];
      for (const row of rows) {
        const sku = String(row.sku || "");
        const cluster = String(row.cluster_name || "UNKNOWN");
        if (!sku || !cluster) continue;
        const skuMap = bySku.get(sku) || {};
        const current = skuMap[cluster] || {
          available: 0,
          valid: 0,
          requested: 0,
          transit: 0
        };
        current.available += Number(row.available_stock_count || 0);
        current.valid += Number(row.valid_stock_count || 0);
        current.requested += Number(row.requested_stock_count || 0);
        current.transit += Number(row.transit_stock_count || 0);
        skuMap[cluster] = current;
        bySku.set(sku, skuMap);
      }
      if (rows.length < limit) break;
      offset += limit;
    }
  }

  return { bySku, errors };
}

async function fetchFboPostings({ days = 30 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 60);
  const to = new Date();
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  const postings = [];
  const limit = 1000;
  let offset = 0;

  for (let page = 0; page < 30; page += 1) {
    const response = await requestJson("/v2/posting/fbo/list", {
      dir: "ASC",
      filter: {
        since: since.toISOString(),
        to: to.toISOString()
      },
      limit,
      offset,
      translit: false,
      with: {
        analytics_data: true,
        financial_data: true
      }
    });
    const chunk = response.result?.postings || response.result || [];
    if (!Array.isArray(chunk) || !chunk.length) break;
    postings.push(...chunk);
    if (chunk.length < limit) break;
    offset += limit;
  }

  return {
    since: since.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
    postings
  };
}

function summarizePostingsByOffer(postings, wantedOffers = new Set()) {
  const byOffer = new Map();
  for (const posting of postings || []) {
    const day = String(posting.created_at || "").slice(0, 10);
    const warehouse = posting.analytics_data?.warehouse_name || "UNKNOWN";
    const warehouseCluster = posting.financial_data?.cluster_from || postingClusterOf(warehouse);
    const demandCluster = posting.financial_data?.cluster_to || posting.analytics_data?.city || warehouseCluster;
    for (const product of posting.products || []) {
      const offerId = String(product.offer_id || "");
      if (!offerId || (wantedOffers.size && !wantedOffers.has(offerId))) continue;
      const qty = Number(product.quantity || 0);
      const item = byOffer.get(offerId) || {
        offer_id: offerId,
        ozon_sku: String(product.sku || ""),
        title: product.name || "",
        posting_units: 0,
        clusters: {},
        demand_clusters: {},
        warehouse_clusters: {},
        warehouses: {},
        days: {}
      };
      item.posting_units += qty;
      item.clusters[demandCluster] = (item.clusters[demandCluster] || 0) + qty;
      item.demand_clusters[demandCluster] = (item.demand_clusters[demandCluster] || 0) + qty;
      item.warehouse_clusters[warehouseCluster] = (item.warehouse_clusters[warehouseCluster] || 0) + qty;
      item.warehouses[warehouse] = (item.warehouses[warehouse] || 0) + qty;
      if (day) {
        item.days[day] = item.days[day] || {};
        item.days[day][demandCluster] = (item.days[day][demandCluster] || 0) + qty;
      }
      byOffer.set(offerId, item);
    }
  }
  return byOffer;
}

function sumMetricRows(rows) {
  return (rows || []).reduce(
    (acc, row) => {
      acc.sales += Number(row.sales_units || 0);
      acc.revenue += Number(row.revenue || 0);
      return acc;
    },
    { sales: 0, revenue: 0 }
  );
}

const fboReplenishmentCache = new Map();
const fboReplenishmentRefreshes = new Set();
const fboReplenishmentRefreshStatus = new Map();
const FBO_REPLENISHMENT_CACHE_FILE = path.join(__dirname, "..", "data", "fbo-replenishment-cache.json");
const FBO_REPLENISHMENT_CACHE_MS = 6 * 60 * 60 * 1000;

function fboReplenishmentCacheKey({ days, targetDays, offers }) {
  return JSON.stringify({
    version: "demand-cluster-stock-v3",
    days: Number(days),
    targetDays: Number(targetDays),
    offers: String(offers || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .sort()
  });
}

function cachedPayload(entry) {
  const savedAt = Number(entry.saved_at || 0);
  const ageSeconds = Math.round((Date.now() - savedAt) / 1000);
  const stale = ageSeconds * 1000 >= FBO_REPLENISHMENT_CACHE_MS;
  return {
    ...entry.data,
    cached: true,
    cache_stale: stale,
    cache_age_seconds: ageSeconds,
    cache_saved_at: savedAt ? new Date(savedAt).toISOString() : ""
  };
}

function startFboReplenishmentRefresh(cacheKey, params = {}) {
  if (fboReplenishmentRefreshes.has(cacheKey)) {
    return fboReplenishmentRefreshStatus.get(cacheKey) || { running: true };
  }

  const startedAt = new Date().toISOString();
  const status = {
    running: true,
    startedAt,
    finishedAt: "",
    lastOkAt: "",
    lastError: "",
    cacheKey
  };
  fboReplenishmentRefreshes.add(cacheKey);
  fboReplenishmentRefreshStatus.set(cacheKey, status);

  listFboClusterReplenishment({ ...params, refresh: true, compact: false, background: true, force: true })
    .then((result) => {
      status.lastOkAt = new Date().toISOString();
      status.since = result?.since || "";
      status.to = result?.to || "";
      status.count = result?.count || 0;
    })
    .catch((error) => {
      status.lastError = error && error.message ? error.message : String(error);
      console.warn("[fbo-replenishment-refresh]", status.lastError);
    })
    .finally(() => {
      status.running = false;
      status.finishedAt = new Date().toISOString();
      fboReplenishmentRefreshes.delete(cacheKey);
    });

  return status;
}

function getFboReplenishmentRefreshStatus({ days = 30, targetDays = 30, offers = "" } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 60);
  const safeTargetDays = Math.min(Math.max(Number(targetDays) || 30, 7), 90);
  const cacheKey = fboReplenishmentCacheKey({ days: safeDays, targetDays: safeTargetDays, offers });
  const cached = readFboReplenishmentCache(cacheKey, { allowStale: true });
  return {
    running: fboReplenishmentRefreshes.has(cacheKey),
    ...(fboReplenishmentRefreshStatus.get(cacheKey) || {}),
    cached: Boolean(cached),
    cache_saved_at: cached?.cache_saved_at || "",
    cache_since: cached?.since || "",
    cache_to: cached?.to || "",
    cache_age_seconds: cached?.cache_age_seconds ?? null
  };
}

function readFboReplenishmentCache(cacheKey, { allowStale = true } = {}) {
  const memory = fboReplenishmentCache.get(cacheKey);
  if (memory && (allowStale || Date.now() - Number(memory.saved_at || 0) < FBO_REPLENISHMENT_CACHE_MS)) {
    return cachedPayload(memory);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(FBO_REPLENISHMENT_CACHE_FILE, "utf8"));
    const entry = parsed[cacheKey];
    if (entry && (allowStale || Date.now() - Number(entry.saved_at || 0) < FBO_REPLENISHMENT_CACHE_MS)) {
      fboReplenishmentCache.set(cacheKey, entry);
      return cachedPayload(entry);
    }
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("[fbo-replenishment-cache:read]", error.message);
  }
  return null;
}

function writeFboReplenishmentCache(cacheKey, data) {
  const entry = { saved_at: Date.now(), data };
  fboReplenishmentCache.set(cacheKey, entry);
  try {
    fs.mkdirSync(path.dirname(FBO_REPLENISHMENT_CACHE_FILE), { recursive: true });
    let parsed = {};
    try {
      parsed = JSON.parse(fs.readFileSync(FBO_REPLENISHMENT_CACHE_FILE, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") parsed = {};
    }
    parsed[cacheKey] = entry;
    fs.writeFileSync(FBO_REPLENISHMENT_CACHE_FILE, JSON.stringify(parsed, null, 2));
  } catch (error) {
    console.warn("[fbo-replenishment-cache:write]", error.message);
  }
}

function compactFboReplenishmentData(data) {
  return {
    ...data,
    compact: true,
    items: (data.items || []).map((item) => ({
      offer_id: item.offer_id,
      product_id: item.product_id,
      ozon_sku: item.ozon_sku,
      title: item.title,
      image_url: item.image_url,
      fbo_stock: item.fbo_stock,
      fbs_stock: item.fbs_stock,
      stock_total: item.stock_total,
      sales_7d: item.sales_7d,
      sales_period: item.sales_period,
      posting_units_period: item.posting_units_period,
      avg_daily: item.avg_daily,
      cover_days: item.cover_days,
      target_days: item.target_days,
      recommended_total: item.recommended_total,
      recommended_demand_clusters: item.recommended_demand_clusters,
      unallocated_stock: item.unallocated_stock,
      unallocated_boxes: item.unallocated_boxes,
      total_available_stock: item.total_available_stock,
      total_available_cover_days: item.total_available_cover_days,
      regional_out_of_stock_count: item.regional_out_of_stock_count,
      unallocated_allocated_total: item.unallocated_allocated_total,
      unallocated_remaining: item.unallocated_remaining,
      replenishment_shortfall: item.replenishment_shortfall,
      cluster_stock_total: item.cluster_stock_total,
      suggestion: item.suggestion,
      priority: item.priority
    }))
  };
}

async function listFboClusterReplenishment({ days = 30, targetDays = 30, offers = "", refresh = false, compact = false, background = false, force = false } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 60);
  const safeTargetDays = Math.min(Math.max(Number(targetDays) || 30, 7), 90);
  const cacheKey = fboReplenishmentCacheKey({ days: safeDays, targetDays: safeTargetDays, offers });
  const cached = readFboReplenishmentCache(cacheKey, { allowStale: true });
  const unallocatedSnapshot = await inventory.listUnallocatedAssignments();
  if (refresh && cached && !background) {
    const refreshStatus = startFboReplenishmentRefresh(cacheKey, {
      days: safeDays,
      targetDays: safeTargetDays,
      offers
    });
    const response = {
      ...cached,
      refresh_started: true,
      refresh_status: refreshStatus,
      force_refresh: Boolean(force)
    };
    const enriched = attachUnallocatedPool(response, unallocatedSnapshot);
    return compact ? compactFboReplenishmentData(enriched) : enriched;
  }
  if (!refresh && cached && !force) {
    const enriched = attachUnallocatedPool(cached, unallocatedSnapshot);
    return compact ? compactFboReplenishmentData(enriched) : enriched;
  }

  const wantedOffers = new Set(
    String(offers || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  const productRows = await products.listProducts({ limit: 1000 });
  const filteredProducts = wantedOffers.size
    ? productRows.filter((product) => wantedOffers.has(String(product.offer_id || "")))
    : productRows;

  const { since, to, postings } = await fetchFboPostings({ days: safeDays });
  const postingByOffer = summarizePostingsByOffer(postings, wantedOffers);
  const stockSkus = new Set();
  for (const product of filteredProducts) {
    const offerId = String(product.offer_id || "");
    const postingSummary = postingByOffer.get(offerId);
    if (!postingSummary && !wantedOffers.size) continue;
    if (product.ozon_sku) stockSkus.add(String(product.ozon_sku));
    if (postingSummary?.ozon_sku) stockSkus.add(String(postingSummary.ozon_sku));
  }
  const clusterStockResult = await fetchClusterStocksBySku(Array.from(stockSkus));
  const clusterStockBySku = clusterStockResult.bySku;
  const results = [];

  for (const product of filteredProducts) {
    const offerId = String(product.offer_id || "");
    if (!offerId) continue;
    const metrics = await products.listMetrics(offerId, { days: safeDays });
    const metricTotals = sumMetricRows(metrics);
    const last7Totals = sumMetricRows(metrics.slice(-7));
    const avg7 = metrics.length ? last7Totals.sales / Math.min(7, metrics.length) : 0;
    const avgPeriod = metrics.length ? metricTotals.sales / metrics.length : 0;
    const postingSummary = postingByOffer.get(offerId) || {
      posting_units: 0,
      clusters: {},
      demand_clusters: {},
      warehouse_clusters: {},
      warehouses: {},
      days: {}
    };
    const postingAvg = postingSummary.posting_units ? postingSummary.posting_units / safeDays : 0;
    const dailyRate = Math.max(avg7, avgPeriod, postingAvg);
    const ozonSku = String(product.ozon_sku || postingSummary.ozon_sku || "");
    const clusterStocks = clusterStockBySku.get(ozonSku) || {};
    const clusterStockTotal = Object.values(clusterStocks).reduce(
      (sum, item) => sum + Number(item.available || 0),
      0
    );
    const fboStock = clusterStockTotal || Number(product.fbo_stock || 0);
    const fbsStock = Number(product.fbs_stock || 0);
    const totalStock = fboStock + fbsStock;
    const coverDays = dailyRate > 0 ? totalStock / dailyRate : null;
    const targetStock = dailyRate > 0 ? Math.ceil(dailyRate * safeTargetDays) : 0;
    const demandBuckets = postingSummary.demand_clusters || postingSummary.clusters || {};
    const targetDemandClusters = allocateQuantity(targetStock, demandBuckets).map((item) => {
      const stock = clusterStocks[item.key] || {};
      const currentStock = Number(stock.available || 0);
      const requestedStock = Number(stock.requested || 0);
      const transitStock = Number(stock.transit || 0);
      const qty = Math.max(0, item.qty - currentStock - requestedStock - transitStock);
      return {
        cluster: item.key,
        qty,
        target_qty: item.qty,
        current_stock: currentStock,
        valid_stock: Number(stock.valid || 0),
        requested_stock: requestedStock,
        transit_stock: transitStock,
        sales_basis: Number(demandBuckets[item.key] || 0)
      };
    });
    const recommendedTotal = targetDemandClusters.reduce((sum, item) => sum + item.qty, 0);

    let priority = 0;
    let suggestion = "暂不补";
    if (dailyRate > 0 && totalStock <= 0) {
      priority = 100;
      suggestion = "已断货：优先补FBO";
    } else if (dailyRate >= 1 && coverDays !== null && coverDays < 7) {
      priority = 90;
      suggestion = "急补FBO，覆盖不足7天";
    } else if (dailyRate >= 0.5 && coverDays !== null && coverDays < 14) {
      priority = 75;
      suggestion = "补FBO，覆盖不足14天";
    } else if (metricTotals.sales > 0 && fboStock <= 0 && fbsStock > 0) {
      priority = 70;
      suggestion = "FBO为0：从FBS/现货补到FBO";
    } else if (metricTotals.sales > 0 && coverDays !== null && coverDays < 21) {
      priority = 55;
      suggestion = "观察并小批补FBO";
    }

    const warehouseAllocations = allocateQuantity(recommendedTotal, postingSummary.warehouses).map((item) => ({
      warehouse: item.key,
      cluster: postingClusterOf(item.key),
      qty: item.qty,
      sales_basis: Number(postingSummary.warehouses[item.key] || 0)
    }));
    const clusterAllocations = allocateQuantity(recommendedTotal, postingSummary.clusters).map((item) => ({
      cluster: item.key,
      qty: item.qty,
      sales_basis: Number(postingSummary.clusters[item.key] || 0)
    }));
    const demandClusterAllocations = targetDemandClusters.filter((item) => item.qty > 0);

    if (priority > 0 || wantedOffers.size) {
      results.push({
        offer_id: offerId,
        product_id: String(product.product_id || ""),
        ozon_sku: ozonSku,
        title: product.title || postingSummary.title || "",
        image_url: product.image_url || "",
        fbo_stock: fboStock,
        fbs_stock: fbsStock,
        stock_total: totalStock,
        sales_7d: Number(last7Totals.sales.toFixed(2)),
        sales_period: Number(metricTotals.sales.toFixed(2)),
        posting_units_period: Number((postingSummary.posting_units || 0).toFixed(2)),
        avg_daily: Number(dailyRate.toFixed(2)),
        cover_days: coverDays === null ? null : Number(coverDays.toFixed(1)),
        target_days: safeTargetDays,
        recommended_total: recommendedTotal,
        recommended_warehouses: warehouseAllocations,
        recommended_clusters: clusterAllocations,
        recommended_demand_clusters: demandClusterAllocations,
        target_demand_clusters: targetDemandClusters,
        cluster_stocks: clusterStocks,
        cluster_stock_total: clusterStockTotal,
        calculation_basis: "cluster_to demand share; target cluster stock minus current available_stock_count",
        sales_warehouses: Object.fromEntries(Object.entries(postingSummary.warehouses || {}).sort((a, b) => b[1] - a[1])),
        sales_clusters: Object.fromEntries(Object.entries(postingSummary.clusters || {}).sort((a, b) => b[1] - a[1])),
        sales_demand_clusters: Object.fromEntries(Object.entries(postingSummary.demand_clusters || postingSummary.clusters || {}).sort((a, b) => b[1] - a[1])),
        sales_warehouse_clusters: Object.fromEntries(Object.entries(postingSummary.warehouse_clusters || {}).sort((a, b) => b[1] - a[1])),
        suggestion,
        priority
      });
    }
  }

  const data = {
    since,
    to,
    days: safeDays,
    target_days: safeTargetDays,
    postings_fetched: postings.length,
    source_complete: clusterStockResult.errors.length === 0,
    source_errors: Array.from(new Set(clusterStockResult.errors)),
    count: results.length,
    items: results.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.sales_7d - a.sales_7d ||
        b.sales_period - a.sales_period ||
        b.recommended_total - a.recommended_total
    )
  };
  writeFboReplenishmentCache(cacheKey, data);
  const enriched = attachUnallocatedPool(data, unallocatedSnapshot);
  return compact ? compactFboReplenishmentData(enriched) : enriched;
}

module.exports = {
  buildOzonProductUpdatePreview,
  getOzonProductCard,
  listFinanceTransactions,
  getFboReplenishmentRefreshStatus,
  listFboClusterReplenishment,
  previewOzonAnalytics,
  submitOzonProductUpdate,
  syncOzonMetrics,
  syncOzonProducts,
  syncPerformanceCampaignSnapshot,
  selectRunningProductCampaigns
};
