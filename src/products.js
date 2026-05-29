const { query } = require("./db");

const memoryProducts = new Map();

const PUBLIC_FIELDS = [
  "offer_id",
  "product_id",
  "ozon_sku",
  "description_category_id",
  "type_id",
  "category_name",
  "type_name",
  "title",
  "image_url",
  "fbo_stock",
  "fbs_stock",
  "yesterday_sales",
  "strategy",
  "commission_rate",
  "purchase_cost",
  "weight",
  "freight_rate",
  "return_rate",
  "ad_ratio",
  "price",
  "competitor_compare"
];

const ALIASES = {
  sku: "offer_id",
  SKU: "offer_id",
  offerId: "offer_id",
  productId: "product_id",
  ozonSku: "ozon_sku",
  sku_id: "ozon_sku",
  descriptionCategoryId: "description_category_id",
  description_category_id: "description_category_id",
  typeId: "type_id",
  type_id: "type_id",
  categoryName: "category_name",
  category_name: "category_name",
  typeName: "type_name",
  type_name: "type_name",
  image: "image_url",
  imageUrl: "image_url",
  mainImage: "image_url",
  productImage: "image_url",
  product_image: "image_url",
  fboStock: "fbo_stock",
  fbo_stock: "fbo_stock",
  fbsStock: "fbs_stock",
  fbs_stock: "fbs_stock",
  yesterdaySales: "yesterday_sales",
  yesterday_sales: "yesterday_sales",
  commission: "commission_rate",
  commissionRate: "commission_rate",
  commission_rate: "commission_rate",
  purchaseCost: "purchase_cost",
  purchasePrice: "purchase_cost",
  purchase_cost: "purchase_cost",
  freightRate: "freight_rate",
  freight_rate: "freight_rate",
  returnRate: "return_rate",
  return_rate: "return_rate",
  adRatio: "ad_ratio",
  ad_ratio: "ad_ratio",
  salePrice: "price",
  sellingPrice: "price",
  competitorCompare: "competitor_compare",
  competitor_compare: "competitor_compare",
  "\u5546\u54c1\u56fe\u7247": "image_url",
  "\u56fe\u7247": "image_url",
  "\u4e3b\u56fe": "image_url",
  "FBO\u5e93\u5b58\u6570": "fbo_stock",
  "FBS\u5e93\u5b58\u6570": "fbs_stock",
  "\u6628\u65e5\u9500\u91cf": "yesterday_sales",
  "\u4f63\u91d1": "commission_rate",
  "\u4f63\u91d1\u7387": "commission_rate",
  "\u91c7\u8d2d\u6210\u672c": "purchase_cost",
  "\u91c7\u8d2d\u4ef7": "purchase_cost",
  "\u91cd\u91cf": "weight",
  "\u8fd0\u8d39\u7cfb\u6570": "freight_rate",
  "\u9000\u8d27\u7387": "return_rate",
  "\u5e7f\u544a\u6bd4\u4f8b": "ad_ratio",
  "\u552e\u4ef7": "price",
  "\u4ef7\u683c": "price",
  "\u7ade\u54c1\u5bf9\u6bd4": "competitor_compare",
  "\u7ade\u54c1\u4fe1\u606f": "competitor_compare",
  "\u4ea7\u54c1\u7b56\u7565": "strategy",
  "\u6807\u9898": "title"
};

const NUMERIC_FIELDS = new Set([
  "commission_rate",
  "fbo_stock",
  "fbs_stock",
  "yesterday_sales",
  "purchase_cost",
  "weight",
  "freight_rate",
  "return_rate",
  "ad_ratio",
  "price"
]);

