const http = require("http");
const dashboardAuth = require("./dashboard_auth");
const fs = require("fs");
const pathModule = require("path");
const { URL } = require("url");
const { config } = require("./config");
const { query } = require("./db");
const { migrate } = require("./schema");
const products = require("./products");
const ozon = require("./ozon");
const wb = require("./wb");
const { calculateFboCommission } = require("./commission");
const packageJson = require("../package.json");
const { getRubRate } = require("./exchange");
const wbCross = require("./wb_cross");
const wbMapping = require("./wb_mapping");
const seerfar = require("./seerfar");
const inventory = require("./inventory");
const inventoryOrderSync = require("./inventory_order_sync");
const inventoryHistory = require("./inventory_history");
const automation = require("./automation");
const ozonSyncLock = require("./ozon_sync_lock");
const dailyProfit = require("./daily_profit");
const pricingStrategy = require("./pricing_strategy");
const actualCosts = require("./actual_costs");
const competitorStrategy = require("./competitor_strategy");
const advertisingStrategy = require("./advertising_strategy");
const promotionStrategy = require("./promotion_strategy");
const ozonPromotionSync = require("./ozon_promotion_sync");
const contentStrategy = require("./content_strategy");
const operationQueue = require("./operation_queue");
const executionGuard = require("./execution_guard");
const ozonBackendArchitecture = require("./ozon_backend_architecture");
const storefrontPriceStatus = require("./storefront_price_status");

const startedAt = new Date().toISOString();

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowAny = config.allowedOrigins.includes("*");
  const allowedOrigin = allowAny ? "*" : config.allowedOrigins.find((item) => item === origin);
  return {
    "Access-Control-Allow-Origin": allowedOrigin || "null",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

function sendJson(req, res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req),
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}


const RUSSIA_OPERATIONS_SETTINGS_PATH = "/var/www/ozon-dashboard/russia-operations-settings.json";
const WB_BUSINESS_SETTINGS_PATH = "/var/www/ozon-dashboard/wb-business-settings.json";
const DEFAULT_WB_BUSINESS_SETTINGS = {
  taxRate: 0.12,
  collectionRate: 0.03,
  logisticsFactorUsdKg: 3,
};
const DEFAULT_RUSSIA_OPERATIONS_SETTINGS = {
  taxRate: 0.12,
  withdrawalRate: 0.03,
  logisticsFactorUsdKg: 3,
  bonusCoefficients: {},
};

function numberSetting(value, fallback, { min = 0, max = 100 } = {}) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback;
}

function normalizeBonusCoefficients(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([sku, coefficient]) => [String(sku).trim(), Number(coefficient)])
      .filter(([sku, coefficient]) => sku && Number.isFinite(coefficient) && coefficient >= 0 && coefficient <= 1)
  );
}

function readRussiaOperationsSettings() {
  try {
    if (!fs.existsSync(RUSSIA_OPERATIONS_SETTINGS_PATH)) return { ...DEFAULT_RUSSIA_OPERATIONS_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(RUSSIA_OPERATIONS_SETTINGS_PATH, "utf8"));
    return {
      taxRate: numberSetting(parsed.taxRate, DEFAULT_RUSSIA_OPERATIONS_SETTINGS.taxRate, { min: 0, max: 1 }),
      withdrawalRate: numberSetting(parsed.withdrawalRate, DEFAULT_RUSSIA_OPERATIONS_SETTINGS.withdrawalRate, { min: 0, max: 1 }),
      logisticsFactorUsdKg: numberSetting(parsed.logisticsFactorUsdKg, DEFAULT_RUSSIA_OPERATIONS_SETTINGS.logisticsFactorUsdKg, { min: 0, max: 100 }),
      bonusCoefficients: normalizeBonusCoefficients(parsed.bonusCoefficients),
      updatedAt: parsed.updatedAt || "",
      updatedBy: parsed.updatedBy || "",
    };
  } catch {
    return { ...DEFAULT_RUSSIA_OPERATIONS_SETTINGS };
  }
}

function publicRussiaOperationsSettings() {
  const { bonusCoefficients, ...settings } = readRussiaOperationsSettings();
  return settings;
}

function saveRussiaBonusCoefficient(sku, value, user) {
  const cleanSku = String(sku || "").trim();
  const coefficient = Number(value);
  if (!cleanSku) throw new Error("SKU不能为空");
  if (!Number.isFinite(coefficient) || coefficient < 0 || coefficient > 1) {
    throw new Error("提奖系数必须在0%到100%之间");
  }
  const settings = readRussiaOperationsSettings();
  settings.bonusCoefficients = normalizeBonusCoefficients(settings.bonusCoefficients);
  if (coefficient === 0) delete settings.bonusCoefficients[cleanSku];
  else settings.bonusCoefficients[cleanSku] = coefficient;
  settings.updatedAt = new Date().toISOString();
  settings.updatedBy = user?.username || "admin";
  fs.writeFileSync(RUSSIA_OPERATIONS_SETTINGS_PATH, JSON.stringify(settings, null, 2));
  return { sku: cleanSku, coefficient };
}

