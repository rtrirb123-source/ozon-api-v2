const { config } = require("./config");
const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");

const CACHE_TTL_MS = 10 * 60 * 1000;
const VAT_RATE = 0.15;
const API_USER_AGENT = "Mozilla/5.0 (compatible; AqicrossDashboard/1.0; +https://115.29.234.40/)";
const cache = { payload: null, fetchedAt: 0, promise: null };
const apiAgent = config.apiSocksProxy ? new SocksProxyAgent(config.apiSocksProxy) : undefined;

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function sastDate(daysAgo = 0) {
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000);
  now.setUTCDate(now.getUTCDate() - daysAgo);
  return now.toISOString().slice(0, 10);
}

function isCountedSale(item) {
  return !/(cancel|failed)/i.test(String(item.sale_status || ""));
}

function addDays(map, item) {
  const key = dateKey(item.order_date);
  const row = map.get(key) || { date: key, units: 0, revenue: 0, fees: 0 };
  const quantity = number(item.quantity);
  row.units += quantity;
  row.revenue += number(item.selling_price) * quantity;
  row.fees += number(item.total_fees) * quantity;
  map.set(key, row);
}

function offerStock(offer) {
  const regions = { JHB: {}, CPT: {}, DBN: {} };
  let available = 0;
  let onWay = 0;
  let receiving = 0;
  let sold30 = 0;
  for (const row of offer.takealot_warehouse_stock || []) {
    const region = String(row.region || "").toUpperCase();
    const normalized = {
      available: number(row.quantity_available),
      onWay: number(row.stock_on_way),
      receiving: number(row.stock_in_receiving),
      coverDays: number(row.stock_30_days_cover),
      sold30: number(row.quantity_sold_30_days),
    };
    if (regions[region]) regions[region] = normalized;
    available += normalized.available;
    onWay += normalized.onWay;
    receiving += normalized.receiving;
    sold30 += normalized.sold30;
  }
  const sellerStock = (offer.seller_warehouse_stock || []).reduce(
    (sum, row) => sum + number(row.quantity_available), 0,
  );
  const total = available + onWay + receiving + sellerStock;
  return {
    regions, available, onWay, receiving, sellerStock, total, sold30,
    coverDays: sold30 > 0 ? (available / sold30) * 30 : null,
  };
}

function offerCharges(offer) {
  const rows = offer.offer_charges || [];
  const charge = rows.find((row) => row.order_type === "in_stock") || rows[0] || {};
  const successFee = number(charge.estimated_success_fee);
  const fulfilmentFee = number(charge.estimated_fulfilment_fee);
  const commissionVat = successFee * VAT_RATE;
  const fulfilmentVat = fulfilmentFee * VAT_RATE;
  const platformCost = successFee + fulfilmentFee + commissionVat + fulfilmentVat;
  return {
    successFee, fulfilmentFee, commissionVat, fulfilmentVat, platformCost,
    contribution: number(offer.selling_price) - platformCost,
  };
}