function normalizeNumeric(value) {
  if (value === "" || value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).replace(/[,，%]/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInput(payload) {
  const out = {};
  for (const [key, value] of Object.entries(payload || {})) {
    const normalizedKey = ALIASES[key] || key;
    if (!PUBLIC_FIELDS.includes(normalizedKey)) continue;
    out[normalizedKey] = NUMERIC_FIELDS.has(normalizedKey) ? normalizeNumeric(value) : value ?? "";
  }
  return out;
}

function productSelect() {
  return `
    id,
    offer_id,
    product_id,
    ozon_sku,
    description_category_id,
    type_id,
    category_name,
    type_name,
    title,
    image_url,
    fbo_stock,
    fbs_stock,
    yesterday_sales,
    strategy,
    commission_rate,
    purchase_cost,
    weight,
    freight_rate,
    return_rate,
    ad_ratio,
    price,
    competitor_compare,
    created_at,
    updated_at
  `;
}

async function listProducts({ search = "", limit = 500, offset = 0 } = {}) {
  if (process.env.MEMORY_STORE === "true") {
    const all = Array.from(memoryProducts.values());
    const filtered = search
      ? all.filter((item) => [item.offer_id, item.product_id, item.title].some((value) => String(value || "").toLowerCase().includes(String(search).toLowerCase())))
      : all;
    return filtered.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 500));
  }

  const cappedLimit = Math.min(Math.max(Number(limit) || 500, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const params = [];
  let where = "";

  if (search) {
    params.push(`%${search}%`);
    where = `WHERE offer_id ILIKE $1 OR product_id ILIKE $1 OR title ILIKE $1`;
  }

  params.push(cappedLimit, safeOffset);
  const limitParam = params.length - 1;
  const offsetParam = params.length;

  const result = await query(
    `SELECT ${productSelect()}
     FROM products
     ${where}
     ORDER BY updated_at DESC, id DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    params
  );
  return result.rows;
}

async function getProduct(offerId) {
  if (process.env.MEMORY_STORE === "true") {
    return memoryProducts.get(offerId) || null;
  }

  const result = await query(`SELECT ${productSelect()} FROM products WHERE offer_id = $1`, [offerId]);
  return result.rows[0] || null;
}

async function createProduct(payload) {
  const data = normalizeInput(payload);
  if (!data.offer_id) {
    const error = new Error("offer_id is required");
    error.statusCode = 400;
    throw error;
  }

  if (process.env.MEMORY_STORE === "true") {
    const now = new Date().toISOString();
    const existing = memoryProducts.get(data.offer_id) || {};
    const product = {
      id: existing.id || memoryProducts.size + 1,
      created_at: existing.created_at || now,
      updated_at: now,
      ...existing,
      ...data
    };
    memoryProducts.set(data.offer_id, product);
    return product;
  }

  const fields = Object.keys(data);
  const params = fields.map((field) => data[field]);
  const placeholders = fields.map((_, index) => `$${index + 1}`);
  const updates = fields
    .filter((field) => field !== "offer_id")
    .map((field) => `${field} = EXCLUDED.${field}`);

  const result = await query(
    `INSERT INTO products (${fields.join(", ")})
     VALUES (${placeholders.join(", ")})
     ON CONFLICT (offer_id) DO UPDATE SET ${updates.length ? updates.join(", ") : "offer_id = EXCLUDED.offer_id"}
     RETURNING ${productSelect()}`,
    params
  );
  return result.rows[0];
}

async function importProducts(items) {
  if (!Array.isArray(items)) {
    const error = new Error("products must be an array");
    error.statusCode = 400;
    throw error;
  }

  const imported = [];
  const skipped = [];
  for (const item of items) {
    try {
      const source = item.raw ? { ...item, ...item.raw } : item;
      const product = await createProduct(source);
      imported.push(product);
    } catch (error) {
      skipped.push({
        item,
        error: error.message
      });
    }
  }

  return {
    importedCount: imported.length,
    skippedCount: skipped.length,
    imported,
    skipped
  };
}

async function updateProduct(offerId, payload) {
  const data = normalizeInput(payload);
  delete data.offer_id;
  if (process.env.MEMORY_STORE === "true") {
    const existing = memoryProducts.get(offerId);
    if (!existing) {
      const error = new Error("Product not found");
      error.statusCode = 404;
      throw error;
    }
    const product = { ...existing, ...data, updated_at: new Date().toISOString() };
    memoryProducts.set(offerId, product);
    return product;
  }

  if (Object.keys(data).length === 0) {
    const existing = await getProduct(offerId);
    if (!existing) {
      const error = new Error("Product not found");
      error.statusCode = 404;
      throw error;
    }
    return existing;
  }

  const fields = Object.keys(data);
  const params = fields.map((field) => data[field]);
  params.push(offerId);
  const assignments = fields.map((field, index) => `${field} = $${index + 1}`);

  const result = await query(
    `UPDATE products
     SET ${assignments.join(", ")}
     WHERE offer_id = $${params.length}
     RETURNING ${productSelect()}`,
    params
  );

  if (!result.rows[0]) {
    const error = new Error("Product not found");
    error.statusCode = 404;
    throw error;
  }
  return result.rows[0];
}

async function deleteProduct(offerId) {
  if (process.env.MEMORY_STORE === "true") {
    return memoryProducts.delete(offerId);
  }

  const result = await query("DELETE FROM products WHERE offer_id = $1 RETURNING offer_id", [offerId]);
  return Boolean(result.rows[0]);
}

async function dashboard() {
  const products = await listProducts({ limit: 1000 });
  const summary = products.reduce(
    (acc, product) => {
      acc.productCount += 1;
      acc.totalPrice += Number(product.price || 0);
      acc.missingImageCount += product.image_url ? 0 : 1;
      acc.missingCompetitorCount += product.competitor_compare ? 0 : 1;
      acc.missingPriceCount += product.price === null ? 1 : 0;
      acc.missingCommissionCount += product.commission_rate === null ? 1 : 0;
      return acc;
    },
    {
      productCount: 0,
      totalPrice: 0,
      missingImageCount: 0,
      missingCompetitorCount: 0,
      missingPriceCount: 0,
      missingCommissionCount: 0
    }
  );

  return {
    summary,
    products,
    fetchedAt: new Date().toISOString(),
    source: { provider: "postgres" }
  };
}

async function listMetrics(offerId, { days = 30 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 30, 1), 120);
  if (process.env.MEMORY_STORE === "true") {
    return [];
  }

  const result = await query(
    `SELECT
       metric_date,
       sales_units,
       ad_ratio,
       ad_spend,
       revenue,
       updated_at
     FROM product_daily_metrics
     WHERE offer_id = $1
       AND metric_date >= CURRENT_DATE - ($2::int - 1)
     ORDER BY metric_date ASC`,
    [offerId, safeDays]
  );
  return result.rows;
}

async function upsertMetrics(offerId, metrics) {
  if (!Array.isArray(metrics)) {
    const error = new Error("metrics must be an array");
    error.statusCode = 400;
    throw error;
  }

  const product = await getProduct(offerId);
  if (!product) {
    const error = new Error("Product not found");
    error.statusCode = 404;
    throw error;
  }

  const saved = [];
  for (const metric of metrics) {
    const metricDate = metric.metric_date || metric.date;
    if (!metricDate) continue;
    const result = await query(
      `INSERT INTO product_daily_metrics (
         offer_id,
         metric_date,
         sales_units,
         ad_ratio,
         ad_spend,
         revenue
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (offer_id, metric_date) DO UPDATE SET
         sales_units = COALESCE(EXCLUDED.sales_units, product_daily_metrics.sales_units),
         ad_ratio = COALESCE(EXCLUDED.ad_ratio, product_daily_metrics.ad_ratio),
         ad_spend = COALESCE(EXCLUDED.ad_spend, product_daily_metrics.ad_spend),
         revenue = COALESCE(EXCLUDED.revenue, product_daily_metrics.revenue)
       RETURNING metric_date, sales_units, ad_ratio, ad_spend, revenue, updated_at`,
      [
        offerId,
        metricDate,
        normalizeNumeric(metric.sales_units ?? metric.sales ?? metric.orders),
        normalizeNumeric(metric.ad_ratio ?? metric.adRatio),
        normalizeNumeric(metric.ad_spend ?? metric.adSpend),
        normalizeNumeric(metric.revenue)
      ]
    );
    saved.push(result.rows[0]);
  }

  return saved;
}

module.exports = {
  createProduct,
  dashboard,
  deleteProduct,
  getProduct,
  importProducts,
  listMetrics,
  listProducts,
  upsertMetrics,
  updateProduct
};