function saveRussiaOperationsSettings(patch, user) {
  const current = readRussiaOperationsSettings();
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, "taxRate")) {
    next.taxRate = numberSetting(patch.taxRate, current.taxRate, { min: 0, max: 1 });
  }
  if (Object.prototype.hasOwnProperty.call(patch, "withdrawalRate")) {
    next.withdrawalRate = numberSetting(patch.withdrawalRate, current.withdrawalRate, { min: 0, max: 1 });
  }
  if (Object.prototype.hasOwnProperty.call(patch, "logisticsFactorUsdKg")) {
    next.logisticsFactorUsdKg = numberSetting(patch.logisticsFactorUsdKg, current.logisticsFactorUsdKg, { min: 0, max: 100 });
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = user?.username || user?.operator || "unknown";
  fs.writeFileSync(RUSSIA_OPERATIONS_SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

function readWbBusinessSettings() {
  try {
    if (!fs.existsSync(WB_BUSINESS_SETTINGS_PATH)) return { ...DEFAULT_WB_BUSINESS_SETTINGS };
    const parsed = JSON.parse(fs.readFileSync(WB_BUSINESS_SETTINGS_PATH, "utf8"));
    return {
      taxRate: numberSetting(parsed.taxRate, DEFAULT_WB_BUSINESS_SETTINGS.taxRate, { min: 0, max: 1 }),
      collectionRate: numberSetting(parsed.collectionRate, DEFAULT_WB_BUSINESS_SETTINGS.collectionRate, { min: 0, max: 1 }),
      logisticsFactorUsdKg: numberSetting(parsed.logisticsFactorUsdKg, DEFAULT_WB_BUSINESS_SETTINGS.logisticsFactorUsdKg, { min: 0, max: 100 }),
      updatedAt: parsed.updatedAt || "",
      updatedBy: parsed.updatedBy || "",
    };
  } catch {
    return { ...DEFAULT_WB_BUSINESS_SETTINGS };
  }
}

function saveWbBusinessSettings(patch, user) {
  const current = readWbBusinessSettings();
  const next = { ...current };
  if (Object.prototype.hasOwnProperty.call(patch, "taxRate")) {
    next.taxRate = numberSetting(patch.taxRate, current.taxRate, { min: 0, max: 1 });
  }
  if (Object.prototype.hasOwnProperty.call(patch, "collectionRate")) {
    next.collectionRate = numberSetting(patch.collectionRate, current.collectionRate, { min: 0, max: 1 });
  }
  if (Object.prototype.hasOwnProperty.call(patch, "logisticsFactorUsdKg")) {
    next.logisticsFactorUsdKg = numberSetting(patch.logisticsFactorUsdKg, current.logisticsFactorUsdKg, { min: 0, max: 100 });
  }
  next.updatedAt = new Date().toISOString();
  next.updatedBy = user?.username || "admin";
  fs.writeFileSync(WB_BUSINESS_SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}


async function saveWbUploadedImage(market, nmId, body) {
  const dataUrl = String(body?.dataUrl || "");
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    const error = new Error("Invalid image payload");
    error.statusCode = 400;
    throw error;
  }

  const mime = match[1].replace("image/jpg", "image/jpeg");
  const ext = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : ".jpg";
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) {
    const error = new Error("Image must be smaller than 5MB");
    error.statusCode = 400;
    throw error;
  }

  const safeMarket = market === "cross" ? "cross" : "local";
  const safeNmId = String(nmId).replace(/[^0-9A-Za-z_-]/g, "_");
  const dir = pathModule.join("/var/www/ozon-dashboard/assets/wb-images/uploads", safeMarket);
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${safeNmId}-${Date.now()}${ext}`;
  const fullPath = pathModule.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);
  return `/assets/wb-images/uploads/${safeMarket}/${filename}`;
}

async function health() {
  const payload = {
    ok: true,
    service: "ozon-api-v2",
    version: packageJson.version,
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      configured: Boolean(config.databaseUrl),
      connected: false
    },
    memoryStore: process.env.MEMORY_STORE === "true"
  };

  if (config.databaseUrl) {
    try {
      await query("SELECT 1");
      payload.database.connected = true;
    } catch (error) {
      payload.database.error = error.message;
    }
  }

  return payload;
}


function wbStrategyHistoryTable(market) {
  return market === "wb_cross" ? "wb_cross_strategy_history" : "wb_strategy_history";
}

async function ensureWbStrategyHistorySchema(market) {
  const table = wbStrategyHistoryTable(market);
  const productTable = market === "wb_cross" ? "wb_cross_products" : "wb_products";
  await query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id BIGSERIAL PRIMARY KEY,
      nm_id TEXT NOT NULL,
      strategy TEXT,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      saved_date DATE NOT NULL DEFAULT CURRENT_DATE
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS ${table}_nm_saved_idx ON ${table} (nm_id, saved_at DESC)`);
  await query(`
    INSERT INTO ${table} (nm_id, strategy, saved_at, saved_date)
    SELECT nm_id::text, strategy, COALESCE(updated_at, NOW()), COALESCE(updated_at::date, CURRENT_DATE)
    FROM ${productTable}
    WHERE strategy IS NOT NULL AND strategy <> ''
      AND NOT EXISTS (SELECT 1 FROM ${table} h WHERE h.nm_id = ${productTable}.nm_id::text)
  `);
}

async function listWbStrategyHistory(market, nmId, days = 3) {
  await ensureWbStrategyHistorySchema(market);
  const table = wbStrategyHistoryTable(market);
  const safeDays = Math.min(Math.max(Number(days) || 3, 1), 30);
  const result = await query(`
    SELECT DISTINCT ON (saved_date)
      saved_date::text AS saved_date,
      saved_at,
      strategy
    FROM ${table}
    WHERE nm_id = $1
      AND saved_date >= (CURRENT_DATE - ($2::int - 1))
    ORDER BY saved_date DESC, saved_at DESC, id DESC
  `, [String(nmId), safeDays]);
  return result.rows;
}

