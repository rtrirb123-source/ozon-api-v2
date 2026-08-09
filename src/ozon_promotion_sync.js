const https = require("https");
const { config } = require("./config");
const { getPool, query } = require("./db");

const HOST = "api-seller.ozon.ru";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request(path, { method = "GET", body } = {}) {
  return new Promise((resolve, reject) => {
    if (!config.ozonClientId || !config.ozonApiKey) return reject(new Error("Ozon Seller API credentials are not configured"));
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = https.request({
      hostname: HOST, path, method, timeout: 30000,
      headers: {
        "Client-Id": config.ozonClientId, "Api-Key": config.ozonApiKey, Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        let parsed = {};
        try { parsed = data ? JSON.parse(data) : {}; } catch (error) { return reject(new Error(`Invalid Ozon response: ${data.slice(0, 200)}`)); }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(parsed.message || `Ozon API HTTP ${res.statusCode}`);
          error.statusCode = res.statusCode;
          error.details = parsed;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Ozon API request timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS ozon_promotion_actions (
    action_id BIGINT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', action_type TEXT NOT NULL DEFAULT '',
    date_start TIMESTAMPTZ, date_end TIMESTAMPTZ, is_participating BOOLEAN NOT NULL DEFAULT false,
    potential_products_count INTEGER NOT NULL DEFAULT 0, participating_products_count INTEGER NOT NULL DEFAULT 0,
    raw JSONB NOT NULL DEFAULT '{}'::jsonb, synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query(`CREATE TABLE IF NOT EXISTS ozon_promotion_products (
    action_id BIGINT NOT NULL REFERENCES ozon_promotion_actions(action_id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL, relation TEXT NOT NULL CHECK (relation IN ('participating','candidate')),
    price NUMERIC, action_price NUMERIC, max_action_price NUMERIC, stock NUMERIC, min_stock NUMERIC,
    add_mode TEXT NOT NULL DEFAULT '', raw JSONB NOT NULL DEFAULT '{}'::jsonb, synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (action_id, product_id, relation)
  )`);
  await query("CREATE INDEX IF NOT EXISTS idx_ozon_promotion_products_product ON ozon_promotion_products(product_id)");
}

async function listProducts(actionId, relation) {
  const endpoint = relation === "participating" ? "/v1/actions/products" : "/v1/actions/candidates";
  const rows = [];
  let lastId = "";
  for (let page = 0; page < 100; page += 1) {
    const response = await request(endpoint, { method: "POST", body: { action_id: Number(actionId), limit: 100, last_id: lastId } });
    const result = response.result || {};
    const batch = Array.isArray(result.products) ? result.products : [];
    rows.push(...batch);
    const next = String(result.last_id || "");
    if (!batch.length || !next || next === lastId || rows.length >= Number(result.total || 0)) break;
    lastId = next;
    await wait(750);
  }
  return rows;
}

function relevant(action, now = Date.now()) {
  const end = Date.parse(action.date_end || "");
  const start = Date.parse(action.date_start || "");
  return (!Number.isFinite(end) || end >= now - 86400000) && (!Number.isFinite(start) || start <= now + 45 * 86400000);
}

async function sync() {
  await ensureSchema();
  const response = await request("/v1/actions");
  const actions = (response.result || response.actions || []).filter((action) => relevant(action));
  const products = [];
  for (const action of actions) {
    const participating = await listProducts(action.id, "participating");
    await wait(750);
    const candidates = await listProducts(action.id, "candidate");
    products.push(...participating.map((row) => ({ actionId: action.id, relation: "participating", row })));
    products.push(...candidates.map((row) => ({ actionId: action.id, relation: "candidate", row })));
    await wait(750);
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM ozon_promotion_products");
    await client.query("DELETE FROM ozon_promotion_actions");
    for (const action of actions) {
      await client.query(`INSERT INTO ozon_promotion_actions
        (action_id,title,action_type,date_start,date_end,is_participating,potential_products_count,participating_products_count,raw,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())`, [
        action.id, action.title || "", action.action_type || "", action.date_start || null, action.date_end || null,
        Boolean(action.is_participating), Number(action.potential_products_count || 0), Number(action.participating_products_count || 0), JSON.stringify(action)
      ]);
    }
    for (const item of products) {
      const row = item.row;
      await client.query(`INSERT INTO ozon_promotion_products
        (action_id,product_id,relation,price,action_price,max_action_price,stock,min_stock,add_mode,raw,synced_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW())`, [
        item.actionId, row.id, item.relation, row.price ?? null, row.action_price ?? null,
        row.max_action_price ?? null, row.stock ?? null, row.min_stock ?? null, row.add_mode || "", JSON.stringify(row)
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return {
    actions: actions.length,
    participating: products.filter((item) => item.relation === "participating").length,
    candidates: products.filter((item) => item.relation === "candidate").length,
    platformWrite: false
  };
}

async function snapshot() {
  await ensureSchema();
  const result = await query(`SELECT pp.*, a.title AS action_title, a.action_type, a.date_start, a.date_end,
    a.is_participating, a.synced_at AS action_synced_at
    FROM ozon_promotion_products pp JOIN ozon_promotion_actions a USING (action_id)
    ORDER BY pp.product_id, pp.relation, a.date_end`);
  const summary = await query(`SELECT COUNT(*)::int AS actions,
    COALESCE(SUM(participating_products_count),0)::int AS participating,
    COALESCE(SUM(potential_products_count),0)::int AS potential, MAX(synced_at) AS synced_at
    FROM ozon_promotion_actions`);
  return { rows: result.rows, summary: summary.rows[0] };
}

module.exports = { relevant, ensureSchema, sync, snapshot };