function buildDashboard({ offers = [], sales = [], returns = [], fetchedAt = new Date().toISOString() }) {
  const validSales = sales.filter(isCountedSale);
  const today = sastDate(0);
  const start30 = sastDate(29);
  const start7 = sastDate(6);
  const previousStart = sastDate(59);
  const previousEnd = sastDate(30);
  const salesByOffer = new Map();
  const daily = new Map();

  for (const sale of validSales) {
    const key = String(sale.offer_id || "");
    const row = salesByOffer.get(key) || { units30: 0, units7: 0, revenue30: 0, fees30: 0, previousUnits30: 0 };
    const date = dateKey(sale.order_date);
    const quantity = number(sale.quantity);
    if (date >= start30 && date <= today) {
      row.units30 += quantity;
      row.revenue30 += number(sale.selling_price) * quantity;
      row.fees30 += number(sale.total_fees) * quantity;
      if (date >= start7) row.units7 += quantity;
      addDays(daily, sale);
    } else if (date >= previousStart && date <= previousEnd) {
      row.previousUnits30 += quantity;
    }
    salesByOffer.set(key, row);
  }

  const returnsByOffer = new Map();
  for (const item of returns) {
    const date = String(item.return_date || "").slice(0, 10);
    if (date < start30 || date > today) continue;
    const key = String(item.offer_id || "");
    const row = returnsByOffer.get(key) || { quantity: 0, reasons: {} };
    row.quantity += number(item.quantity);
    const reason = String(item.return_reason || "未标明");
    row.reasons[reason] = (row.reasons[reason] || 0) + number(item.quantity);
    returnsByOffer.set(key, row);
  }

  const products = offers.map((offer) => {
    const key = String(offer.offer_id || "");
    const sale = salesByOffer.get(key) || { units30: 0, units7: 0, revenue30: 0, fees30: 0, previousUnits30: 0 };
    const returned = returnsByOffer.get(key) || { quantity: 0, reasons: {} };
    const stock = offerStock(offer);
    const charges = offerCharges(offer);
    const returnRate = sale.units30 > 0 ? returned.quantity / sale.units30 : 0;
    const alerts = [];
    if (offer.status !== "buyable") alerts.push("不可售");
    if (stock.available === 0) alerts.push("库存为0");
    else if (stock.coverDays !== null && stock.coverDays < 14) alerts.push("库存不足14天");
    if (number(offer.conversion_percentage_30_days) < number(offer.conversion_percentage_previous_30_days)) alerts.push("转化下降");
    if (number(offer.listing_quality) > 0 && number(offer.listing_quality) < 80) alerts.push("Listing质量低");
    if (returnRate >= 0.05) alerts.push("退货率偏高");
    if (number(offer.benchmark_price) > 0 && number(offer.selling_price) > number(offer.benchmark_price)) alerts.push("高于基准价");
    const blocks = (offer.replenishment_blocks || []).map((row) => ({
      region: row.region,
      blocked: Boolean(row.is_replen_blocked),
      maxQuantity: number(row.replen_block_max_qty),
      reason: row.replen_block_reason || "",
    }));
    return {
      offerId: offer.offer_id,
      tsinId: offer.tsin_id,
      sku: offer.sku || "",
      barcode: offer.barcode || "",
      title: offer.title || "",
      imageUrl: offer.image_url || "",
      status: offer.status || "",
      price: number(offer.selling_price),
      rrp: number(offer.rrp),
      benchmarkPrice: number(offer.benchmark_price),
      discountPercentage: number(offer.discount_percentage),
      pageViews30: number(offer.page_views_30_days),
      conversion30: number(offer.conversion_percentage_30_days),
      previousConversion30: number(offer.conversion_percentage_previous_30_days),
      wishlist30: number(offer.wishlist_30_days),
      totalWishlist: number(offer.total_wishlist),
      listingQuality: number(offer.listing_quality),
      quantityReturnedApi30: number(offer.quantity_returned_30_days),
      returnQuantity30: returned.quantity,
      returnRate30: returnRate,
      returnReasons: returned.reasons,
      units7: sale.units7,
      units30: sale.units30,
      previousUnits30: sale.previousUnits30,
      salesGrowth30: sale.previousUnits30 > 0 ? (sale.units30 - sale.previousUnits30) / sale.previousUnits30 : null,
      revenue30: sale.revenue30,
      actualFees30: sale.fees30,
      stock,
      charges,
      replenishmentBlocks: blocks,
      alerts,
      dimensions: {
        widthCm: number(offer.width_cm), lengthCm: number(offer.length_cm),
        heightCm: number(offer.height_cm), weightGrams: number(offer.weight_grams),
      },
    };
  }).sort((a, b) => b.revenue30 - a.revenue30 || b.units30 - a.units30);

  const summary = products.reduce((result, item) => {
    result.offerCount += 1;
    result.buyableOffers += item.status === "buyable" ? 1 : 0;
    result.units30 += item.units30;
    result.revenue30 += item.revenue30;
    result.actualFees30 += item.actualFees30;
    result.returnQuantity30 += item.returnQuantity30;
    result.availableStock += item.stock.available;
    result.onWayStock += item.stock.onWay + item.stock.receiving;
    result.lowStockOffers += item.alerts.includes("库存为0") || item.alerts.includes("库存不足14天") ? 1 : 0;
    return result;
  }, { offerCount: 0, buyableOffers: 0, units30: 0, revenue30: 0, actualFees30: 0, returnQuantity30: 0, availableStock: 0, onWayStock: 0, lowStockOffers: 0 });
  summary.returnRate30 = summary.units30 > 0 ? summary.returnQuantity30 / summary.units30 : 0;
  summary.platformReceivable30 = summary.revenue30 - summary.actualFees30;

  const trend = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const key = sastDate(offset);
    trend.push(daily.get(key) || { date: key, units: 0, revenue: 0, fees: 0 });
  }

  return {
    summary, products, trend,
    meta: {
      fetchedAt, timezone: "Africa/Johannesburg", vatRate: VAT_RATE,
      source: "Takealot Marketplace API v1",
      dateRange: { current: [start30, today], previous: [previousStart, previousEnd] },
      caveat: "平台贡献毛利未扣采购、头程、广告和税费，不等于净利润。",
    },
  };
}

