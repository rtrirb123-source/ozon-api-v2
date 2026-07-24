const { query } = require("./db");

function tableForKind(kind) {
  return kind === "manual"
    ? {
        history: "inventory_manual_warehouse_actual_history",
        source: "inventory_manual_warehouse_actual_stock",
        title: "manual"
      }
    : {
        history: "inventory_manual_warehouse_fbs_history",
        source: "inventory_manual_warehouse_fbs_stock",
        title: "system"
      };
}

async function ensureHistoryTable(tableName, indexName) {
  await query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id BIGSERIAL PRIMARY KEY,
      offer_id TEXT NOT NULL,
      warehouse_key TEXT NOT NULL,
      stock NUMERIC NOT NULL DEFAULT 0,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source_note TEXT NOT NULL DEFAULT ''
    )
  `);
  await query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS source_note TEXT NOT NULL DEFAULT ''`);
  await query(`CREATE INDEX IF NOT EXISTS ${indexName}
    ON ${tableName} (offer_id, warehouse_key, changed_at DESC)`);
}

async function ensureSchema() {
  await ensureHistoryTable("inventory_manual_warehouse_fbs_history", "inventory_warehouse_history_lookup_idx");
  await ensureHistoryTable("inventory_manual_warehouse_actual_history", "inventory_actual_warehouse_history_lookup_idx");

  await query(`
    CREATE OR REPLACE FUNCTION log_inventory_manual_warehouse_stock() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.manual_stock IS DISTINCT FROM OLD.manual_stock THEN
        INSERT INTO inventory_manual_warehouse_fbs_history (offer_id, warehouse_key, stock, changed_at, source_note)
        VALUES (NEW.offer_id, NEW.warehouse_key, COALESCE(NEW.manual_stock, 0), NOW(), 'system_change');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await query(`DROP TRIGGER IF EXISTS inventory_manual_warehouse_stock_history_trg ON inventory_manual_warehouse_fbs_stock`);
  await query(`CREATE TRIGGER inventory_manual_warehouse_stock_history_trg
    AFTER INSERT OR UPDATE OF manual_stock ON inventory_manual_warehouse_fbs_stock
    FOR EACH ROW EXECUTE FUNCTION log_inventory_manual_warehouse_stock()`);

  await query(`
    CREATE OR REPLACE FUNCTION log_inventory_manual_warehouse_actual_stock() RETURNS trigger AS $$
    BEGIN
      IF TG_OP = 'INSERT' OR NEW.manual_stock IS DISTINCT FROM OLD.manual_stock THEN
        INSERT INTO inventory_manual_warehouse_actual_history (offer_id, warehouse_key, stock, changed_at, source_note)
        VALUES (NEW.offer_id, NEW.warehouse_key, COALESCE(NEW.manual_stock, 0), NOW(), 'manual_change');
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await query(`DROP TRIGGER IF EXISTS inventory_manual_warehouse_actual_history_trg ON inventory_manual_warehouse_actual_stock`);
  await query(`CREATE TRIGGER inventory_manual_warehouse_actual_history_trg
    AFTER INSERT OR UPDATE OF manual_stock ON inventory_manual_warehouse_actual_stock
    FOR EACH ROW EXECUTE FUNCTION log_inventory_manual_warehouse_actual_stock()`);

}

async function ensureTodaySnapshot(offerId, warehouseKey, kind) {
  const cfg = tableForKind(kind);
  await query(`
    WITH current_stock AS (
      SELECT manual_stock AS stock
      FROM ${cfg.source}
      WHERE offer_id = $1 AND warehouse_key = $2
    )
    INSERT INTO ${cfg.history} (offer_id, warehouse_key, stock, changed_at, source_note)
    SELECT
      $1,
      $2,
      COALESCE((SELECT stock FROM current_stock), 0),
      NOW(),
      'daily_snapshot'
    WHERE EXISTS (SELECT 1 FROM current_stock)
      AND NOT EXISTS (
        SELECT 1
        FROM ${cfg.history} h
        WHERE h.offer_id = $1
          AND h.warehouse_key = $2
          AND (h.changed_at AT TIME ZONE 'Asia/Shanghai')::date = (NOW() AT TIME ZONE 'Asia/Shanghai')::date
      )
  `, [String(offerId), warehouseKey]);
}

async function listDailyLatest(offerId, warehouseKey, days = 30, kind = "system") {
  await ensureSchema();
  const safeDays = Math.max(1, Math.min(90, Number(days) || 30));
  const safeWarehouse = warehouseKey === "shisheng" ? "shisheng" : "linting";
  const safeKind = kind === "manual" ? "manual" : "system";
  const cfg = tableForKind(safeKind);
  await ensureTodaySnapshot(offerId, safeWarehouse, safeKind);
  const result = await query(`
    WITH days AS (
      SELECT generate_series(
        ((NOW() AT TIME ZONE 'Asia/Shanghai')::date - ($3::int - 1)),
        (NOW() AT TIME ZONE 'Asia/Shanghai')::date,
        '1 day'::interval
      )::date AS day
    ),
    actual AS (
      SELECT DISTINCT ON ((changed_at AT TIME ZONE 'Asia/Shanghai')::date)
        (changed_at AT TIME ZONE 'Asia/Shanghai')::date AS date,
        stock,
        changed_at,
        source_note
      FROM ${cfg.history}
      WHERE offer_id=$1 AND warehouse_key=$2
        AND (changed_at AT TIME ZONE 'Asia/Shanghai')::date >= ((NOW() AT TIME ZONE 'Asia/Shanghai')::date - ($3::int - 1))
      ORDER BY (changed_at AT TIME ZONE 'Asia/Shanghai')::date DESC, changed_at DESC
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      COALESCE(a.stock, carried.stock) AS stock,
      COALESCE(a.changed_at, carried.changed_at) AS changed_at,
      CASE
        WHEN a.stock IS NOT NULL THEN a.source_note
        WHEN carried.stock IS NOT NULL THEN 'carried_forward'
        ELSE NULL
      END AS source_note,
      $4::text AS kind
    FROM days d
    LEFT JOIN actual a ON a.date = d.day
    LEFT JOIN LATERAL (
      SELECT h.stock, h.changed_at
      FROM ${cfg.history} h
      WHERE h.offer_id = $1
        AND h.warehouse_key = $2
        AND (h.changed_at AT TIME ZONE 'Asia/Shanghai')::date < d.day
      ORDER BY h.changed_at DESC
      LIMIT 1
    ) carried ON TRUE
    ORDER BY d.day DESC
  `, [String(offerId), safeWarehouse, safeDays, safeKind]);
  return result.rows;
}

module.exports = { ensureSchema, listDailyLatest };
