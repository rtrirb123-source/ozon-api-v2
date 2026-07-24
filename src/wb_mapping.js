const { query } = require("./db");

const SYNC_FIELDS = ["purchase_cost", "weight", "freight_rate", "competitor_compare"];

async function dropLegacyUniqueConstraints() {
  const result = await query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'wb_product_mappings'::regclass
      AND contype = 'u'
  `);

  for (const row of result.rows) {
    const isSingleSide = row.def === "UNIQUE (wb_nm_id)" || row.def === "UNIQUE (wb_cross_nm_id)";
    const isDuplicatePair = row.def === "UNIQUE (wb_nm_id, wb_cross_nm_id)" && row.conname !== "wb_product_mappings_pair_unique";
    if (isSingleSide || isDuplicatePair) {
      await query(`ALTER TABLE wb_product_mappings DROP CONSTRAINT IF EXISTS ${row.conname}`);
    }
  }
}

async function ensureSchema() {
  await query(`
    ALTER TABLE wb_products
    ADD COLUMN IF NOT EXISTS weight NUMERIC,
    ADD COLUMN IF NOT EXISTS freight_rate NUMERIC,
    ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC,
    ADD COLUMN IF NOT EXISTS fbs_stock NUMERIC,
    ADD COLUMN IF NOT EXISTS fbw_stock NUMERIC,
    ADD COLUMN IF NOT EXISTS commission_rate NUMERIC,
    ADD COLUMN IF NOT EXISTS return_rate NUMERIC
  `);

  await query(`
    ALTER TABLE wb_cross_products
    ADD COLUMN IF NOT EXISTS weight NUMERIC,
    ADD COLUMN IF NOT EXISTS freight_rate NUMERIC,
    ADD COLUMN IF NOT EXISTS purchase_cost NUMERIC,
    ADD COLUMN IF NOT EXISTS shipping_cost NUMERIC,
    ADD COLUMN IF NOT EXISTS competitor_compare TEXT
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS wb_product_mappings (
      id BIGSERIAL PRIMARY KEY,
      wb_nm_id TEXT NOT NULL REFERENCES wb_products (nm_id) ON DELETE CASCADE,
      wb_cross_nm_id TEXT NOT NULL REFERENCES wb_cross_products (nm_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (wb_nm_id, wb_cross_nm_id)
    )
  `);

  await dropLegacyUniqueConstraints();

  await query(`
    ALTER TABLE wb_product_mappings
    ADD CONSTRAINT wb_product_mappings_pair_unique UNIQUE (wb_nm_id, wb_cross_nm_id)
  `).catch(error => {
    if (!String(error.message || "").includes("already exists")) throw error;
  });

  await query(`
    CREATE INDEX IF NOT EXISTS wb_product_mappings_local_idx
    ON wb_product_mappings (wb_nm_id)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS wb_product_mappings_cross_idx
    ON wb_product_mappings (wb_cross_nm_id)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS wb_product_mappings_updated_at_idx
    ON wb_product_mappings (updated_at DESC)
  `);
}

function mappedPatch(patch) {
  const out = {};
  for (const field of SYNC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch || {}, field)) out[field] = patch[field];
  }
  return out;
}

async function autoMapByVendorCode() {
  await ensureSchema();
  const result = await query(`
    WITH local_unique AS (
      SELECT MIN(nm_id) AS wb_nm_id, vendor_code
      FROM wb_products
      WHERE NULLIF(TRIM(vendor_code), '') IS NOT NULL
      GROUP BY vendor_code
      HAVING COUNT(*) = 1
    ),
    cross_unique AS (
      SELECT MIN(nm_id) AS wb_cross_nm_id, vendor_code
      FROM wb_cross_products
      WHERE NULLIF(TRIM(vendor_code), '') IS NOT NULL
      GROUP BY vendor_code
      HAVING COUNT(*) = 1
    ),
    candidates AS (
      SELECT l.wb_nm_id, c.wb_cross_nm_id
      FROM local_unique l
      JOIN cross_unique c ON c.vendor_code = l.vendor_code
    )
    INSERT INTO wb_product_mappings (wb_nm_id, wb_cross_nm_id, updated_at)
    SELECT wb_nm_id, wb_cross_nm_id, NOW()
    FROM candidates
    ON CONFLICT (wb_nm_id, wb_cross_nm_id) DO NOTHING
    RETURNING *
  `);
  return { created: result.rowCount };
}

async function createMapping(wbNmId, wbCrossNmId) {
  await ensureSchema();
  const result = await query(
    `INSERT INTO wb_product_mappings (wb_nm_id, wb_cross_nm_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (wb_nm_id, wb_cross_nm_id) DO UPDATE SET
       updated_at = NOW()
     RETURNING *`,
    [String(wbNmId), String(wbCrossNmId)]
  );
  return result.rows[0] || null;
}

async function deleteMapping(id) {
  await ensureSchema();
  const result = await query("DELETE FROM wb_product_mappings WHERE id = $1 RETURNING id", [String(id)]);
  return Boolean(result.rows[0]);
}

async function listMappings() {
  await ensureSchema();
  const result = await query(`
    SELECT
      m.id,
      m.wb_nm_id,
      l.vendor_code AS wb_vendor_code,
      l.title AS wb_title,
      m.wb_cross_nm_id,
      c.vendor_code AS wb_cross_vendor_code,
      c.title AS wb_cross_title,
      m.created_at,
      m.updated_at
    FROM wb_product_mappings m
    LEFT JOIN wb_products l ON l.nm_id = m.wb_nm_id
    LEFT JOIN wb_cross_products c ON c.nm_id = m.wb_cross_nm_id
    ORDER BY m.updated_at DESC, m.id DESC
  `);
  return result.rows;
}

async function syncFrom(source, nmId, patch) {
  const changes = mappedPatch(patch);
  const fields = Object.keys(changes);
  if (!fields.length) return { synced: 0 };

  await ensureSchema();
  await autoMapByVendorCode();

  const sets = fields.map((field, index) => `${field} = $${index + 1}`).join(", ");
  const values = fields.map(field => changes[field]);

  if (source === "wb") {
    const result = await query(
      `UPDATE wb_cross_products
       SET ${sets}, updated_at = NOW()
       WHERE nm_id IN (
         SELECT wb_cross_nm_id FROM wb_product_mappings WHERE wb_nm_id = $${values.length + 1}
       )`,
      [...values, String(nmId)]
    );
    await query("UPDATE wb_product_mappings SET updated_at = NOW() WHERE wb_nm_id = $1", [String(nmId)]);
    return { synced: result.rowCount };
  }

  const result = await query(
    `UPDATE wb_products
     SET ${sets}, updated_at = NOW()
     WHERE nm_id IN (
       SELECT wb_nm_id FROM wb_product_mappings WHERE wb_cross_nm_id = $${values.length + 1}
     )`,
    [...values, String(nmId)]
  );
  await query("UPDATE wb_product_mappings SET updated_at = NOW() WHERE wb_cross_nm_id = $1", [String(nmId)]);
  return { synced: result.rowCount };
}

module.exports = {
  SYNC_FIELDS,
  autoMapByVendorCode,
  createMapping,
  deleteMapping,
  ensureSchema,
  listMappings,
  syncFrom
};