async function apiRequest(path, search = {}) {
  if (!config.takealotApiKey) {
    const error = new Error("未配置 TAKEALOT_API_KEY，无法读取南非看板数据。");
    error.statusCode = 503;
    throw error;
  }
  const url = new URL(`${config.takealotApiBaseUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`);
  for (const [key, value] of Object.entries(search)) {
    for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
  }
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "GET",
      agent: apiAgent,
      headers: {
        "X-API-Key": config.takealotApiKey,
        Accept: "application/json",
        "User-Agent": API_USER_AGENT,
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(`Takealot API ${path} 请求失败：${response.statusCode}`);
          error.statusCode = response.statusCode === 403 ? 502 : response.statusCode;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (_error) {
          const error = new Error(`Takealot API ${path} 返回了无法解析的数据。`);
          error.statusCode = 502;
          reject(error);
        }
      });
    });
    request.setTimeout(45_000, () => request.destroy(new Error(`Takealot API ${path} 请求超时。`)));
    request.on("error", reject);
    request.end();
  });
}

async function listAll(path, params, limit = 100) {
  const items = [];
  let token = "";
  do {
    const payload = await apiRequest(path, { ...params, limit, ...(token ? { continuation_token: token } : {}) });
    items.push(...(payload.items || []));
    token = payload.continuation_token || "";
  } while (token);
  return items;
}

async function fetchDashboard() {
  const fields = ["offer_id", "tsin_id", "sku", "barcode", "selling_price", "rrp", "status", "title", "discount_percentage", "conversion_percentage_30_days", "conversion_percentage_previous_30_days", "page_views_30_days", "quantity_returned_30_days", "image_url", "width_cm", "length_cm", "height_cm", "weight_grams", "benchmark_price", "total_wishlist", "wishlist_30_days", "listing_quality"];
  const salesFields = ["order_item_id", "order_id", "order_date", "sale_status", "offer_id", "sku", "selling_price", "quantity", "success_fee", "fulfillment_fee", "courier_collection_fee", "total_fees", "stock_transfer_fee", "sales_region", "stock_source_region"];
  const returnFields = ["offer_id", "order_id", "quantity", "return_region", "return_date", "return_reason", "sku"];
  const [offers, sales, returns] = await Promise.all([
    listAll("offers", { fields, expands: ["seller_warehouse_stock", "offer_charges", "takealot_warehouse_stock", "replenishment_blocks"] }, 1000),
    listAll("sales", { order_date__gte: sastDate(59), order_date__lte: sastDate(0), fields: salesFields }, 100),
    listAll("returns", { return_date__gte: sastDate(29), return_date__lte: sastDate(0), fields: returnFields }, 100),
  ]);
  return buildDashboard({ offers, sales, returns, fetchedAt: new Date().toISOString() });
}

async function dashboard({ refresh = false } = {}) {
  if (!refresh && cache.payload && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.payload;
  if (cache.promise) return cache.promise;
  cache.promise = fetchDashboard()
    .then((payload) => {
      cache.payload = payload;
      cache.fetchedAt = Date.now();
      return payload;
    })
    .finally(() => { cache.promise = null; });
  return cache.promise;
}

module.exports = { VAT_RATE, buildDashboard, dashboard, _private: { offerStock, offerCharges, isCountedSale } };
