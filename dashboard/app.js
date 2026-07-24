const API_BASE = "";
const columnsKey = "ozon-dashboard-visible-columns";
const dashboardCacheKeyPrefix = "ozon-dashboard-cache-v2";
const showHiddenKey = "ozon-dashboard-show-hidden";

function formatDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function defaultMetricDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return formatDateKey(date);
}

function dashboardUrl() {
  const params = new URLSearchParams({ date: state.metricDate });
  if (state.showHidden) params.set("show_hidden", "1");
  return `${API_BASE}/api/dashboard?${params.toString()}`;
}

function dashboardCacheKey() {
  return `${dashboardCacheKeyPrefix}:${state.metricDate}:${state.showHidden ? "with-hidden" : "visible"}`;
}

const state = {
  products: [],
  summary: {},
  selectedOfferId: "",
  metrics: [],
  storeMetrics: [],
  metricDate: defaultMetricDate(),
  search: "",
  salesSort: "desc",
  timers: new Map(),
  saveQueues: new Map(),
  versions: new Map(),
  statuses: new Map(),
  visibleColumns: new Set(),
  rubToCny: 9.07 / 100
};

const editableFields = [
  "commission_rate",
  "purchase_cost",
  "weight",
  "freight_rate",
  "tail_delivery_rate",
  "return_rate",
  "price",
  "ad_ratio",
  "competitor_compare",
  "strategy",
  "image_url",
  "operator_name"
];

const columns = [
  { key: "product", label: "商品", fixed: true },
  { key: "actions", label: "操作" },
  { key: "ozon_sku", label: "Ozon SKU" },
  { key: "image_url", label: "图片" },
  { key: "fbo_stock", label: "FBO库存数" },
  { key: "fbs_stock", label: "FBS库存数" },
  { key: "yesterday_sales", label: "销量" },
  { key: "selected_revenue", label: "销售额" },
  { key: "commission_rate", label: "佣金率", type: "number" },
  { key: "purchase_cost", label: "采购成本", type: "number" },
  { key: "weight", label: "重量", type: "number" },
  { key: "freight_rate", label: "运费系数", type: "number" },
  { key: "tail_delivery_rate", label: "尾程派送系数（%）", type: "number" },
  { key: "return_rate", label: "退货率", type: "number" },
  { key: "price", label: "售价", type: "number" },
  { key: "ad_ratio", label: "广告比例", type: "number" },
  { key: "expected_profit", label: "预期利润" },
  { key: "competitor_compare", label: "竞品对比" },
  { key: "strategy", label: "产品策略" },
  { key: "status", label: "状态" }
];

const fieldLabels = Object.fromEntries(columns.map((column) => [column.key, column.label]));

function $(id) {
  return document.getElementById(id);
}