async function saveWbStrategyHistory(market, nmId, strategy) {
  await ensureWbStrategyHistorySchema(market);
  const table = wbStrategyHistoryTable(market);
  await query(
    `INSERT INTO ${table} (nm_id, strategy, saved_at, saved_date) VALUES ($1, $2, NOW(), CURRENT_DATE)`,
    [String(nmId), strategy ?? '']
  );
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(req, res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = decodeURIComponent(url.pathname);

  // DASHBOARD_AUTH_ROUTES_V1
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    const body = await readJson(req);
    const login = dashboardAuth.login(body.username, body.password);
    if (!login) return sendJson(req, res, 401, { error: "???????" });
    return sendJson(req, res, 200, { ok: true, user: login.user }, {
      "Set-Cookie": dashboardAuth.sessionCookie(login.token),
    });
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    dashboardAuth.logout(req);
    return sendJson(req, res, 200, { ok: true }, {
      "Set-Cookie": dashboardAuth.clearedSessionCookie(),
    });
  }
  if (url.pathname === "/api/auth/me" && req.method === "GET") {
    const user = dashboardAuth.currentUser(req);
    return user
      ? sendJson(req, res, 200, { user })
      : sendJson(req, res, 401, { error: "???" });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    const user = dashboardAuth.currentUser(req);
    if (!user) return sendJson(req, res, 401, { error: "???" });
    if (user.role !== "admin") return sendJson(req, res, 403, { error: "???????" });
    if (url.pathname === "/api/admin/users" && req.method === "GET") {
      return sendJson(req, res, 200, { users: dashboardAuth.listUsers() });
    }
    const userMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
    if (userMatch && req.method === "PUT") {
      try {
        const result = dashboardAuth.upsertOperatorUser(
          decodeURIComponent(userMatch[1]),
          await readJson(req),
        );
        return sendJson(req, res, 200, { ok: true, user: result });
      } catch (error) {
        return sendJson(req, res, 400, { error: error.message });
      }
    }
  }

  if (url.pathname.startsWith("/api/automation/")) {
    const user = dashboardAuth.currentUser(req);
    if (!user) return sendJson(req, res, 401, { ok: false, error: "Authentication required" });

    if (url.pathname === "/api/automation/overview" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await automation.overview() });
    }
    if (url.pathname === "/api/automation/backend-architecture" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: ozonBackendArchitecture.overview() });
    }
    if (url.pathname === "/api/automation/storefront-prices" && req.method === "GET") {
      return sendJson(req, res, 200, {
        ok: true,
        data: await storefrontPriceStatus.status({ freshnessHours: url.searchParams.get("freshness_hours") || 36 })
      });
    }
    if (url.pathname === "/api/automation/daily-profit" && req.method === "GET") {
      return sendJson(req, res, 200, {
        ok: true,
        data: await dailyProfit.report({ days: url.searchParams.get("days") || 7 }),
      });
    }
    if (url.pathname === "/api/automation/pricing-recommendations" && req.method === "GET") {
      return sendJson(req, res, 200, {
        ok: true,
        data: await pricingStrategy.recommendations({
          priceTestRate: url.searchParams.has("price_test_rate") ? Number(url.searchParams.get("price_test_rate")) / 100 : undefined,
          maxChangeRate: url.searchParams.has("max_change") ? Number(url.searchParams.get("max_change")) / 100 : undefined,
        }),
      });
    }
    if (url.pathname === "/api/automation/actual-costs" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await actualCosts.snapshot() });
    }
    if (url.pathname === "/api/automation/competitor-strategies" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await competitorStrategy.strategies() });
    }
    if (url.pathname === "/api/automation/seerfar-monitor" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await seerfar.monitorStatus() });
    }
    if (url.pathname === "/api/automation/advertising-recommendations" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await advertisingStrategy.recommendations() });
    }
    if (url.pathname === "/api/automation/promotion-recommendations" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await promotionStrategy.recommendations() });
    }
    if (url.pathname === "/api/automation/content-recommendations" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await contentStrategy.recommendations() });
    }
    if (url.pathname === "/api/automation/action-queue" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: {
        summary: await operationQueue.summary(),
        rows: await operationQueue.list({ status: url.searchParams.get("status") ?? "", limit: url.searchParams.get("limit") || 200 })
      } });
    }
    const actionReviewMatch = url.pathname.match(/^\/api\/automation\/action-queue\/(\d+)$/);
    if (actionReviewMatch && req.method === "PATCH") {
      if (user.role !== "admin") {
        return sendJson(req, res, 403, { ok: false, error: "Administrator access required" });
      }
      const body = await readJson(req);
      return sendJson(req, res, 200, {
        ok: true,
        data: await operationQueue.review(actionReviewMatch[1], body.decision, user)
      });
    }
    if (url.pathname === "/api/automation/executions" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await executionGuard.list({ limit: url.searchParams.get("limit") || 100 }) });
    }
    const actionSimulateMatch = url.pathname.match(/^\/api\/automation\/action-queue\/(\d+)\/simulate$/);
    if (actionSimulateMatch && req.method === "POST") {
      if (user.role !== "admin") {
        return sendJson(req, res, 403, { ok: false, error: "Administrator access required" });
      }
      return sendJson(req, res, 200, {
        ok: true,
        data: await executionGuard.simulate(actionSimulateMatch[1], user)
      });
    }
    if (url.pathname === "/api/automation/jobs" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: await automation.listJobs() });
    }
    if (url.pathname === "/api/automation/runs" && req.method === "GET") {
      return sendJson(req, res, 200, {
        ok: true,
        data: await automation.listRuns(url.searchParams.get("limit") || 50)
      });
    }
    const runMatch = url.pathname.match(/^\/api\/automation\/jobs\/([^/]+)\/run$/);
    if (runMatch && req.method === "POST") {
      if (user.role !== "admin") {
        return sendJson(req, res, 403, { ok: false, error: "Administrator access required" });
      }
      return sendJson(req, res, 200, {
        ok: true,
        data: await automation.runJob(runMatch[1], "manual")
      });
    }
    const jobMatch = url.pathname.match(/^\/api\/automation\/jobs\/([^/]+)$/);
    if (jobMatch && req.method === "PATCH") {
      if (user.role !== "admin") {
        return sendJson(req, res, 403, { ok: false, error: "Administrator access required" });
      }
      return sendJson(req, res, 200, {
        ok: true,
        data: await automation.updateJob(jobMatch[1], await readJson(req))
      });
    }
    return sendJson(req, res, 404, { ok: false, error: "Automation route not found" });
  }

  if (url.pathname.startsWith("/api/russia/")) {
    const user = dashboardAuth.currentUser(req);
    if (!user) return sendJson(req, res, 401, { error: "???" });
    if (url.pathname === "/api/russia/settings" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: publicRussiaOperationsSettings() });
    }
    if (url.pathname === "/api/russia/bonus-coefficients" && req.method === "GET") {
      if (user.role !== "admin") return sendJson(req, res, 403, { ok: false, error: "仅管理员可查看提奖系数" });
      return sendJson(req, res, 200, {
        ok: true,
        data: readRussiaOperationsSettings().bonusCoefficients || {},
      });
    }
    const bonusCoefficientMatch = url.pathname.match(/^\/api\/russia\/bonus-coefficients\/([^/]+)$/);
    if (bonusCoefficientMatch && req.method === "PUT") {
      if (user.role !== "admin") return sendJson(req, res, 403, { ok: false, error: "仅管理员可修改提奖系数" });
      try {
        const body = await readJson(req);
        return sendJson(req, res, 200, {
          ok: true,
          data: saveRussiaBonusCoefficient(bonusCoefficientMatch[1], body.coefficient, user),
        });
      } catch (error) {
        return sendJson(req, res, 400, { ok: false, error: error.message });
      }
    }
    if (url.pathname === "/api/russia/settings" && req.method === "PATCH") {
      if (user.role !== "admin") return sendJson(req, res, 403, { ok: false, error: "仅管理员可修改经营参数" });
      return sendJson(req, res, 200, { ok: true, data: saveRussiaOperationsSettings(await readJson(req), user) });
    }
    if (url.pathname === "/api/russia/months" && req.method === "GET") {
      const manifest = JSON.parse(
        fs.readFileSync("/var/www/ozon-dashboard/russia-unit-economics-months.json", "utf8"),
      );
      return sendJson(req, res, 200, manifest);
    }
    const monthMatch = url.pathname.match(/^\/api\/russia\/month\/(\d{4}-\d{2})$/);
    if (monthMatch && req.method === "GET") {
      const filename = `/var/www/ozon-dashboard/russia-unit-economics-${monthMatch[1]}.json`;
      if (!fs.existsSync(filename)) return sendJson(req, res, 404, { error: "???????" });
      const payload = JSON.parse(fs.readFileSync(filename, "utf8"));
      return sendJson(req, res, 200, dashboardAuth.filterEconomicsPayload(payload, user));
    }
    if (url.pathname === "/api/russia/operators" && req.method === "GET") {
      const assignments = dashboardAuth.listAssignments();
      const visible = user.role === "admin"
        ? assignments
        : Object.fromEntries(Object.entries(assignments).filter(([, value]) => value === user.operator));
      return sendJson(req, res, 200, { assignments: visible });
    }
    const operatorMatch = url.pathname.match(/^\/api\/russia\/operators\/([^/]+)$/);
    if (operatorMatch && req.method === "PUT") {
      if (user.role !== "admin") return sendJson(req, res, 403, { error: "???????SKU" });
      try {
        const result = dashboardAuth.setAssignment(
          decodeURIComponent(operatorMatch[1]),
          (await readJson(req)).operator,
        );
        return sendJson(req, res, 200, { ok: true, assignment: result });
      } catch (error) {
        return sendJson(req, res, 400, { error: error.message });
      }
    }
  }

  if (url.pathname.startsWith("/api/wb/business")) {
    const user = dashboardAuth.currentUser(req);
    if (!user) return sendJson(req, res, 401, { ok: false, error: "Authentication required" });

    if (url.pathname === "/api/wb/business/settings" && req.method === "GET") {
      return sendJson(req, res, 200, { ok: true, data: readWbBusinessSettings() });
    }
    if (url.pathname === "/api/wb/business/settings" && req.method === "PATCH") {
      if (user.role !== "admin") {
        return sendJson(req, res, 403, { ok: false, error: "仅管理员可修改WB经营参数" });
      }
      return sendJson(req, res, 200, {
        ok: true,
        data: saveWbBusinessSettings(await readJson(req), user),
      });
    }
    const costMatch = url.pathname.match(/^\/api\/wb\/business-costs\/(\d{4}-\d{2})$/);
    if (costMatch && req.method === "GET") {
      const filename = `/var/www/ozon-dashboard/russia-unit-economics-${costMatch[1]}.json`;
      if (!fs.existsSync(filename)) {
        return sendJson(req, res, 404, { ok: false, error: "该月份成本数据尚未同步" });
      }
      const payload = JSON.parse(fs.readFileSync(filename, "utf8"));
      return sendJson(req, res, 200, payload);
    }
  }

  if (req.method === "GET" && path === "/") {
    sendJson(req, res, 200, {
      ok: true,
      service: "ozon-api-v2",
      endpoints: [
        "GET /health",
        "GET /api/dashboard",
        "GET /api/products",
        "POST /api/products",
        "GET /api/products/:offer_id",
        "GET /api/products/:offer_id/metrics",
        "GET /api/metrics/:offer_id",
        "PATCH /api/products/:offer_id",
        "DELETE /api/products/:offer_id",
        "GET /api/ozon/products/:offer_id/card",
        "POST /api/ozon/products/:offer_id/update-preview",
        "POST /api/ozon/products/:offer_id/update-submit",
        "GET /api/ozon/replenishment/fbo-clusters",
        "POST /api/seerfar/competitors/sync",
        "GET /api/products/:offer_id/competitor-insights",
        "GET /api/ozon/finance/transactions"
      ]
    });
    return;
  }

  if (req.method === "GET" && path === "/health") {
    sendJson(req, res, 200, await health());
    return;
  }


  if (req.method === "GET" && path === "/api/inventory/dashboard") {
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.dashboard({
        showHidden: url.searchParams.get("show_hidden") === "1",
        refresh: url.searchParams.get("refresh") === "1"
      })
    });
    return;
  }

  if (req.method === "POST" && path === "/api/inventory/unallocated/import") {
    const expected = String(process.env.INVENTORY_UNALLOCATED_SYNC_TOKEN || "");
    const provided = String(req.headers["x-inventory-sync-token"] || "");
    if (!expected || provided !== expected) {
      sendJson(req, res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    sendJson(req, res, 200, { ok: true, data: await inventory.importUnallocatedStock(await readJson(req)) });
    return;
  }

  if (req.method === "POST" && path === "/api/inventory/first-leg-transit/import") {
    const expected = String(process.env.INVENTORY_UNALLOCATED_SYNC_TOKEN || "");
    const provided = String(req.headers["x-inventory-sync-token"] || "");
    if (!expected || provided !== expected) {
      sendJson(req, res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    sendJson(req, res, 200, { ok: true, data: await inventory.importFirstLegTransit(await readJson(req)) });
    return;
  }

  if (req.method === "GET" && path === "/api/inventory/cards") {
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.searchCards({
        market: url.searchParams.get("market") || "wb",
        q: url.searchParams.get("q") || "",
        limit: url.searchParams.get("limit") || 20
      })
    });
    return;
  }



  const inventoryCandidatesMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/candidates$/);
  if (inventoryCandidatesMatch && req.method === "GET") {
    sendJson(req, res, 200, { ok: true, data: await inventory.productCandidates(inventoryCandidatesMatch[1]) });
    return;
  }

  if (req.method === "POST" && path === "/api/inventory/dashboard/refresh") {
    sendJson(req, res, 202, {
      ok: true,
      data: inventory.startBackgroundRefresh({ showHidden: url.searchParams.get("show_hidden") === "1" })
    });
    return;
  }

  if (req.method === "GET" && path === "/api/inventory/dashboard/refresh-status") {
    sendJson(req, res, 200, { ok: true, data: inventory.refreshStatus() });
    return;
  }

  if (req.method === "GET" && path === "/api/inventory/order-sync/status") {
    sendJson(req, res, 200, { ok: true, data: await inventoryOrderSync.status() });
    return;
  }

  if (req.method === "GET" && path === "/api/inventory/daily-shipments") {
    sendJson(req, res, 200, { ok: true, data: await inventoryOrderSync.dailyShipments(url.searchParams.get("date") || undefined) });
    return;
  }


  const inventoryDailyShipmentHistoryMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/daily-shipment-history$/);
  if (inventoryDailyShipmentHistoryMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await inventoryOrderSync.dailyShipmentHistory(
        inventoryDailyShipmentHistoryMatch[1],
        url.searchParams.get("warehouse") || "linting",
        url.searchParams.get("days") || 30
      )
    });
    return;
  }

  const inventoryHistoryMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/warehouse-history$/);
  if (inventoryHistoryMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await inventoryHistory.listDailyLatest(
        inventoryHistoryMatch[1],
        url.searchParams.get("warehouse") || "linting",
        url.searchParams.get("days") || 30,
        url.searchParams.get("kind") || "system"
      )
    });
    return;
  }

  if (req.method === "POST" && path === "/api/inventory/order-sync/run") {
    sendJson(req, res, 200, { ok: true, data: await inventoryOrderSync.runOnce() });
    return;
  }

  if (req.method === "POST" && path === "/api/inventory/products/from-wb") {
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.createProductFromWbCard(await readJson(req))
    });
    return;
  }

  if (req.method === "POST" && path === "/api/inventory/links") {
    sendJson(req, res, 200, { ok: true, data: await inventory.createLink(await readJson(req)) });
    return;
  }

  const inventoryLinkMatch = path.match(/^\/api\/inventory\/links\/([^/]+)$/);
  if (inventoryLinkMatch && req.method === "DELETE") {
    const deleted = await inventory.deleteLink(inventoryLinkMatch[1]);
    sendJson(req, res, deleted ? 200 : 404, deleted ? { ok: true, data: deleted } : { ok: false, error: "Link not found" });
    return;
  }

  const inventoryWbCardWarehouseMatch = path.match(/^\/api\/inventory\/cards\/(wb|wb_cross)\/([^/]+)\/warehouse-stock$/);
  if (inventoryWbCardWarehouseMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.setWbCardWarehouseStock({
        market: inventoryWbCardWarehouseMatch[1],
        nm_id: inventoryWbCardWarehouseMatch[2],
        warehouse_key: body.warehouse_key,
        stock: body.stock,
        source_note: body.source_note || ""
      })
    });
    return;
  }

  const inventoryBarcodeMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/barcode$/);
  if (inventoryBarcodeMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.setBarcode(inventoryBarcodeMatch[1], body.barcode || "")
    });
    return;
  }

  const inventoryWarehouseFbsMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/manual-warehouse-fbs$/);
  if (inventoryWarehouseFbsMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.setManualWarehouseFbsStock(
        inventoryWarehouseFbsMatch[1],
        body.warehouse_key || body.warehouseKey || "linting",
        body.manual_stock ?? body.manualStock ?? body.value
      )
    });
    return;
  }

  const inventoryWarehouseActualMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/manual-warehouse-actual$/);
  if (inventoryWarehouseActualMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.setManualWarehouseActualStock(
        inventoryWarehouseActualMatch[1],
        body.warehouse_key || body.warehouseKey || "linting",
        body.manual_stock ?? body.manualStock ?? body.value
      )
    });
    return;
  }

  const inventoryFirstLegMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/first-leg-transit$/);
  if (inventoryFirstLegMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, { ok: true, data: await inventory.setFirstLegTransit(inventoryFirstLegMatch[1], body.quantity ?? body.value) });
    return;
  }

  const inventoryManualDailyShipmentMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/manual-daily-shipment$/);
  if (inventoryManualDailyShipmentMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.setManualDailyShipment(
        inventoryManualDailyShipmentMatch[1],
        body.warehouse_key || body.warehouseKey || "linting",
        body.shipment_date || body.shipmentDate || body.date || "",
        body.manual_quantity ?? body.manualQuantity ?? body.quantity ?? body.value
      )
    });
    return;
  }

  const inventoryManualFbsMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/manual-fbs$/);
  if (inventoryManualFbsMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await inventory.setManualFbsStock(
        inventoryManualFbsMatch[1],
        body.manual_fbs_stock ?? body.value ?? 0
      )
    });
    return;
  }

  const inventoryHiddenMatch = path.match(/^\/api\/inventory\/products\/([^/]+)\/hidden$/);
  if (inventoryHiddenMatch && req.method === "PATCH") {
    const body = await readJson(req);
    sendJson(req, res, 200, { ok: true, data: await inventory.setHidden(inventoryHiddenMatch[1], body.hidden !== false) });
    return;
  }

  if (req.method === "GET" && path === "/api/dashboard") {
    sendJson(req, res, 200, {
      ok: true,
      data: await products.dashboard({
        date: url.searchParams.get("date") || "",
        showHidden: url.searchParams.get("show_hidden") || url.searchParams.get("showHidden") || ""
      })
    });
    return;
  }

  if (req.method === "GET" && path === "/api/store-metrics") {
    sendJson(req, res, 200, {
      ok: true,
      data: await products.storeMetrics({
        days: url.searchParams.get("days") || 30
      })
    });
    return;
  }


  if (req.method === "GET" && path === "/api/ozon/finance/transactions") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.listFinanceTransactions({
        from: url.searchParams.get("from") || "",
        to: url.searchParams.get("to") || "",
        pageSize: url.searchParams.get("page_size") || 1000,
        includeItems: url.searchParams.get("include_items") === "true"
      })
    });
    return;
  }

  if (req.method === "GET" && path === "/api/ozon/replenishment/fbo-clusters") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.listFboClusterReplenishment({
        days: url.searchParams.get("days") || 30,
        targetDays: url.searchParams.get("target_days") || 30,
        offers: url.searchParams.get("offers") || "",
        refresh: url.searchParams.get("refresh") === "1",
        compact: url.searchParams.get("compact") === "1"
      })
    });
    return;
  }

  const ozonCardMatch = path.match(/^\/api\/ozon\/products\/([^/]+)\/card$/);
  if (ozonCardMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.getOzonProductCard(ozonCardMatch[1])
    });
    return;
  }

  const ozonUpdatePreviewMatch = path.match(/^\/api\/ozon\/products\/([^/]+)\/update-preview$/);
  if (ozonUpdatePreviewMatch && req.method === "POST") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.buildOzonProductUpdatePreview(ozonUpdatePreviewMatch[1], await readJson(req))
    });
    return;
  }

  const ozonUpdateSubmitMatch = path.match(/^\/api\/ozon\/products\/([^/]+)\/update-submit$/);
  if (ozonUpdateSubmitMatch && req.method === "POST") {
    const body = await readJson(req);
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.submitOzonProductUpdate(
        ozonUpdateSubmitMatch[1],
        body.updates || body,
        body.confirm || ""
      )
    });
    return;
  }

  if (req.method === "GET" && path === "/api/exchange-rate") {
    sendJson(req, res, 200, { ok: true, data: await getRubRate() });
    return;
  }


  if (req.method === "GET" && path === "/api/wb/sync-status") {
      sendJson(req, res, 200, { ok: true, data: wbSyncState });
      return;
    }

    if (req.method === "GET" && path === "/api/wb/dashboard") {
    sendJson(req, res, 200, { ok: true, data: await wb.dashboard({ date: url.searchParams.get("date") || "" }) });
    return;
  }

  if (req.method === "POST" && path === "/api/sync/wb") {
      const days = url.searchParams.get("days") || 3;

      if (wbSyncState.running) {
        sendJson(req, res, 202, {
          ok: true,
          data: {
            accepted: true,
            running: true,
            message: "WB 同步已在后台运行，页面继续显示上次成功缓存数据",
            state: wbSyncState
          }
        });
        return;
      }

      wbSyncState.running = true;
      wbSyncState.lastStartedAt = new Date().toISOString();
      wbSyncState.lastError = "";
      wbSyncState.lastErrorDetails = null;
      wbSyncState.retryAfterSeconds = null;
      wbSyncState.phases = {};
      wbSyncState.currentStage = "";

      Promise.resolve()
        .then(() => wb.sync({
          days,
          onPhase: (name, phase, progress) => {
            wbSyncState.currentStage = phase && phase.running ? name : "";
            wbSyncState.phases = progress && progress.phases ? progress.phases : wbSyncState.phases;
            wbSyncState.lastResult = progress || wbSyncState.lastResult;
          }
        }))
        .then((result) => {
          const finishedAt = new Date().toISOString();
          wbSyncState.lastResult = result || null;
          wbSyncState.phases = result && result.phases ? result.phases : {};
          wbSyncState.lastFinishedAt = finishedAt;
          if (result && result.partialFailure) {
            wbSyncState.lastError = result.error || "WB 同步部分失败";
            if (result.retryAfterSeconds) wbSyncState.retryAfterSeconds = result.retryAfterSeconds;
            if (result.errorDetails) wbSyncState.lastErrorDetails = result.errorDetails;
            console.error("[wb-sync-background]", wbSyncState.lastError, result.errorDetails ? JSON.stringify(result.errorDetails).slice(0, 500) : "");
          } else {
            wbSyncState.lastOkAt = finishedAt;
            wbSyncState.lastError = "";
            wbSyncState.lastErrorDetails = null;
            wbSyncState.retryAfterSeconds = null;
          }
        })
        .catch((error) => {
          wbSyncState.lastError = error && error.message ? error.message : String(error);
          if (error && error.retryAfterSeconds) wbSyncState.retryAfterSeconds = error.retryAfterSeconds;
          if (error && error.details) wbSyncState.lastErrorDetails = error.details;
          wbSyncState.lastFinishedAt = new Date().toISOString();
          console.error("[wb-sync-background]", wbSyncState.lastError, error && error.details ? JSON.stringify(error.details).slice(0, 500) : "");
        })
        .finally(() => {
          wbSyncState.running = false;
        });

      sendJson(req, res, 202, {
        ok: true,
        data: {
          accepted: true,
          running: true,
          message: "WB 同步已提交后台任务，页面继续显示上次成功缓存数据",
          state: wbSyncState
        }
      });
      return;
    }

  if (req.method === "POST" && path === "/api/sync/wb/stocks") {
    sendJson(req, res, 200, { ok: true, data: await wb.syncStocks() });
    return;
  }

  if (req.method === "GET" && path === "/api/wb/store-metrics") {
    sendJson(req, res, 200, { ok: true, data: await wb.storeMetrics({ days: url.searchParams.get("days") || 30 }) });
    return;
  }

  const wbMetricsMatch = path.match(/^\/api\/wb\/metrics\/([^/]+)$/);
  if (wbMetricsMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await wb.listMetrics(wbMetricsMatch[1], { days: url.searchParams.get("days") || 30 })
    });
    return;
  }


  const wbImageUploadMatch = path.match(/^\/api\/wb\/products\/([^/]+)\/image$/);
  if (wbImageUploadMatch && req.method === "POST") {
    const imageUrl = await saveWbUploadedImage("local", wbImageUploadMatch[1], await readJson(req));
    const product = await wb.updateProduct(wbImageUploadMatch[1], { image_url: imageUrl });
    sendJson(req, res, product ? 200 : 404, product ? { ok: true, data: product, image_url: imageUrl } : { ok: false, error: "WB product not found" });
    return;
  }


  const wbStrategyHistoryMatch = path.match(/^\/api\/wb\/products\/([^/]+)\/strategy-history$/);
  if (wbStrategyHistoryMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await listWbStrategyHistory("wb", wbStrategyHistoryMatch[1], url.searchParams.get("days") || 3)
    });
    return;
  }

  const wbProductMatch = path.match(/^\/api\/wb\/products\/([^/]+)$/);
  if (wbProductMatch && req.method === "PATCH") {
    const patch = await readJson(req);
    const product = await wb.updateProduct(wbProductMatch[1], patch);
    if (product && Object.prototype.hasOwnProperty.call(patch, "strategy")) {
      await saveWbStrategyHistory("wb", wbProductMatch[1], patch.strategy);
    }
    sendJson(req, res, product ? 200 : 404, product ? { ok: true, data: product } : { ok: false, error: "WB product not found" });
    return;
  }


  if (req.method === "GET" && path === "/api/wb/mappings") {
    await wbMapping.autoMapByVendorCode();
    sendJson(req, res, 200, { ok: true, data: await wbMapping.listMappings() });
    return;
  }


  const wbMappingMatch = path.match(/^\/api\/wb\/mappings\/([^/]+)$/);
  if (wbMappingMatch && req.method === "DELETE") {
    const deleted = await wbMapping.deleteMapping(wbMappingMatch[1]);
    sendJson(req, res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: "Mapping not found" });
    return;
  }

  if (req.method === "POST" && path === "/api/wb/mappings") {
    const body = await readJson(req);
    const mapping = await wbMapping.createMapping(body.wb_nm_id, body.wb_cross_nm_id);
    sendJson(req, res, 200, { ok: true, data: mapping });
    return;
  }

  if (req.method === "POST" && path === "/api/sync/ozon") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozonSyncLock.withLock("legacy-ozon-metrics", () =>
        ozon.syncOzonMetrics({ days: url.searchParams.get("days") || 30 })
      )
    });
    return;
  }

  if (req.method === "POST" && path === "/api/sync/ozon/products") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozonSyncLock.withLock("legacy-ozon-products", () => ozon.syncOzonProducts())
    });
    return;
  }

  if (req.method === "POST" && path === "/api/sync/ozon/inventory-stocks") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozonSyncLock.withLock("legacy-ozon-inventory", () => inventory.refreshOzonStockSnapshot())
    });
    return;
  }

  if (req.method === "GET" && path === "/api/sync/ozon/preview") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.previewOzonAnalytics({
        days: url.searchParams.get("days") || 3,
        limit: url.searchParams.get("limit") || 10
      })
    });
    return;
  }

  if (req.method === "POST" && path === "/api/seerfar/competitors/sync") {
    const body = await readJson(req);
    sendJson(req, res, 200, { ok: true, data: await seerfar.syncCompetitor(body) });
    return;
  }

  const seerfarInsightsMatch = path.match(/^\/api\/products\/([^/]+)\/competitor-insights$/);
  if (seerfarInsightsMatch && req.method === "GET") {
    sendJson(req, res, 200, { ok: true, data: await seerfar.getInsights(seerfarInsightsMatch[1]) });
    return;
  }

  const strategyHistoryMatch = path.match(/^\/api\/products\/([^/]+)\/strategy-history$/);
  if (strategyHistoryMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await products.listStrategyHistory(strategyHistoryMatch[1], {
        days: url.searchParams.get("days") || 3
      })
    });
    return;
  }

  const metricsAliasMatch = path.match(/^\/api\/metrics\/([^/]+)$/);
  if (metricsAliasMatch && req.method === "GET") {
    sendJson(req, res, 200, {
      ok: true,
      data: await products.listMetrics(metricsAliasMatch[1], {
        days: url.searchParams.get("days") || 30
      })
    });
    return;
  }

  if (req.method === "GET" && path === "/api/products") {
    sendJson(req, res, 200, {
      ok: true,
      data: await products.listProducts({
        search: url.searchParams.get("search") || "",
        limit: url.searchParams.get("limit") || 500,
        offset: url.searchParams.get("offset") || 0,
        showHidden: url.searchParams.get("show_hidden") || url.searchParams.get("showHidden") || ""
      })
    });
    return;
  }

  if (req.method === "GET" && path === "/products") {
    sendJson(req, res, 200, {
      products: await products.listProducts({
        search: url.searchParams.get("search") || "",
        limit: url.searchParams.get("limit") || 500,
        offset: url.searchParams.get("offset") || 0,
        showHidden: url.searchParams.get("show_hidden") || url.searchParams.get("showHidden") || ""
      })
    });
    return;
  }

  if (req.method === "POST" && path === "/api/products") {
    const product = await products.createProduct(await readJson(req));
    sendJson(req, res, 201, { ok: true, data: product });
    return;
  }

  if (req.method === "POST" && path === "/api/import/products") {
    const body = await readJson(req);
    const items = Array.isArray(body) ? body : body.products || body.data?.products || body.data || [];
    sendJson(req, res, 200, { ok: true, data: await products.importProducts(items) });
    return;
  }

  if (req.method === "POST" && path === "/products") {
    const body = await readJson(req);
    const offerId = body.offer_id || body.sku || body.SKU;
    const product = offerId && (await products.getProduct(String(offerId)))
      ? await products.updateProduct(String(offerId), body)
      : await products.createProduct(body);
    sendJson(req, res, 200, { success: true, partialUpdate: true, product });
    return;
  }

  const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
  if (productMatch) {
    const offerId = productMatch[1];

    if (req.method === "GET") {
      const product = await products.getProduct(offerId);
      if (!product) {
        sendJson(req, res, 404, { ok: false, error: "Product not found" });
        return;
      }
      sendJson(req, res, 200, { ok: true, data: product });
      return;
    }

    if (req.method === "PATCH") {
      const body = await readJson(req);
      const product = await products.updateProduct(offerId, body);
      sendJson(req, res, 200, { ok: true, data: product });
      return;
    }

    if (req.method === "DELETE") {
      const deleted = await products.deleteProduct(offerId);
      sendJson(req, res, deleted ? 200 : 404, deleted ? { ok: true } : { ok: false, error: "Product not found" });
      return;
    }
  }

  const metricsMatch = path.match(/^\/api\/products\/([^/]+)\/metrics$/);
  if (metricsMatch) {
    const offerId = metricsMatch[1];

    if (req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        data: await products.listMetrics(offerId, {
          days: url.searchParams.get("days") || 30
        })
      });
      return;
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      const metrics = Array.isArray(body) ? body : body.metrics || [];
      sendJson(req, res, 200, {
        ok: true,
        data: await products.upsertMetrics(offerId, metrics)
      });
      return;
    }
  }


    const wbCrossBusinessCostsMatch = path.match(/^\/api\/wb-cross\/business-costs\/(\d{4}-\d{2})$/);
    if (wbCrossBusinessCostsMatch && req.method === "GET") {
      const user = dashboardAuth.currentUser(req);
      if (!user) return sendJson(req, res, 401, { error: "Authentication required" });
      const filename = `/var/www/ozon-dashboard/russia-unit-economics-${wbCrossBusinessCostsMatch[1]}.json`;
      if (!fs.existsSync(filename)) return sendJson(req, res, 404, { error: "Monthly data not found" });
      return sendJson(req, res, 200, JSON.parse(fs.readFileSync(filename, "utf8")));
    }

    if (req.method === "GET" && path === "/api/wb/ads/summary") {
      sendJson(req, res, 200, {
        ok: true,
        data: await wb.adSummary({ month: url.searchParams.get("month") || "" })
      });
      return;
    }

    if (req.method === "GET" && path === "/api/wb-cross/ads/summary") {
      sendJson(req, res, 200, {
        ok: true,
        data: await wbCross.adSummary({
          month: url.searchParams.get("month") || "",
          date: url.searchParams.get("date") || ""
        })
      });
      return;
    }

    if (req.method === "POST" && path === "/api/sync/wb-cross/ads") {
      const from = url.searchParams.get("from") || "";
      const to = url.searchParams.get("to") || "";
      sendJson(req, res, 200, { ok: true, data: await wbCross.syncAds({ from, to }) });
      return;
    }

    if (req.method === "GET" && path === "/api/wb-cross/dashboard") {
      sendJson(req, res, 200, { ok: true, data: await wbCross.dashboard({ date: url.searchParams.get("date") || "" }) });
      return;
    }
    if (req.method === "POST" && path === "/api/sync/wb-cross") {
      const days = url.searchParams.get("days") || 7;

      if (wbCrossSyncState.running) {
        sendJson(req, res, 202, {
          ok: true,
          data: {
            accepted: true,
            running: true,
            message: "WB 跨境同步已在后台运行，页面继续显示上次缓存数据",
            state: wbCrossSyncState
          }
        });
        return;
      }

      wbCrossSyncState.running = true;
      wbCrossSyncState.lastStartedAt = new Date().toISOString();
      wbCrossSyncState.lastError = "";

      Promise.resolve()
        .then(() => wbCross.syncSales(days))
        .then((result) => {
          wbCrossSyncState.lastResult = result || null;
          wbCrossSyncState.lastOkAt = new Date().toISOString();
          wbCrossSyncState.lastFinishedAt = wbCrossSyncState.lastOkAt;
        })
        .catch((error) => {
          wbCrossSyncState.lastError = error && error.message ? error.message : String(error);
          wbCrossSyncState.lastFinishedAt = new Date().toISOString();
          console.error("[wb-cross-sync-background]", wbCrossSyncState.lastError);
        })
        .finally(() => {
          wbCrossSyncState.running = false;
        });

      sendJson(req, res, 202, {
        ok: true,
        data: {
          accepted: true,
          running: true,
          message: "WB 跨境同步已提交后台任务，页面继续显示上次缓存数据",
          state: wbCrossSyncState
        }
      });
      return;
    }

    if (req.method === "GET" && path === "/api/wb-cross/sync-status") {
      sendJson(req, res, 200, { ok: true, data: wbCrossSyncState });
      return;
    }

    if (req.method === "GET" && path === "/api/wb-cross/store-metrics") {
      sendJson(req, res, 200, { ok: true, data: await wbCross.storeMetrics({ days: url.searchParams.get("days") || 30 }) });
      return;
    }


    const wbCrossStrategyHistoryMatch = path.match(/^\/api\/wb-cross\/products\/([^/]+)\/strategy-history$/);
    if (wbCrossStrategyHistoryMatch && req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        data: await listWbStrategyHistory("wb_cross", wbCrossStrategyHistoryMatch[1], url.searchParams.get("days") || 3)
      });
      return;
    }

    const wbCrossOfficialCardMatch = path.match(/^\/api\/wb-cross\/products\/([^/]+)\/card$/);
    if (wbCrossOfficialCardMatch && req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        data: await wbCross.getWbCrossOfficialCard(wbCrossOfficialCardMatch[1])
      });
      return;
    }

    const wbCrossUpdatePreviewMatch = path.match(/^\/api\/wb-cross\/products\/([^/]+)\/update-preview$/);
    if (wbCrossUpdatePreviewMatch && req.method === "POST") {
      sendJson(req, res, 200, {
        ok: true,
        data: await wbCross.buildWbCrossUpdatePreview(wbCrossUpdatePreviewMatch[1], await readJson(req))
      });
      return;
    }

    const wbCrossUpdateSubmitMatch = path.match(/^\/api\/wb-cross\/products\/([^/]+)\/update-submit$/);
    if (wbCrossUpdateSubmitMatch && req.method === "POST") {
      const body = await readJson(req);
      sendJson(req, res, 200, {
        ok: true,
        data: await wbCross.submitWbCrossUpdate(
          wbCrossUpdateSubmitMatch[1],
          body.updates || body,
          body.confirm || ""
        )
      });
      return;
    }


    const wbCrossImageUploadMatch = path.match(/^\/api\/wb-cross\/products\/([^/]+)\/image$/);
    if (wbCrossImageUploadMatch && req.method === "POST") {
      const imageUrl = await saveWbUploadedImage("cross", wbCrossImageUploadMatch[1], await readJson(req));
      const product = await wbCross.updateProduct(wbCrossImageUploadMatch[1], { image_url: imageUrl });
      sendJson(req, res, product ? 200 : 404, product ? { ok: true, data: product, image_url: imageUrl } : { ok: false, error: "WB cross product not found" });
      return;
    }

    const wbCrossMetricsMatch = path.match(/^\/api\/wb-cross\/metrics\/([^/]+)$/);
    const wbCrossProductMatch = path.match(/^\/api\/wb-cross\/products\/([^/]+)$/);
    if (wbCrossMetricsMatch && req.method === "GET") {
      sendJson(req, res, 200, {
        ok: true,
        data: await wbCross.listMetrics(wbCrossMetricsMatch[1], { days: url.searchParams.get("days") || 7 })
      });
      return;
    }


    if (wbCrossProductMatch && req.method === "PATCH") {
      const patch = await readJson(req);
      const product = await wbCross.updateProduct(wbCrossProductMatch[1], patch);
      if (product && Object.prototype.hasOwnProperty.call(patch, "strategy")) {
        await saveWbStrategyHistory("wb_cross", wbCrossProductMatch[1], patch.strategy);
      }
      sendJson(req, res, product ? 200 : 404, product ? { ok: true, data: product } : { ok: false, error: "WB cross product not found" });
      return;
    }

    if (req.method === "POST" && path === "/api/sync/wb-cross/sales") {
      sendJson(req, res, 200, { ok: true, data: await wbCross.syncSales(url.searchParams.get("days") || 30) });
      return;
    }

    if (req.method === "POST" && path === "/api/sync/wb-cross/stocks") {
      sendJson(req, res, 200, { ok: true, data: await wbCross.syncStocks() });
      return;
    }
    sendJson(req, res, 404, { ok: false, error: "Route not found" });
}


