const { query } = require("./db");

const PLATFORM_LABELS = { ozon: "Ozon 本土" };
const toNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function summarizePlatform(row) {
  const total = toNumber(row.total);
  const inStock = toNumber(row.in_stock);
  const priced = toNumber(row.priced);
  const missingInStock = toNumber(row.missing_in_stock);
  return {
    platform: row.platform,
    label: PLATFORM_LABELS[row.platform] || row.platform,
    total,
    inStock,
    priced,
    fresh: toNumber(row.fresh),
    stale: toNumber(row.stale),
    missingInStock,
    coveragePct: total ? Math.round(priced / total * 1000) / 10 : 0,
    inStockCoveragePct: inStock ? Math.round((inStock - missingInStock) / inStock * 1000) / 10 : 0,
    latestUpdatedAt: row.latest_updated_at || null,
    source: row.latest_source || null
  };
}

function overallSummary(platforms) {
  return platforms.reduce((result, item) => {
    for (const key of ["total", "inStock", "priced", "fresh", "stale", "missingInStock"]) result[key] += item[key];
    return result;
  }, { total: 0, inStock: 0, priced: 0, fresh: 0, stale: 0, missingInStock: 0 });
}

const allProductsSql = `
  SELECT 'ozon'::text AS platform, offer_id::text AS item_id, ozon_sku::text AS sku,
         title, COALESCE(fbo_stock, 0) + COALESCE(fbs_stock, 0) AS stock,
         front_price, front_price_source, front_price_updated_at
  FROM products WHERE COALESCE(hidden, false) = false`;

async function status({ freshnessHours = 36 } = {}) {
  const hours = Math.min(168, Math.max(1, Number(freshnessHours) || 36));
  const result = await query(`WITH all_products AS (${allProductsSql})
    SELECT platform, COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE stock > 0)::int AS in_stock,
      COUNT(*) FILTER (WHERE front_price IS NOT NULL)::int AS priced,
      COUNT(*) FILTER (WHERE front_price IS NOT NULL AND front_price_updated_at >= NOW() - ($1 * INTERVAL '1 hour'))::int AS fresh,
      COUNT(*) FILTER (WHERE front_price IS NOT NULL AND (front_price_updated_at IS NULL OR front_price_updated_at < NOW() - ($1 * INTERVAL '1 hour')))::int AS stale,
      COUNT(*) FILTER (WHERE stock > 0 AND front_price IS NULL)::int AS missing_in_stock,
      MAX(front_price_updated_at) AS latest_updated_at,
      (ARRAY_AGG(front_price_source ORDER BY front_price_updated_at DESC NULLS LAST) FILTER (WHERE front_price_source IS NOT NULL))[1] AS latest_source
    FROM all_products GROUP BY platform ORDER BY platform`, [hours]);

  const issueResult = await query(`WITH all_products AS (${allProductsSql})
    SELECT platform, item_id, sku, title, stock, front_price, front_price_source, front_price_updated_at,
      CASE WHEN stock > 0 AND front_price IS NULL THEN 'missing_in_stock'
           WHEN front_price IS NOT NULL AND front_price_updated_at IS NULL THEN 'missing_timestamp'
           ELSE 'stale' END AS issue
    FROM all_products
    WHERE (stock > 0 AND front_price IS NULL)
       OR (front_price IS NOT NULL AND (front_price_updated_at IS NULL OR front_price_updated_at < NOW() - ($1 * INTERVAL '1 hour')))
    ORDER BY CASE WHEN stock > 0 AND front_price IS NULL THEN 0 ELSE 1 END, stock DESC, platform, item_id
    LIMIT 200`, [hours]);

  const byPlatform = new Map(result.rows.map((row) => [row.platform, summarizePlatform(row)]));
  const platforms = ["ozon"].map((key) => byPlatform.get(key) || summarizePlatform({ platform: key }));
  return {
    observedAt: new Date().toISOString(), freshnessHours: hours, collectorMode: "external_browser",
    collectorNote: "Ozon 前台价格由外部紫鸟采集任务写入；本页仅按数据库现场判断覆盖率和时效，不控制外部任务。",
    summary: overallSummary(platforms), platforms,
    issues: issueResult.rows.map((row) => ({
      platform: row.platform, platformLabel: PLATFORM_LABELS[row.platform] || row.platform,
      itemId: row.item_id, sku: row.sku, title: row.title, stock: toNumber(row.stock),
      frontPrice: row.front_price === null ? null : toNumber(row.front_price),
      source: row.front_price_source || null, updatedAt: row.front_price_updated_at || null, issue: row.issue
    }))
  };
}

module.exports = { PLATFORM_LABELS, summarizePlatform, overallSummary, status };