function buildSalesTicks(maxValue) {
  const max = Math.max(1, Math.ceil(Number(maxValue) || 0));
  if (max <= 6) return Array.from({ length: max + 1 }, (_, index) => index);

  const targetTickCount = 6;
  const rawStep = max / targetTickCount;
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const normalized = rawStep / magnitude;
  const stepMultiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = stepMultiplier * magnitude;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return ticks;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function statusKey(offerId, field) {
  return `${offerId}:${field}`;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function setSyncText(text) {
  $("syncText").textContent = text;
}

async function loadExchangeRate() {
  try {
    const res = await fetch(`${API_BASE}/api/exchange-rate`);
    if (!res.ok) return;
    const payload = await res.json();
    const rate = Number(payload?.data?.rubToCny);
    if (Number.isFinite(rate) && rate > 0.01 && rate < 0.2) {
      state.rubToCny = rate;
      window.ozonRubToCny = rate;
    }
  } catch {}
}

function formatValue(value) {
  return value === null || value === undefined ? "" : String(value);
}

function formatMoney(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " ₽" : "0 ₽";
}

function bumpVersion(offerId, field) {
  const key = statusKey(offerId, field);
  const next = (state.versions.get(key) || 0) + 1;
  state.versions.set(key, next);
  return next;
}

function getProduct(offerId) {
  return state.products.find((product) => product.offer_id === offerId);
}

function setStatus(offerId, field, status, text) {
  const key = statusKey(offerId, field);
  state.statuses.set(key, { status, text });
  const element = document.querySelector(`[data-status="${CSS.escape(key)}"]`);
  if (element) {
    element.className = `status ${status}`;
    element.textContent = text;
  }
}

function loadVisibleColumns() {
  const fallback = columns.map((column) => column.key);
  try {
    const saved = JSON.parse(localStorage.getItem(columnsKey) || "null");
    const valid = Array.isArray(saved) ? saved.filter((key) => columns.some((column) => column.key === key)) : fallback;
    state.visibleColumns = new Set(valid.length ? valid : fallback);
  } catch {
    state.visibleColumns = new Set(fallback);
  }
  for (const column of columns.filter((item) => item.fixed)) state.visibleColumns.add(column.key);
  state.visibleColumns.add("tail_delivery_rate");
}

function saveVisibleColumns() {
  localStorage.setItem(columnsKey, JSON.stringify(Array.from(state.visibleColumns)));
}

function visibleColumns() {
  return columns.filter((column) => state.visibleColumns.has(column.key));
}

async function reloadDashboard() {
  await loadExchangeRate();
  await loadDashboard();
}

async function loadDashboard() {
  setSyncText("正在加载数据...");
  renderCachedDashboard();
  if ($("metricDateInput")) $("metricDateInput").value = state.metricDate;
  const response = await fetch(dashboardUrl());
  if (!response.ok) throw new Error(`加载失败：${response.status}`);
  const payload = await response.json();
  localStorage.setItem(dashboardCacheKey(), JSON.stringify(payload));
  state.products = payload.data.products || [];
  state.summary = payload.data.summary || {};
  state.metricDate = state.summary.selectedDate || state.metricDate;
  if ($("metricDateInput")) $("metricDateInput").value = state.metricDate;
  loadStoreMetrics().catch(() => {});
  const selectedStillExists = state.products.some(
    (product) => product.offer_id === state.selectedOfferId
  );
  if (!selectedStillExists) {
    state.selectedOfferId = state.products[0]?.offer_id || "";
  }
  if (state.selectedOfferId) {
    loadMetrics(state.selectedOfferId).catch((error) => showToast(error.message));
  } else {
    state.metrics = [];
  }
  render();
  setSyncText(`已加载 ${state.products.length} 个商品，更新时间 ${new Date(payload.data.fetchedAt).toLocaleString()}`);
}

function renderCachedDashboard() {
  if (state.products.length) return;
  try {
    const payload = JSON.parse(localStorage.getItem(dashboardCacheKey()) || "null");
    if (!payload?.data?.products?.length) return;
    state.products = payload.data.products || [];
    state.summary = payload.data.summary || {};
    if (!state.selectedOfferId && state.products[0]) state.selectedOfferId = state.products[0].offer_id;
    render();
    setSyncText(`先显示缓存数据 ${state.products.length} 个商品，正在后台刷新...`);
  } catch {
    localStorage.removeItem(dashboardCacheKey());
  }
}

async function loadMetrics(offerId) {
  if (!offerId) return;
  $("trendTitle").textContent = `${offerId} - 近 30 天销量和广告比例变化`;
  const response = await fetch(`${API_BASE}/api/metrics/${encodeURIComponent(offerId)}?days=30`);
  if (!response.ok) {
    state.metrics = [];
    renderTrend();
    throw new Error(`动态数据加载失败：${response.status}`);
  }
  const payload = await response.json();
  state.metrics = payload.data || [];
  renderTrend();
}

async function loadStoreMetrics() {
  const response = await fetch(`${API_BASE}/api/store-metrics?days=30`);
  if (!response.ok) throw new Error(`店铺销售额动态加载失败：${response.status}`);
  const payload = await response.json();
  state.storeMetrics = payload.data || [];
  renderRevenueTrend();
}

function renderColumnControls() {
  $("columnControls").innerHTML = columns
    .filter((column) => !column.fixed)
    .map((column) => `
      <label>
        <input type="checkbox" data-column-toggle="${column.key}" ${state.visibleColumns.has(column.key) ? "checked" : ""} />
        ${column.label}
      </label>
    `)
    .join("");
}

function renderStats() {
  const summary = state.summary;
  const items = [
    ["商品数", summary.productCount || 0],
    ["总销量", summary.totalSales || 0],
    ["总销售额", formatMoney(summary.totalRevenue || 0)],
    ["日期", summary.selectedDate || state.metricDate],
    ["缺图片", summary.missingImageCount || 0],
    ["缺竞品", summary.missingCompetitorCount || 0]
  ];
  $("stats").innerHTML = items
    .map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function productMatches(product) {
  const term = state.search.trim().toLowerCase();
  if (!term) return true;
  return [product.offer_id, product.product_id, product.title, product.strategy, product.competitor_compare]
    .some((value) => String(value || "").toLowerCase().includes(term));
}

function sortedProducts() {
  const list = state.products.filter(productMatches);
  if (state.salesSort === "none") return list;
  return [...list].sort((a, b) => {
    const left = toNumber(a.yesterday_sales);
    const right = toNumber(b.yesterday_sales);
    return state.salesSort === "asc" ? left - right : right - left;
  });
}

function renderInput(product, field, type = "text") {
  const value = formatValue(product[field]);
  const key = statusKey(product.offer_id, field);
  const status = state.statuses.get(key) || { status: "", text: "" };

  if (field === "competitor_compare" || field === "strategy") {
    const textClass = field === "competitor_compare" ? "editable-text editable-div competitor-text" : "editable-text editable-div";
    const seerfarButton = field === "competitor_compare" ? `<button class="seerfar-link-btn" type="button" data-seerfar-offer="${escapeHtml(product.offer_id)}">Seerfar</button>` : "";
    return `
      <div class="${textClass}" contenteditable="true" role="textbox" data-offer="${escapeHtml(product.offer_id)}" data-field="${field}">${escapeHtml(value)}</div>
      ${seerfarButton}
      <div class="status ${status.status}" data-status="${escapeHtml(key)}">${escapeHtml(status.text)}</div>
    `;
  }

  return `
    <input class="editable" type="${type}" value="${escapeHtml(value)}" data-offer="${escapeHtml(product.offer_id)}" data-field="${field}" />
    <div class="status ${status.status}" data-status="${escapeHtml(key)}">${escapeHtml(status.text)}</div>
  `;
}

function expectedProfit(product) {
  const priceRub = toNumber(product.price);
  if (!priceRub) return "";

  const rubToCny = state.rubToCny || window.ozonRubToCny || 9.07 / 100;
  const kgToCny = 7.2;
  const purchaseCny = toNumber(product.purchase_cost);
  const weightKg = toNumber(product.weight) / 1000;
  const freightRate = toNumber(product.freight_rate);

  const commissionRub = priceRub * toNumber(product.commission_rate) / 100;
  const adRub = priceRub * toNumber(product.ad_ratio) / 100;
  const returnRub = priceRub * toNumber(product.return_rate) / 100;
  const hasTailDeliveryRate = product.tail_delivery_rate !== null
    && product.tail_delivery_rate !== undefined
    && product.tail_delivery_rate !== "";
  const tailDeliveryRate = hasTailDeliveryRate
    ? toNumber(product.tail_delivery_rate)
    : 10;
  const tailDeliveryRub = priceRub * tailDeliveryRate / 100;
  const taxRub = priceRub * 0.12;
  const acquiringRub = priceRub * 0.03;
  const remainingRub = priceRub - commissionRub - adRub - returnRub - tailDeliveryRub - taxRub - acquiringRub;
  const remittanceLossRub = remainingRub * 0.06;

  const incomeCny = priceRub * rubToCny;
  const platformCostCny = (commissionRub + adRub + returnRub + tailDeliveryRub + taxRub + acquiringRub + remittanceLossRub) * rubToCny;
  const firstMileCny = weightKg * freightRate * kgToCny;
  const profitCny = incomeCny - platformCostCny - firstMileCny - purchaseCny;
  return profitCny.toFixed(2);
}

function renderImage(product) {
  const image = product.image_url;
  return `
    ${image ? `<img class="image-preview" src="${escapeHtml(image)}" alt="${escapeHtml(product.offer_id)}" loading="lazy" decoding="async" />` : `<div class="image-empty">无图片</div>`}
    ${renderInput(product, "image_url")}
  `;
}

function renderActions(product) {
  const hidden = Boolean(product.hidden);
  return `
    <button
      class="hide-product-btn ${hidden ? "restore" : ""}"
      type="button"
      data-hide-offer="${escapeHtml(product.offer_id)}"
      data-hidden-next="${hidden ? "0" : "1"}"
      title="${hidden ? "恢复这个商品到Ozon看板" : "从Ozon看板隐藏这个商品"}"
    >${hidden ? "恢复" : "隐藏"}</button>
  `;
}

function renderCell(product, column) {
  if (column.key === "product") {
    return `
      <td class="product-cell">
        <strong>${escapeHtml(product.offer_id)}</strong>
        <span>${escapeHtml(product.product_id)}</span>
      </td>
    `;
  }
  if (column.key === "actions") return `<td class="actions-cell">${renderActions(product)}</td>`;
  if (column.key === "image_url") return `<td class="image-cell">${renderImage(product)}</td>`;
  if (column.key === "selected_revenue") return `<td>${escapeHtml(formatMoney(product.selected_revenue || 0))}</td>`;
  if (column.key === "expected_profit") return `<td class="profit-cell">${escapeHtml(expectedProfit(product))}</td>`;
  if (column.key === "status") return `<td>${renderInput(product, "operator_name", "text")}</td>`;
  if (editableFields.includes(column.key)) return `<td>${renderInput(product, column.key, column.type || "text")}</td>`;
  return `<td>${escapeHtml(formatValue(product[column.key]))}</td>`;
}

function renderTable() {
  const activeColumns = visibleColumns();
  $("tableHead").innerHTML = `<tr>${activeColumns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`;
  const rows = sortedProducts().map((product) => `
    <tr class="${[product.offer_id === state.selectedOfferId ? "selected-row" : "", product.hidden ? "hidden-product-row" : ""].filter(Boolean).join(" ")}" data-row-offer="${escapeHtml(product.offer_id)}">
      ${activeColumns.map((column) => renderCell(product, column)).join("")}
    </tr>
  `);
  $("productBody").innerHTML = rows.join("") || `<tr><td colspan="${activeColumns.length}">没有匹配商品</td></tr>`;
}

function render() {
  renderColumnControls();
  renderStats();
  renderTable();
  renderTrend();
  renderRevenueTrend();
}

function updateProfitCell(offerId) {
  const row = document.querySelector(`[data-row-offer="${CSS.escape(String(offerId))}"]`);
  const product = getProduct(offerId);
  if (!row || !product) return;
  const cell = row.querySelector(".profit-cell");
  if (cell) cell.textContent = expectedProfit(product);
}

function normalizePatchValue(field, value) {
  if (field === "competitor_compare" || field === "image_url" || field === "strategy" || field === "operator_name") return value;
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function renderRevenueTrend() {
  const chart = $("storeRevenueChart");
  if (!chart) return;
  if (!state.storeMetrics.length) {
    chart.innerHTML = `<div class="trend-empty">暂无销售额数据</div>`;
    return;
  }

  const width = 760;
  const height = 250;
  const padding = { left: 58, right: 24, top: 18, bottom: 34 };
  const points = state.storeMetrics.map((item, index) => ({
    index,
    date: String(item.metric_date || "").slice(0, 10),
    revenue: Number(item.revenue || 0)
  }));
  const maxRevenue = Math.max(1, ...points.map((point) => point.revenue));
  const x = (index) => padding.left + (points.length === 1 ? 0 : (index * (width - padding.left - padding.right)) / (points.length - 1));
  const y = (value) => height - padding.bottom - (value / maxRevenue) * (height - padding.top - padding.bottom);
  const ticks = [0, Math.ceil(maxRevenue / 2), Math.ceil(maxRevenue)];
  const dateTicks = points.map((point, index) => ({ point, index }));
  const yGrid = ticks.map((tick) => `
    <line class="grid-line" x1="${padding.left}" y1="${y(tick)}" x2="${width - padding.right}" y2="${y(tick)}"></line>
    <text class="axis-label" x="${padding.left - 8}" y="${y(tick) + 4}" text-anchor="end">${Math.round(tick)}</text>
  `).join("");
  const xLabels = dateTicks.map(({ point, index }) => {
    const date = String(point.date || "");
    const day = date.slice(8, 10).replace(/^0/, "");
    const previousMonth = index > 0 ? String(points[index - 1].date || "").slice(5, 7) : "";
    const month = date.slice(5, 7);
    const isBoundary = index === 0 || index === points.length - 1 || month !== previousMonth;
    const label = isBoundary ? date.slice(5, 10).replace(/^0/, "").replace("-0", "-") : day;
    return `<text class="axis-label trend-date-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${label}</text>`;
  }).join("");
  const revenuePath = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${y(point.revenue).toFixed(2)}`).join(" ");
  const totalRevenue = points.reduce((sum, point) => sum + point.revenue, 0);

  chart.innerHTML = `
    <div class="chart-title">近 30 天店铺销售额</div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近 30 天店铺销售额">
      ${yGrid}
      <line class="axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
      <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
      <path class="revenue-line" d="${revenuePath}"></path>
      ${xLabels}
    </svg>
    <div class="trend-summary">
      <span>30 天销售额：${formatMoney(totalRevenue)}</span>
      <span>最新日销售额：${formatMoney(points[points.length - 1].revenue)}</span>
    </div>
  `;
}

function renderTrend() {
  const chart = $("trendChart");
  if (!chart) return;
  if (!state.metrics.length) {
    chart.innerHTML = `<div class="trend-empty">暂无动态数据</div>`;
    return;
  }

  const width = 760;
  const height = 260;
  const padding = { left: 42, right: 36, top: 16, bottom: 44 };
  const points = state.metrics.map((item, index) => ({
    index,
    date: String(item.metric_date || "").slice(0, 10),
    sales: Number(item.sales_units || 0),
    ad: Number(item.ad_ratio || 0)
  }));
  const maxSales = Math.max(1, ...points.map((point) => point.sales));
  const maxAd = Math.max(1, ...points.map((point) => point.ad));
  const x = (index) => padding.left + (points.length === 1 ? 0 : (index * (width - padding.left - padding.right)) / (points.length - 1));
  const ySales = (value) => height - padding.bottom - (value / maxSales) * (height - padding.top - padding.bottom);
  const yAd = (value) => height - padding.bottom - (value / maxAd) * (height - padding.top - padding.bottom);
  const salesTicks = buildSalesTicks(maxSales);
  const adTicks = [0, Math.ceil(maxAd / 2), Math.ceil(maxAd)];
  const dateTicks = points.map((point, index) => ({ point, index }));
  const yGrid = salesTicks.map((tick) => `
    <line class="grid-line" x1="${padding.left}" y1="${ySales(tick)}" x2="${width - padding.right}" y2="${ySales(tick)}"></line>
    <text class="axis-label" x="${padding.left - 8}" y="${ySales(tick) + 4}" text-anchor="end">${tick}</text>
  `).join("");
  const adLabels = adTicks.map((tick) => `
    <text class="axis-label ad-axis-label" x="${width - padding.right + 8}" y="${yAd(tick) + 4}">${tick}%</text>
  `).join("");
  const xLabels = dateTicks.map(({ point, index }) => {
    const date = String(point.date || "");
    const day = date.slice(8, 10).replace(/^0/, "");
    const previousMonth = index > 0 ? String(points[index - 1].date || "").slice(5, 7) : "";
    const month = date.slice(5, 7);
    const isBoundary = index === 0 || index === points.length - 1 || month !== previousMonth;
    const label = isBoundary ? date.slice(5, 10).replace(/^0/, "").replace("-0", "-") : day;
    return `<text class="axis-label trend-date-label" x="${x(index)}" y="${height - 13}" text-anchor="middle">${label}</text>`;
  }).join("");
  const salesPath = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${ySales(point.sales).toFixed(2)}`).join(" ");
  const adPath = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${yAd(point.ad).toFixed(2)}`).join(" ");
  const bars = points.map((point, index) => {
    const barHeight = height - padding.bottom - ySales(point.sales);
    return `<rect x="${x(index) - 4}" y="${ySales(point.sales)}" width="8" height="${barHeight}" rx="2"></rect>`;
  }).join("");

  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近 30 天销量和广告比例">
      ${yGrid}
      ${adLabels}
      <line class="axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
      <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
      <g class="sales-bars">${bars}</g>
      <path class="sales-line" d="${salesPath}"></path>
      <path class="ad-line" d="${adPath}"></path>
      ${xLabels}
    </svg>
    <div class="trend-summary">
      <span>30 天销量：${points.reduce((sum, point) => sum + point.sales, 0)}</span>
      <span>最新广告比例：${points[points.length - 1].ad || 0}%</span>
    </div>
  `;
}

async function saveField(offerId, field, value, version) {
  setStatus(offerId, field, "saving", "保存中");
  const response = await fetch(`${API_BASE}/api/products/${encodeURIComponent(offerId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [field]: normalizePatchValue(field, value) })
  });
  if (!response.ok) throw new Error(`保存失败：${response.status}`);
  const payload = await response.json();
  if (state.versions.get(statusKey(offerId, field)) !== version) return;
  const product = getProduct(offerId);
  if (product && payload.data) {
    product[field] = payload.data[field] ?? normalizePatchValue(field, value);
  }
  setStatus(offerId, field, "saved", "已保存");
  if (field === "strategy" && window.__strategyHistoryCache) window.__strategyHistoryCache.delete(offerId);
  if (field === "image_url") render();
  if (["price", "purchase_cost", "commission_rate", "ad_ratio", "return_rate", "freight_rate", "tail_delivery_rate", "weight"].includes(field)) updateProfitCell(offerId);
}

function enqueueSave(offerId, task) {
  const previous = state.saveQueues.get(offerId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  state.saveQueues.set(offerId, current);
  current.finally(() => {
    if (state.saveQueues.get(offerId) === current) state.saveQueues.delete(offerId);
  });
  return current;
}

function scheduleSave(offerId, field, value) {
  const key = statusKey(offerId, field);
  const version = bumpVersion(offerId, field);
  clearTimeout(state.timers.get(key));
  state.timers.set(
    key,
    setTimeout(() => {
      enqueueSave(offerId, async () => {
      try {
        await saveField(offerId, field, value, version);
      } catch (error) {
        if (state.versions.get(key) === version) {
          setStatus(offerId, field, "error", "保存失败");
          showToast(`${fieldLabels[field] || field} 保存失败：${error.message}`);
        }
      }
      });
    }, 1100)
  );
}

function handleEdit(event) {
  const target = event.target;
  if (!target.matches("[data-offer][data-field]")) return;
  const offerId = target.dataset.offer;
  const field = target.dataset.field;
  const product = getProduct(offerId);
  if (!product || !editableFields.includes(field)) return;
  const value = target.isContentEditable ? target.textContent : target.value;
  product[field] = value;
  if (["price", "purchase_cost", "commission_rate", "ad_ratio", "return_rate", "freight_rate", "tail_delivery_rate", "weight"].includes(field)) updateProfitCell(offerId);
  setStatus(offerId, field, "saving", "待保存");
  scheduleSave(offerId, field, value);
}



function inferCompetitorSku(product) {
  const text = [product.competitor_compare, product.strategy].map(value => String(value || "")).join(" ");
  const match = text.match(/\b\d{6,}\b/);
  return match ? match[0] : "";
}

function renderSeerfarInsights(data) {
  const competitors = data.competitors || [];
  const lines = [];
  if (competitors[0]) {
    const c = competitors[0];
    lines.push(`Main competitor: ${c.sku}${c.title ? " / " + c.title : ""}`);
    if (c.price) lines.push(`Competitor price: ${formatMoney(c.price)}`);
    if (c.sales_30d) lines.push(`30d sales: ${c.sales_30d}`);
    if (c.revenue_30d) lines.push(`30d revenue: ${formatMoney(c.revenue_30d)}`);
    if (c.exposure || c.card_views) lines.push(`Exposure / views: ${c.exposure || 0} / ${c.card_views || 0}`);
  }
  for (const item of data.diagnosis || []) lines.push(`- ${item}`);
  return lines.join("\n") || "Seerfar competitor mapping saved.";
}

async function syncSeerfarCompetitor(offerId) {
  const product = getProduct(offerId);
  if (!product) return;
  const defaultSku = inferCompetitorSku(product);
  const sku = window.prompt("Enter Seerfar competitor SKU", defaultSku || product.ozon_sku || "");
  if (!sku) return;

  showToast("Saving Seerfar competitor mapping...");
  const response = await fetch(`${API_BASE}/api/seerfar/competitors/sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer_id: offerId, sku: sku.trim(), platform: "OZON", dateRange: "past_30_days" })
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || `Seerfar save failed: ${response.status}`);
  showToast(payload.data?.message || "Seerfar competitor mapping saved");
  window.alert(renderSeerfarInsights(payload.data?.insights || {}));
}

async function setProductHidden(offerId, hidden) {
  const response = await fetch(`${API_BASE}/api/products/${encodeURIComponent(offerId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hidden })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `保存失败：${response.status}`);

  const product = getProduct(offerId);
  if (product) product.hidden = Boolean(hidden);
  if (hidden && !state.showHidden) {
    state.products = state.products.filter((item) => item.offer_id !== offerId);
    if (state.selectedOfferId === offerId) {
      state.selectedOfferId = state.products[0]?.offer_id || "";
      if (state.selectedOfferId) loadMetrics(state.selectedOfferId).catch((error) => showToast(error.message));
    }
  }
  render();
  showToast(hidden ? "商品已隐藏" : "商品已恢复");
}

function initHiddenToggle() {
  const toggle = $("showHiddenInput");
  if (!toggle) return;
  toggle.checked = state.showHidden;
  toggle.addEventListener("change", (event) => {
    state.showHidden = event.target.checked;
    localStorage.setItem(showHiddenKey, state.showHidden ? "1" : "0");
    reloadDashboard().catch((error) => showToast(error.message));
  });
}

async function addProduct(event) {
  event.preventDefault();
  const offerId = $("newOfferId").value.trim();
  const productId = $("newProductId").value.trim();
  if (!offerId) return;
  const response = await fetch(`${API_BASE}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer_id: offerId, product_id: productId })
  });
  if (!response.ok) {
    showToast(`新增失败：${response.status}`);
    return;
  }
  $("addDialog").close();
  $("newOfferId").value = "";
  $("newProductId").value = "";
  await reloadDashboard();
}

