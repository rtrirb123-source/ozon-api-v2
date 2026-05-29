const http = require("http");
const { URL } = require("url");
const { config } = require("./config");
const { query } = require("./db");
const { migrate } = require("./schema");
const products = require("./products");
const ozon = require("./ozon");
const packageJson = require("../package.json");

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

function sendJson(req, res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(req)
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
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

async function route(req, res) {
  if (req.method === "OPTIONS") {
    sendJson(req, res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = decodeURIComponent(url.pathname);

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
        "DELETE /api/products/:offer_id"
      ]
    });
    return;
  }

  if (req.method === "GET" && path === "/health") {
    sendJson(req, res, 200, await health());
    return;
  }

  if (req.method === "GET" && path === "/api/dashboard") {
    sendJson(req, res, 200, { ok: true, data: await products.dashboard() });
    return;
  }

  if (req.method === "POST" && path === "/api/sync/ozon") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.syncOzonMetrics({
        days: url.searchParams.get("days") || 30
      })
    });
    return;
  }

  if (req.method === "POST" && path === "/api/sync/ozon/products") {
    sendJson(req, res, 200, {
      ok: true,
      data: await ozon.syncOzonProducts()
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
        offset: url.searchParams.get("offset") || 0
      })
    });
    return;
  }

  if (req.method === "GET" && path === "/products") {
    sendJson(req, res, 200, {
      products: await products.listProducts({
        search: url.searchParams.get("search") || "",
        limit: url.searchParams.get("limit") || 500,
        offset: url.searchParams.get("offset") || 0
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
      const product = await products.updateProduct(offerId, await readJson(req));
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

  sendJson(req, res, 404, { ok: false, error: "Route not found" });
}

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
  });
}

start().catch((error) => {
  console.error("[ozon-api-v2] failed to start", error);
  process.exit(1);
});
