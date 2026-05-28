const { query } = require("./db");

const PUBLIC_FIELDS = [
  "offer_id",
  "product_id",
  "title",
  "image_url",
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
  image: "image_url",
  imageUrl: "image_url",
  mainImage: "image_url",
  productImage: "image_url",
  product_image: "image_url",
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
    title,
    image_url,
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
      const source = item.raw ? { ...item.raw, ...item } : item;
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

module.exports = {
  createProduct,
  dashboard,
  deleteProduct,
  getProduct,
  importProducts,
  listProducts,
  updateProduct
};