loadVisibleColumns();
initHiddenToggle();
document.addEventListener("input", handleEdit);
document.addEventListener("change", (event) => {
  const key = event.target.dataset.columnToggle;
  if (!key) return;
  if (event.target.checked) state.visibleColumns.add(key);
  else state.visibleColumns.delete(key);
  saveVisibleColumns();
  renderTable();
});
document.addEventListener("click", (event) => {
  const hideTarget = event.target.closest("[data-hide-offer]");
  if (hideTarget) {
    event.preventDefault();
    event.stopPropagation();
    const hidden = hideTarget.dataset.hiddenNext === "1";
    setProductHidden(hideTarget.dataset.hideOffer, hidden).catch((error) => showToast(error.message));
    return;
  }

  const seerfarTarget = event.target.closest("[data-seerfar-offer]");
  if (seerfarTarget) {
    event.preventDefault();
    syncSeerfarCompetitor(seerfarTarget.dataset.seerfarOffer).catch((error) => showToast(error.message));
    return;
  }
  if (event.target.closest("[data-offer][data-field], input, textarea, [contenteditable='true'], button, select, label")) return;
  const row = event.target.closest("[data-row-offer]");
  if (!row) return;
  const offerId = row.dataset.rowOffer;
  if (!offerId || offerId === state.selectedOfferId) return;
  state.selectedOfferId = offerId;
  renderTable();
  loadMetrics(offerId).catch((error) => showToast(error.message));
});
$("refreshBtn").addEventListener("click", () => reloadDashboard().catch((error) => showToast(error.message)));
$("searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderTable();
});
$("salesSort").addEventListener("change", (event) => {
  state.salesSort = event.target.value;
  renderTable();
});
if ($("metricDateInput")) {
  $("metricDateInput").value = state.metricDate;
  $("metricDateInput").addEventListener("change", (event) => {
    state.metricDate = event.target.value || defaultMetricDate();
    reloadDashboard().catch((error) => showToast(error.message));
  });
}
$("addBtn").addEventListener("click", () => $("addDialog").showModal());
$("cancelAddBtn").addEventListener("click", () => $("addDialog").close());
$("addDialog").querySelector("form").addEventListener("submit", addProduct);