const wbSyncState = globalThis.__wbSyncState || (globalThis.__wbSyncState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastOkAt: null,
  lastError: "",
  lastErrorDetails: null,
  retryAfterSeconds: null,
  phases: {},
  currentStage: "",
  lastResult: null
});

const wbCrossSyncState = globalThis.__wbCrossSyncState || (globalThis.__wbCrossSyncState = {
  running: false,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastOkAt: null,
  lastError: "",
  lastResult: null
});

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("[api:error]", {
      method: req.method,
      url: req.url,
      message: error.message
    });
    sendJson(req, res, error.statusCode || 500, {
      ok: false,
      error: error.message
    });
  });
});

async function start() {
  if (config.databaseUrl && config.autoMigrate) {
    try {
      await migrate();
      console.log("[ozon-api-v2] database schema is ready");
    } catch (error) {
      console.error("[ozon-api-v2] auto migration failed; service will still start", error.message);
    }
  }

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[ozon-api-v2] listening on 0.0.0.0:${config.port}`);
    inventoryOrderSync.start();
    automation.start({
      ozon_products_read_sync: () => ozonSyncLock.withLock("automation-ozon-products", () => ozon.syncOzonProducts()),
      ozon_metrics_read_sync: () => ozonSyncLock.withLock("automation-ozon-metrics", () => ozon.syncOzonMetrics({ days: 7 })),
      seerfar_monitor_read_sync: () => ozonSyncLock.withLock("automation-seerfar-monitor", () => seerfar.syncMonitorCompetitors()),
      ozon_ad_campaign_read_sync: () => ozonSyncLock.withLock("automation-ad-campaigns", () => ozon.syncPerformanceCampaignSnapshot()),
      ozon_advertising_strategy_refresh: () => advertisingStrategy.refreshQueue(),
      ozon_promotion_read_sync: () => ozonSyncLock.withLock("automation-ozon-promotions", () => ozonPromotionSync.sync()),
      ozon_promotion_strategy_refresh: () => promotionStrategy.refreshQueue(),
      ozon_content_strategy_refresh: () => contentStrategy.refreshQueue()
    });
    inventoryHistory.ensureSchema().catch((error) => console.error("[inventory-history]", error.message));
    console.log("[inventory-order-sync] scheduled");
  });
}

start().catch((error) => {
  console.error("[ozon-api-v2] failed to start", error);
  process.exit(1);
});
