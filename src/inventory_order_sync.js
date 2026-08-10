const https = require("https");
const { config } = require("./config");
const { getPool, query } = require("./db");

const DAILY_RUN_HOURS_CHINA = [8, 15];
const DAILY_RUN_MINUTE_CHINA = 10;
const LOOKBACK_DAYS = 7;
const WB_ORDER_LOOKBACK_DAYS = 2;
const SHIPPED_WB_STATUSES = new Set(["complete"]);
const SHIPPED_OZON_STATUSES = new Set(["awaiting_deliver", "delivering", "delivered"]);

const state = globalThis.__inventoryOrderSyncState || (globalThis.__inventoryOrderSyncState = {
  running: false,
  timer: null,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastOkAt: null,
  lastError: "",
  lastResult: null,
  consecutiveErrors: 0
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestJson({ hostname, path, method = "GET", headers = {}, body, timeout = 60000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = https.request({
      hostname,
      path,
      method,
      headers: {
        Accept: "application/json",
        ...headers,
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
      },
      timeout
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; }
        catch (error) {
          error.statusCode = 502;
          error.details = text.slice(0, 500);
          reject(error);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(parsed?.message || parsed?.detail || `HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.retryAfter = Number(res.headers["retry-after"] || 0);
          error.details = parsed;
          reject(error);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function requestWithBackoff(options) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await requestJson(options);
    } catch (error) {
      lastError = error;
      if (error.statusCode !== 429 || attempt === 3) throw error;
      const delay = error.retryAfter > 0 ? error.retryAfter * 1000 : 2000 * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_order_deductions (
      platform TEXT NOT NULL CHECK (platform IN ('ozon', 'wb', 'wb_cross')),
      order_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      warehouse_key TEXT NOT NULL CHECK (warehouse_key IN ('linting', 'shisheng')),
      warehouse_name TEXT NOT NULL DEFAULT '',
      offer_id TEXT,
      nm_id TEXT,
      quantity NUMERIC NOT NULL DEFAULT 0,
      state TEXT NOT NULL CHECK (state IN ('deducted', 'refunded', 'skipped')),
      platform_status TEXT NOT NULL DEFAULT '',
      skip_reason TEXT NOT NULL DEFAULT '',
      order_created_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deducted_at TIMESTAMPTZ,
      refunded_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (platform, order_id, item_key)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS inventory_order_deductions_state_idx ON inventory_order_deductions (platform, state)`);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_daily_shipments (
      platform TEXT NOT NULL CHECK (platform IN ('ozon', 'wb', 'wb_cross')),
      order_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      offer_id TEXT,
      nm_id TEXT,
      warehouse_key TEXT NOT NULL CHECK (warehouse_key IN ('linting', 'shisheng')),
      warehouse_name TEXT NOT NULL DEFAULT '',
      quantity NUMERIC NOT NULL DEFAULT 0,
      shipment_date DATE NOT NULL,
      platform_status TEXT NOT NULL DEFAULT '',
      order_created_at TIMESTAMPTZ,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (platform, order_id, item_key)
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS inventory_daily_shipments_date_idx ON inventory_daily_shipments (shipment_date, warehouse_key)`);
  await query(`
    CREATE TABLE IF NOT EXISTS inventory_order_sync_runs (
      id BIGSERIAL PRIMARY KEY,
      trigger_source TEXT NOT NULL DEFAULT 'schedule',
      data_date DATE NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      success BOOLEAN,
      partial_success BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT NOT NULL DEFAULT '',
      result JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS inventory_order_sync_runs_finished_idx ON inventory_order_sync_runs (finished_at DESC, id DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS inventory_order_sync_runs_data_date_idx ON inventory_order_sync_runs (data_date DESC, id DESC)`);
}

function chinaDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value);
}

function chinaDayStartUnix(daysAgo = 0) {
  const date = new Date(Date.now() - Number(daysAgo || 0) * 86400000);
  const day = chinaDate(date);
  return Math.floor(new Date(`${day}T00:00:00+08:00`).getTime() / 1000);
}

function wbSupplyNumber(value) {
  const match = String(value || "").match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

async function recordShipment(item) {
  const result = await query(`
    INSERT INTO inventory_daily_shipments (
      platform, order_id, item_key, offer_id, nm_id, warehouse_key, warehouse_name,
      quantity, shipment_date, platform_status, order_created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
    ON CONFLICT (platform, order_id, item_key) DO UPDATE SET
      offer_id=EXCLUDED.offer_id, nm_id=EXCLUDED.nm_id,
      warehouse_key=EXCLUDED.warehouse_key, warehouse_name=EXCLUDED.warehouse_name,
      quantity=EXCLUDED.quantity,
      platform_status=EXCLUDED.platform_status, updated_at=NOW()
    RETURNING (xmax = 0) AS inserted
  `, [item.platform, item.orderId, item.itemKey, item.offerId || null, item.nmId || null,
      item.warehouseKey, item.warehouseName, item.quantity, chinaDate(), item.status || "", item.createdAt || null]);
  return result.rows[0]?.inserted === true;
}

function warehouseKeyFromName(name) {
  const value = String(name || "").toLowerCase();
  if (value.includes("林挺")) return "linting";
  if (value.includes("世晟")) return "shisheng";
  return "";
}

function wbRows(value, key) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.[key]) ? value[key] : [];
}

async function wbGet(token, path) {
  return requestWithBackoff({
    hostname: "marketplace-api.wildberries.ru",
    path,
    headers: { Authorization: token }
  });
}

async function wbPost(token, path, body) {
  return requestWithBackoff({
    hostname: "marketplace-api.wildberries.ru",
    path,
    method: "POST",
    headers: { Authorization: token },
    body
  });
}

async function resolveOfferForWb(market, nmId, warehouseKey) {
  const result = await query(`
    SELECT l.offer_id, m.manual_stock
    FROM inventory_product_links l
    LEFT JOIN inventory_manual_warehouse_fbs_stock m
      ON m.offer_id = l.offer_id AND m.warehouse_key = $3
    WHERE l.market = $1 AND l.nm_id = $2
    ORDER BY (m.manual_stock IS NOT NULL) DESC,
             COALESCE(m.manual_stock, 0) DESC,
             (l.offer_id LIKE 'WBLOCAL-%' OR l.offer_id LIKE 'WBCROSS-%') ASC,
             l.id ASC
    LIMIT 1
  `, [market, String(nmId), warehouseKey]);
  return result.rows[0]?.offer_id || "";
}

async function recordSkip(client, item, reason) {
  await client.query(`
    INSERT INTO inventory_order_deductions (
      platform, order_id, item_key, warehouse_key, warehouse_name, offer_id, nm_id,
      quantity, state, platform_status, skip_reason, order_created_at, last_seen_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'skipped',$9,$10,$11,NOW(),NOW())
    ON CONFLICT (platform, order_id, item_key) DO UPDATE SET
      warehouse_key = EXCLUDED.warehouse_key,
      warehouse_name = EXCLUDED.warehouse_name,
      offer_id = COALESCE(inventory_order_deductions.offer_id, EXCLUDED.offer_id),
      nm_id = COALESCE(inventory_order_deductions.nm_id, EXCLUDED.nm_id),
      quantity = EXCLUDED.quantity,
      platform_status = EXCLUDED.platform_status,
      skip_reason = EXCLUDED.skip_reason,
      last_seen_at = NOW(),
      updated_at = NOW()
  `, [item.platform, item.orderId, item.itemKey, item.warehouseKey, item.warehouseName, item.offerId || null,
      item.nmId || null, item.quantity, item.status || "", reason, item.createdAt || null]);
}

async function applyDeduction(item) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(`
      SELECT state FROM inventory_order_deductions
      WHERE platform = $1 AND order_id = $2 AND item_key = $3
      FOR UPDATE
    `, [item.platform, item.orderId, item.itemKey]);
    if (existing.rows[0]?.state === "deducted") {
      await client.query(`
        UPDATE inventory_order_deductions
        SET platform_status = $4, last_seen_at = NOW(), updated_at = NOW()
        WHERE platform = $1 AND order_id = $2 AND item_key = $3
      `, [item.platform, item.orderId, item.itemKey, item.status || ""]);
      await client.query("COMMIT");
      return "already";
    }
    if (existing.rows[0]?.state === "refunded") {
      await client.query("COMMIT");
      return "refunded";
    }
    if (!item.offerId) {
      await recordSkip(client, item, "商品未关联到库存主表");
      await client.query("COMMIT");
      return "skipped_unlinked";
    }
    const stock = await client.query(`
      SELECT manual_stock
      FROM inventory_manual_warehouse_fbs_stock
      WHERE offer_id = $1 AND warehouse_key = $2
      FOR UPDATE
    `, [item.offerId, item.warehouseKey]);
    if (!stock.rows.length) {
      await recordSkip(client, item, "该商品未填写仓库总数");
      await client.query("COMMIT");
      return "skipped_no_total";
    }
    const previous = Number(stock.rows[0].manual_stock || 0);
    const next = Math.max(0, previous - Number(item.quantity || 0));
    await client.query(`
      UPDATE inventory_manual_warehouse_fbs_stock
      SET manual_stock = $3, updated_at = NOW()
      WHERE offer_id = $1 AND warehouse_key = $2
    `, [item.offerId, item.warehouseKey, next]);
    await client.query(`
      INSERT INTO inventory_order_deductions (
        platform, order_id, item_key, warehouse_key, warehouse_name, offer_id, nm_id,
        quantity, state, platform_status, skip_reason, order_created_at, last_seen_at, deducted_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deducted',$9,'',$10,NOW(),NOW(),NOW())
      ON CONFLICT (platform, order_id, item_key) DO UPDATE SET
        warehouse_key = EXCLUDED.warehouse_key,
        warehouse_name = EXCLUDED.warehouse_name,
        offer_id = EXCLUDED.offer_id,
        nm_id = EXCLUDED.nm_id,
        quantity = EXCLUDED.quantity,
        state = 'deducted',
        platform_status = EXCLUDED.platform_status,
        skip_reason = '',
        last_seen_at = NOW(),
        deducted_at = NOW(),
        refunded_at = NULL,
        updated_at = NOW()
    `, [item.platform, item.orderId, item.itemKey, item.warehouseKey, item.warehouseName, item.offerId,
        item.nmId || null, item.quantity, item.status || "", item.createdAt || null]);
    await client.query("COMMIT");
    return "deducted";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function refund(platform, orderId, itemKey, status) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT * FROM inventory_order_deductions
      WHERE platform = $1 AND order_id = $2 AND item_key = $3
      FOR UPDATE
    `, [platform, String(orderId), String(itemKey)]);
    const row = result.rows[0];
    if (!row || row.state !== "deducted") {
      if (row) {
        await client.query(`UPDATE inventory_order_deductions SET platform_status=$4,last_seen_at=NOW(),updated_at=NOW() WHERE platform=$1 AND order_id=$2 AND item_key=$3`, [platform, String(orderId), String(itemKey), status || ""]);
      }
      await client.query("COMMIT");
      return "ignored";
    }
    await client.query(`
      UPDATE inventory_manual_warehouse_fbs_stock
      SET manual_stock = manual_stock + $3, updated_at = NOW()
      WHERE offer_id = $1 AND warehouse_key = $2
    `, [row.offer_id, row.warehouse_key, Number(row.quantity || 0)]);
    await client.query(`
      UPDATE inventory_order_deductions
      SET state='refunded', platform_status=$4, refunded_at=NOW(), last_seen_at=NOW(), updated_at=NOW()
      WHERE platform=$1 AND order_id=$2 AND item_key=$3
    `, [platform, String(orderId), String(itemKey), status || ""]);
    await client.query("COMMIT");
    return "refunded";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function syncWbPlatform(platform, token) {
  if (!token) return { platform, skipped: "token missing" };
  const warehousePayload = await wbGet(token, "/api/v3/warehouses");
  const warehouseById = new Map();
  for (const warehouse of wbRows(warehousePayload, "warehouses")) {
    const key = warehouseKeyFromName(warehouse.name);
    if (key) warehouseById.set(String(warehouse.id), { key, name: warehouse.name });
  }
  const orderPayload = await wbGet(token, `/api/v3/orders?limit=1000&next=0&dateFrom=${chinaDayStartUnix(WB_ORDER_LOOKBACK_DAYS)}`);
  const orders = wbRows(orderPayload, "orders");
  const ids = orders.map((order) => Number(order.id)).filter(Number.isFinite);
  const statusById = new Map();
  for (let index = 0; index < ids.length; index += 1000) {
    const statusPayload = await wbPost(token, "/api/v3/orders/status", { orders: ids.slice(index, index + 1000) });
    for (const row of wbRows(statusPayload, "orders")) statusById.set(String(row.id), row);
  }

  const completeOrders = [];
  const latestSupplyByWarehouse = new Map();
  const counts = { seen: orders.length, matchedWarehouse: 0, shipping: 0, added: 0, already: 0, skipped: 0 };
  for (const order of orders) {
    const warehouse = warehouseById.get(String(order.warehouseId));
    if (!warehouse) continue;
    counts.matchedWarehouse += 1;
    const statusRow = statusById.get(String(order.id)) || {};
    const supplierStatus = String(statusRow.supplierStatus || order.supplierStatus || "").toLowerCase();
    const wbStatus = String(statusRow.wbStatus || order.wbStatus || "").toLowerCase();
    const supplyId = String(order.supplyId || "");
    if (!SHIPPED_WB_STATUSES.has(supplierStatus) || !supplyId) continue;
    const entry = { order, warehouse, supplierStatus, wbStatus, supplyId };
    completeOrders.push(entry);
    // A supply can contain orders created on an earlier day. Restricting this to
    // createdToday made the dashboard report zero even when today's supply shipped.
    const current = latestSupplyByWarehouse.get(warehouse.key);
    if (!current || wbSupplyNumber(supplyId) > wbSupplyNumber(current)) latestSupplyByWarehouse.set(warehouse.key, supplyId);
  }

  for (const entry of completeOrders) {
    const { order, warehouse, supplierStatus, wbStatus, supplyId } = entry;
    if (latestSupplyByWarehouse.get(warehouse.key) !== supplyId) continue;
    counts.shipping += 1;
    const offerId = await resolveOfferForWb(platform, order.nmId, warehouse.key);
    if (!offerId) {
      counts.skipped += 1;
      continue;
    }
    const inserted = await recordShipment({
      platform,
      orderId: String(order.id),
      itemKey: String(order.nmId || order.chrtId || "item"),
      warehouseKey: warehouse.key,
      warehouseName: warehouse.name,
      offerId,
      nmId: String(order.nmId || ""),
      quantity: 1,
      status: `${supplierStatus}/${wbStatus}/${supplyId}`,
      createdAt: order.createdAt || null
    });
    if (inserted) counts.added += 1;
    else counts.already += 1;
  }
  return {
    platform,
    ...counts,
    latestSupplies: Array.from(latestSupplyByWarehouse.entries()).map(([warehouse_key, supply_id]) => ({ warehouse_key, supply_id })),
    warehouses: Array.from(warehouseById.entries()).map(([id, value]) => ({ id, ...value }))
  };
}

async function fetchOzonPostings() {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  const all = [];
  let offset = 0;
  for (let page = 0; page < 10; page += 1) {
    const payload = await requestWithBackoff({
      hostname: "api-seller.ozon.ru",
      path: "/v3/posting/fbs/list",
      method: "POST",
      headers: { "Client-Id": config.ozonClientId, "Api-Key": config.ozonApiKey },
      body: { dir: "ASC", filter: { since, to }, limit: 1000, offset, with: { analytics_data: true } }
    });
    const rows = payload?.result?.postings || [];
    all.push(...rows);
    if (rows.length < 1000) break;
    offset += rows.length;
    await sleep(700);
  }
  return all;
}

async function syncOzon() {
  if (!config.ozonClientId || !config.ozonApiKey) return { platform: "ozon", skipped: "credentials missing" };
  const postings = await fetchOzonPostings();
  const counts = { seen: postings.length, matchedWarehouse: 0, shipping: 0, added: 0, already: 0, skipped: 0 };
  for (const posting of postings) {
    const warehouseName = posting.analytics_data?.warehouse || posting.warehouse_name || "";
    const warehouseKey = warehouseKeyFromName(warehouseName);
    if (!warehouseKey) continue;
    counts.matchedWarehouse += 1;
    const status = String(posting.status || "");
    if (!SHIPPED_OZON_STATUSES.has(status)) continue;
    if (chinaDate(new Date(posting.delivering_date || 0)) !== chinaDate()) continue;
    counts.shipping += 1;
    for (const product of posting.products || []) {
      const itemKey = String(product.offer_id || product.sku || "item");
      const inserted = await recordShipment({
        platform: "ozon",
        orderId: String(posting.posting_number),
        itemKey,
        warehouseKey,
        warehouseName,
        offerId: String(product.offer_id || ""),
        nmId: null,
        quantity: Math.max(1, Number(product.quantity || 1)),
        status: posting.status || "",
        createdAt: posting.in_process_at || null
      });
      if (inserted) counts.added += 1;
      else counts.already += 1;
    }
  }
  return { platform: "ozon", ...counts };
}

async function runOnce(triggerSource = "manual") {
  if (state.running) return { accepted: false, running: true };
  state.running = true;
  state.lastStartedAt = new Date().toISOString();
  state.lastError = "";
  const dataDate = chinaDate();
  let runId = null;
  let results = [];
  let success = false;
  let partialSuccess = false;
  let failureMessage = "";
  try {
    await ensureSchema();
    const run = await query(`
      INSERT INTO inventory_order_sync_runs (trigger_source, data_date, started_at)
      VALUES ($1, $2::date, NOW())
      RETURNING id
    `, [String(triggerSource || "manual"), dataDate]);
    runId = run.rows[0].id;
    for (const [platform, task] of [
      ["wb", () => syncWbPlatform("wb", config.wbApiKey)],
      ["wb_cross", () => syncWbPlatform("wb_cross", process.env.WB_CROSS_API_KEY || "")],
      ["ozon", () => syncOzon()]
    ]) {
      try { results.push(await task()); }
      catch (error) {
        results.push({ platform, error: error.message, statusCode: error.statusCode || null });
      }
    }
    state.lastResult = results;
    const issues = results.filter((item) => item.error || item.skipped);
    const completed = results.length - issues.length;
    success = issues.length === 0;
    partialSuccess = completed > 0 && issues.length > 0;
    failureMessage = issues.map((item) => (
      `${item.platform || "unknown"}: ${item.error || item.skipped}`
    )).join("; ");
    state.lastError = failureMessage;
    if (success) {
      state.lastOkAt = new Date().toISOString();
      state.consecutiveErrors = 0;
    } else {
      state.consecutiveErrors += 1;
    }
    if (!success && !partialSuccess) {
      throw new Error(failureMessage || "all platforms failed");
    }
    return { accepted: true, success, partialSuccess, dataDate, error: failureMessage, results };
  } catch (error) {
    failureMessage = failureMessage || error.message;
    state.lastError = failureMessage;
    if (!state.consecutiveErrors) state.consecutiveErrors = 1;
    console.error("[inventory-order-sync]", failureMessage);
    throw error;
  } finally {
    state.running = false;
    state.lastFinishedAt = new Date().toISOString();
    if (runId) {
      await query(`
        UPDATE inventory_order_sync_runs
        SET finished_at = NOW(),
            success = $2,
            partial_success = $3,
            error = $4,
            result = $5::jsonb
        WHERE id = $1
      `, [runId, success, partialSuccess, failureMessage, JSON.stringify(results)]).catch((error) => {
        console.error("[inventory-order-sync:persist]", error.message);
      });
    }
  }
}

function nextScheduledRun() {
  const now = new Date();
  const chinaNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const hour of DAILY_RUN_HOURS_CHINA) {
      const target = new Date(Date.UTC(
        chinaNow.getUTCFullYear(), chinaNow.getUTCMonth(), chinaNow.getUTCDate() + dayOffset,
        hour - 8, DAILY_RUN_MINUTE_CHINA, 0, 0
      ));
      if (target.getTime() > now.getTime()) return target;
    }
  }
  throw new Error("cannot calculate next inventory order sync time");
}

function scheduleNext() {
  clearTimeout(state.timer);
  const next = nextScheduledRun();
  state.nextRunAt = next.toISOString();
  const delay = Math.max(1000, next.getTime() - Date.now());
  state.timer = setTimeout(async () => {
    try { await runOnce("schedule"); }
    catch (error) { /* persisted status already records the error */ }
    scheduleNext();
  }, delay);
  state.timer.unref?.();
}

async function runStartupCatchup() {
  await ensureSchema();
  const chinaNow = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const minutesNow = chinaNow.getUTCHours() * 60 + chinaNow.getUTCMinutes();
  const firstSlotMinutes = DAILY_RUN_HOURS_CHINA[0] * 60 + DAILY_RUN_MINUTE_CHINA;
  if (minutesNow < firstSlotMinutes) return;
  const latest = await query(`
    SELECT id
    FROM inventory_order_sync_runs
    WHERE data_date = $1::date
      AND (success IS TRUE OR partial_success IS TRUE)
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT 1
  `, [chinaDate()]);
  if (!latest.rows.length && !state.running) await runOnce("startup-catchup");
}

function start() {
  if (state.timer) return;
  scheduleNext();
  const catchupTimer = setTimeout(() => {
    runStartupCatchup().catch((error) => console.error("[inventory-order-sync:catchup]", error.message));
  }, 5000);
  catchupTimer.unref?.();
}

async function status() {
  await ensureSchema();
  const latestRuns = await query(`
    SELECT id, trigger_source, to_char(data_date, 'YYYY-MM-DD') AS data_date,
           started_at, finished_at, success, partial_success, error, result
    FROM inventory_order_sync_runs
    ORDER BY id DESC
    LIMIT 10
  `);
  const latestSuccess = await query(`
    SELECT finished_at, to_char(data_date, 'YYYY-MM-DD') AS data_date
    FROM inventory_order_sync_runs
    WHERE success IS TRUE
    ORDER BY id DESC
    LIMIT 1
  `);
  const latestRun = latestRuns.rows[0] || null;
  const persistedSuccess = latestSuccess.rows[0] || null;
  const totals = await query(`
    SELECT platform, warehouse_key, shipment_date, COUNT(*)::int AS orders,
           COALESCE(SUM(quantity),0)::numeric AS quantity
    FROM inventory_daily_shipments
    WHERE shipment_date >= CURRENT_DATE - 30
    GROUP BY platform, warehouse_key, shipment_date
    ORDER BY shipment_date DESC, platform, warehouse_key
  `);
  const recent = await query(`
    SELECT platform, order_id, item_key, warehouse_key, warehouse_name, offer_id, nm_id,
           quantity, shipment_date, platform_status, order_created_at, updated_at
    FROM inventory_daily_shipments
    ORDER BY updated_at DESC
    LIMIT 50
  `);
  return {
    running: state.running,
    schedule: "daily 08:10 and 15:10 Asia/Shanghai",
    nextRunAt: state.nextRunAt || nextScheduledRun().toISOString(),
    lastStartedAt: state.lastStartedAt || latestRun?.started_at || null,
    lastFinishedAt: state.lastFinishedAt || latestRun?.finished_at || null,
    lastOkAt: state.lastOkAt || persistedSuccess?.finished_at || null,
    lastError: state.running ? state.lastError : (latestRun?.success ? "" : (latestRun?.error || state.lastError)),
    lastResult: state.lastResult || latestRun?.result || null,
    dataDate: latestRun?.data_date || null,
    lastSuccessDataDate: persistedSuccess?.data_date || null,
    latestRun,
    recentRuns: latestRuns.rows,
    totals: totals.rows,
    recent: recent.rows
  };
}

async function dailyShipments(date = chinaDate()) {
  await ensureSchema();
  const result = await query(`
    SELECT COALESCE(link.offer_id, shipment.offer_id) AS offer_id,
           shipment.warehouse_key,
           shipment.platform,
           COUNT(DISTINCT shipment.order_id)::int AS orders,
           COALESCE(SUM(shipment.quantity), 0)::int AS quantity
    FROM inventory_daily_shipments shipment
    LEFT JOIN inventory_product_links link
      ON link.market = shipment.platform
     AND link.nm_id::text = shipment.nm_id::text
    WHERE shipment.shipment_date = $1::date
    GROUP BY COALESCE(link.offer_id, shipment.offer_id), shipment.warehouse_key, shipment.platform
    ORDER BY COALESCE(link.offer_id, shipment.offer_id), shipment.warehouse_key, shipment.platform
  `, [date]);
  return { date, rows: result.rows };
}

async function dailyShipmentHistory(offerId, warehouseKey = "linting", days = 30) {
  await ensureSchema();
  const safeDays = Math.max(1, Math.min(90, Number(days) || 30));
  const safeWarehouse = warehouseKey === "shisheng" ? "shisheng" : "linting";
  const result = await query(`
    WITH days AS (
      SELECT generate_series(
        ((NOW() AT TIME ZONE 'Asia/Shanghai')::date - ($3::int - 1)),
        (NOW() AT TIME ZONE 'Asia/Shanghai')::date,
        '1 day'::interval
      )::date AS day
    ),
    system_daily AS (
      SELECT
        shipment.shipment_date::date AS date,
        COALESCE(SUM(shipment.quantity), 0)::numeric AS quantity
      FROM inventory_daily_shipments shipment
      LEFT JOIN inventory_product_links link
        ON link.market = shipment.platform
       AND link.nm_id::text = shipment.nm_id::text
      WHERE COALESCE(link.offer_id, shipment.offer_id) = $1
        AND shipment.warehouse_key = $2
        AND shipment.shipment_date >= ((NOW() AT TIME ZONE 'Asia/Shanghai')::date - ($3::int - 1))
      GROUP BY shipment.shipment_date::date
    ),
    manual_daily AS (
      SELECT shipment_date::date AS date, COALESCE(manual_quantity, 0)::numeric AS quantity
      FROM inventory_manual_daily_shipments
      WHERE offer_id = $1
        AND warehouse_key = $2
        AND shipment_date >= ((NOW() AT TIME ZONE 'Asia/Shanghai')::date - ($3::int - 1))
    )
    SELECT
      to_char(d.day, 'YYYY-MM-DD') AS date,
      COALESCE(s.quantity, 0) AS system_quantity,
      COALESCE(m.quantity, 0) AS manual_quantity,
      COALESCE(s.quantity, 0) + COALESCE(m.quantity, 0) AS stock,
      s.quantity IS NOT NULL AS system_recorded,
      m.quantity IS NOT NULL AS manual_recorded,
      CASE
        WHEN s.quantity IS NOT NULL OR m.quantity IS NOT NULL THEN 'shipment_record'
        ELSE 'no_shipment'
      END AS source_note,
      'shipment' AS kind
    FROM days d
    LEFT JOIN system_daily s ON s.date = d.day
    LEFT JOIN manual_daily m ON m.date = d.day
    ORDER BY d.day DESC
  `, [String(offerId), safeWarehouse, safeDays]);
  return result.rows;
}

module.exports = { start, runOnce, status, dailyShipments, dailyShipmentHistory };