loadDashboard().catch((error) => {
  setSyncText("加载失败");
  showToast(error.message);
});


(function cleanOzonEnhancements() {
  document.addEventListener("click", function (event) {
    const wbCrossTab = event.target.closest("[data-market-tab='wb-cross']");
    if (wbCrossTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      location.href = "/wb-cross.html?v=20260605-ozon-wbcross-tab";
      return;
    }

    const tab = event.target.closest("[data-market-tab='wb']");
    if (!tab) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.href = "/wb.html?v=20260601-clean";
  }, true);

  const originalRenderTable = window.renderTable || renderTable;
  window.renderTable = renderTable = function cleanRenderTableWrapper() {
    originalRenderTable();
    const headers = Array.from(document.querySelectorAll("#tableHead th"));
    const competitorIndex = headers.findIndex(th => th.textContent.includes("竞品"));
    const strategyIndex = headers.findIndex(th => th.textContent.includes("产品策略"));

    if (competitorIndex >= 0) {
      headers[competitorIndex].classList.add("ozon-competitor-ratio");
      document.querySelectorAll("#productBody tr").forEach(row => {
        if (row.cells[competitorIndex]) row.cells[competitorIndex].classList.add("ozon-competitor-ratio");
      });
    }

    if (strategyIndex >= 0) {
      headers[strategyIndex].classList.add("ozon-strategy-ratio");
      document.querySelectorAll("#productBody tr").forEach(row => {
        if (row.cells[strategyIndex]) row.cells[strategyIndex].classList.add("ozon-strategy-ratio");
      });
    }
  };

  async function previous30(offerId) {
    const res = await fetch("/api/metrics/" + encodeURIComponent(offerId) + "?days=60");
    const payload = await res.json();
    if (!res.ok || !payload.ok) return null;
    const rows = (payload.data || [])
      .map(row => ({
        date: String(row.metric_date || "").slice(0, 10),
        sales: Number(row.sales_units || 0)
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return rows.slice(-60, -30).reduce((sum, row) => sum + row.sales, 0);
  }

  const originalLoadMetrics = window.loadMetrics || loadMetrics;
  window.loadMetrics = loadMetrics = async function cleanLoadMetrics(offerId) {
    await originalLoadMetrics(offerId);
    const chart = document.getElementById("trendChart");
    if (!chart) return;

    let footer = document.getElementById("ozonPrevious30Only");
    if (!footer) {
      footer = document.createElement("div");
      footer.id = "ozonPrevious30Only";
      footer.className = "trend-summary";
      chart.appendChild(footer);
    }

    footer.innerHTML = "<span>上个30天销量：加载中...</span>";
    const value = await previous30(offerId);
    footer.innerHTML = value === null ? "" : "<span>上个30天销量：" + value + "</span>";
  };
})();


(function installStrategyHistoryHover() {
  const cache = new Map();
  window.__strategyHistoryCache = cache;
  let tooltip = null;
  let activeKey = "";

  function getTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement("div");
    tooltip.className = "strategy-history-tooltip";
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    return tooltip;
  }

  function formatHistoryTime(value) {
    if (!value) return "";
    return new Date(value).toLocaleString();
  }

  function renderHistory(rows) {
    if (!rows.length) return '<div class="strategy-history-empty">No saved strategy history yet.</div>';
    return rows.map(row => `
      <div class="strategy-history-item">
        <div class="strategy-history-date">${escapeHtml(row.saved_date || String(row.saved_at || "").slice(0, 10))}</div>
        <div class="strategy-history-time">${escapeHtml(formatHistoryTime(row.saved_at))}</div>
        <div class="strategy-history-content">${escapeHtml(row.strategy || "(empty)")}</div>
      </div>
    `).join("");
  }

  function placeTooltip(target) {
    const tip = getTooltip();
    const rect = target.getBoundingClientRect();
    const width = Math.min(420, window.innerWidth - 24);
    tip.style.width = width + "px";
    const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.left));
    const below = rect.bottom + 8;
    const top = below + tip.offsetHeight < window.innerHeight
      ? below
      : Math.max(12, rect.top - tip.offsetHeight - 8);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  async function loadHistory(offerId) {
    if (cache.has(offerId)) return cache.get(offerId);
    const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(offerId)}/strategy-history?days=3`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "Strategy history load failed");
    cache.set(offerId, payload.data || []);
    return cache.get(offerId);
  }

  document.addEventListener("mouseover", async event => {
    const target = event.target.closest("[data-field='strategy'][data-offer]");
    if (!target) return;
    const offerId = target.dataset.offer;
    activeKey = offerId;
    const tip = getTooltip();
    tip.hidden = false;
    tip.innerHTML = '<div class="strategy-history-empty">Loading strategy history...</div>';
    placeTooltip(target);

    try {
      const rows = await loadHistory(offerId);
      if (activeKey !== offerId) return;
      tip.innerHTML = renderHistory(rows);
      placeTooltip(target);
    } catch (error) {
      if (activeKey !== offerId) return;
      tip.innerHTML = `<div class="strategy-history-empty">${escapeHtml(error.message)}</div>`;
      placeTooltip(target);
    }
  });

  document.addEventListener("mousemove", event => {
    const target = event.target.closest("[data-field='strategy'][data-offer]");
    if (!target || !tooltip || tooltip.hidden) return;
    placeTooltip(target);
  });

  document.addEventListener("mouseout", event => {
    const target = event.target.closest("[data-field='strategy'][data-offer]");
    if (!target) return;
    const related = event.relatedTarget;
    if (related && (target.contains(related) || getTooltip().contains(related))) return;
    activeKey = "";
    getTooltip().hidden = true;
  });

  const originalSaveField = window.saveField || saveField;
  window.saveField = saveField = async function strategyHistorySaveField(offerId, field, value, version) {
    await originalSaveField(offerId, field, value, version);
    if (field === "strategy") cache.delete(offerId);
  };
})();
