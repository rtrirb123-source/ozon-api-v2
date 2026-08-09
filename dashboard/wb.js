const API_BASE = "";
const state = {
  products: [],
  summary: {},
  metrics: [],
  storeMetrics: [],
  businessReport: null,
  businessMonth: "",
  businessMonths: [],
  businessPage: 1,
  businessPageSize: 20,
  ozonCostBySku: new Map(),
  usdToCny: 7.2,
  logisticsFactorUsdKg: 3,
  selectedNmId: "",
  search: "",
  salesSort: "desc",
  activeView: "products",
  metricDate: defaultMetricDate(),
  timers: new Map(),
  statuses: new Map(),
  rubToCny: 9.07 / 100,
  taxRate: 0.12,
  collectionRate: 0.03,
  exchangeRateUpdatedAt: ""
};


function formatDateKey(value) {
  return value ? String(value).slice(0, 10) : "";
}

function defaultMetricDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().slice(0, 10);
}

function formatMoney(value) {
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(toNumber(value)) + " ₽";
}

function formatCny(value) {
  if (value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) return "—";
  return "¥" + Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dashboardUrl() {
  const date = formatDateKey(state.metricDate || defaultMetricDate());
  return `${API_BASE}/api/wb/dashboard?date=${encodeURIComponent(date)}`;
}

async function loadStoreMetrics() {
  const res = await fetch(`${API_BASE}/api/wb/store-metrics?days=30`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "店铺销售额动态加载失败");
  state.storeMetrics = payload.data || [];
  renderRevenueTrend();
}

function monthOffset(month, offset) {
  const [year, monthNumber] = String(month).split("-").map(Number);
  if (!year || !monthNumber) return "";
  const date = new Date(Date.UTC(year, monthNumber - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function businessMonthLabel(month) {
  const [year, monthNumber] = String(month).split("-");
  return `${year}年${Number(monthNumber)}月`;
}

function availableBusinessMonths() {
  return new Set(state.businessMonths.map(item => item.month));
}

function renderBusinessMonthControls() {
  const select = $("wbBusinessMonthSelect");
  const previous = $("wbBusinessPrevMonth");
  const next = $("wbBusinessNextMonth");
  if (!select) return;
  const available = availableBusinessMonths();
  const sorted = [...available].sort();
  if (!sorted.length) {
    select.innerHTML = '<option>该月份尚未同步</option>';
    previous.disabled = true;
    next.disabled = true;
    return;
  }
  const current = new Date();
  const currentMonth = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, "0")}`;
  const endMonth = [sorted[sorted.length - 1], currentMonth].sort().pop();
  const months = [];
  for (let cursor = sorted[0]; cursor <= endMonth; cursor = monthOffset(cursor, 1)) months.push(cursor);
  select.innerHTML = months.map(month => `
    <option value="${month}" ${month === state.businessMonth ? "selected" : ""} ${available.has(month) ? "" : "disabled"}>
      ${businessMonthLabel(month)}${available.has(month) ? "" : "（尚未同步）"}
    </option>
  `).join("");
  const previousMonth = monthOffset(state.businessMonth, -1);
  const nextMonth = monthOffset(state.businessMonth, 1);
  previous.disabled = !available.has(previousMonth);
  next.disabled = !available.has(nextMonth);
  previous.title = previous.disabled ? "该月份尚未同步" : businessMonthLabel(previousMonth);
  next.title = next.disabled ? "该月份尚未同步" : businessMonthLabel(nextMonth);
}

async function loadBusinessMonthIndex() {
  try {
    const response = await fetch("./data/wb-business/index.json?v=" + Date.now(), { cache: "no-store" });
    if (!response.ok) throw new Error("月份索引加载失败");
    const payload = await response.json();
    state.businessMonths = Array.isArray(payload.months) ? payload.months : [];
    const available = availableBusinessMonths();
    if (!state.businessMonth || !available.has(state.businessMonth)) {
      state.businessMonth = payload.latest || [...available].sort().pop() || "";
    }
  } catch {
    state.businessMonths = [{ month: "2026-06" }];
    state.businessMonth = state.businessMonth || "2026-06";
  }
  renderBusinessMonthControls();
}

async function loadBusinessReport(month = state.businessMonth) {
  if (!month) throw new Error("该月份尚未同步");
  state.businessMonth = month;
  renderBusinessMonthControls();
  const [reportResponse, costResponse, exchangeResponse, settingsResponse] = await Promise.all([
    fetch(`./data/wb-business/wb-business-${month}.json?v=${Date.now()}`, { cache: "no-store" }),
    fetch(`/api/wb/business-costs/${month}?v=${Date.now()}`, { cache: "no-store" }),
    fetch("/api/exchange-rate", { cache: "no-store" }),
    fetch("/api/wb/business/settings", { cache: "no-store" })
  ]);
  if (!reportResponse.ok) throw new Error(`${businessMonthLabel(month)}尚未同步`);
  const payload = await reportResponse.json();
  state.businessReport = payload || null;

  state.ozonCostBySku = new Map();
  if (costResponse.ok) {
    const costPayload = await costResponse.json();
    for (const row of costPayload.rows || []) {
      if (row.sku) state.ozonCostBySku.set(String(row.sku).trim().toLowerCase(), row);
      if (row.offerId) state.ozonCostBySku.set(String(row.offerId).trim().toLowerCase(), row);
    }
  }
  if (exchangeResponse.ok) {
    const exchangePayload = await exchangeResponse.json();
    const usdRate = Number(exchangePayload?.data?.usdToCny);
    if (Number.isFinite(usdRate) && usdRate > 0) state.usdToCny = usdRate;
  }
  if (settingsResponse.ok) {
    const settingsPayload = await settingsResponse.json();
    const settings = settingsPayload?.data || {};
    if (Number.isFinite(Number(settings.taxRate))) state.taxRate = Number(settings.taxRate);
    if (Number.isFinite(Number(settings.collectionRate))) state.collectionRate = Number(settings.collectionRate);
    if (Number.isFinite(Number(settings.logisticsFactorUsdKg))) {
      state.logisticsFactorUsdKg = Number(settings.logisticsFactorUsdKg);
    }
    localStorage.removeItem("wbBusinessTaxRate");
    localStorage.removeItem("wbBusinessCollectionRate");
  }
  renderBusinessBoard();
}

async function loadBusinessData() {
  if (window.dashboardAuthReady) await window.dashboardAuthReady;
  await loadBusinessMonthIndex();
  await loadBusinessReport(state.businessMonth);
}

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
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

function statusKey(nmId, field) {
  return `${nmId}:${field}`;
}

function setStatus(nmId, field, status, text) {
  const key = statusKey(nmId, field);
  state.statuses.set(key, { status, text });
  const node = document.querySelector(`[data-status="${CSS.escape(key)}"]`);
  if (node) {
    node.className = `status ${status}`;
    node.textContent = text;
  }
}

function normalizePatchValue(field, value) {
  if (field === "competitor_compare" || field === "strategy") return value;
  if (value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getProduct(nmId) {
  return state.products.find(item => String(item.nm_id) === String(nmId));
}

async function loadExchangeRate() {
  try {
    const res = await fetch(`${API_BASE}/api/exchange-rate`);
    if (!res.ok) return;
    const payload = await res.json();
    if (payload?.data?.rubToCny) state.rubToCny = Number(payload.data.rubToCny);
    state.exchangeRateUpdatedAt = payload?.data?.publishedAt || payload?.data?.updatedAt || "";
  } catch {}
}

function formatSyncTime(value) {
  return value ? new Date(value).toLocaleString() : "暂无";
}

async function loadSyncStatus() {
  const node = $("syncStatusText");
  if (!node) return;

  try {
    const res = await fetch(`${API_BASE}/api/wb/sync-status`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "同步状态读取失败");

    const data = payload.data || {};
    const parts = [];
    parts.push(data.running ? "后台同步中" : "当前未同步");
    parts.push(`上次开始：${formatSyncTime(data.lastStartedAt)}`);
    parts.push(`上次成功：${formatSyncTime(data.lastOkAt)}`);
    parts.push(`上次结束：${formatSyncTime(data.lastFinishedAt)}`);
    const phases = data.phases || data.lastResult?.phases || {};
    const failedPhases = Object.entries(phases)
      .filter(([, phase]) => phase && phase.ok === false)
      .map(([name, phase]) => `${name}:${phase.statusCode || ""}${phase.error ? ` ${phase.error}` : ""}`);
    if (failedPhases.length) parts.push(`失败阶段：${failedPhases.join("；")}`);
    if (data.lastError) parts.push(`最近失败：${data.lastError}`);
    node.textContent = parts.join(" | ");
    node.className = data.lastError || failedPhases.length ? "sync-status-text warning" : "sync-status-text";
  } catch (error) {
    node.textContent = `同步状态读取失败：${error.message}`;
    node.className = "sync-status-text warning";
  }
}

async function loadDashboard() {
  $("syncText").textContent = "正在加载 WB 数据...";
  await loadExchangeRate();

  const res = await fetch(dashboardUrl());
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "WB 数据加载失败");

  state.products = payload.data.products || [];
  state.summary = payload.data.summary || {};
  state.metricDate = formatDateKey(payload.data.summary?.selectedDate) || state.metricDate;
  if ($("metricDateInput")) $("metricDateInput").value = state.metricDate;
  loadStoreMetrics().catch(error => showToast(error.message));
  render();

  $("syncText").textContent =
    `WB 已加载 ${state.products.length} 个商品，更新时间 ${new Date(payload.data.fetchedAt).toLocaleString()}`;
}

function renderStats() {
  const s = state.summary || {};
  const items = [
    ["WB商品数", s.productCount || 0],
    ["总销量", s.totalSales || s.totalYesterdaySales || 0],
    ["总销售额", formatMoney(s.totalRevenue || 0)],
    ["当前日期", s.selectedDate || state.metricDate || "-"],
    ["总库存", s.totalStock || 0],
    ["数据源", "Wildberries"]
  ];
  $("stats").innerHTML = items
    .map(([label, value]) => `<div class="stat"><span>${label}</span><strong>${value}</strong></div>`)
    .join("");
}

function productMatches(item) {
  const term = state.search.trim().toLowerCase();
  if (!term) return true;
  return [
    item.nm_id,
    item.vendor_code,
    item.title,
    item.subject_name,
    item.competitor_compare,
    item.strategy
  ].some(value => String(value || "").toLowerCase().includes(term));
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

function expectedProfit(item) {
  const priceRub = toNumber(item.price);
  if (!priceRub) return "";

  const rubToCny = state.rubToCny || 9.07 / 100;
  const purchaseCny = toNumber(item.purchase_cost);
  const shippingCny = toNumber(item.shipping_cost);
  const weightKg = toNumber(item.weight) / 1000;
  const freightRate = toNumber(item.freight_rate);

  const commissionRub = priceRub * toNumber(item.commission_rate) / 100;
  const returnRub = priceRub * toNumber(item.return_rate) / 100;
  const tailRub = priceRub * 0.14;
  const taxRub = priceRub * 0.12;
  const acquiringRub = priceRub * 0.02;
  const remainingRub = priceRub - commissionRub - returnRub - tailRub - taxRub - acquiringRub;
  const remittanceRub = remainingRub * 0.06;

  const incomeCny = priceRub * rubToCny;
  const platformCny = (commissionRub + returnRub + tailRub + taxRub + acquiringRub + remittanceRub) * rubToCny;
  const firstMileCny = weightKg * freightRate * 7.2;
  return (incomeCny - platformCny - firstMileCny - purchaseCny - shippingCny).toFixed(2);
}

function renderInput(item, field) {
  const key = statusKey(item.nm_id, field);
  const status = state.statuses.get(key) || { status: "", text: "" };
  const value = item[field] ?? "";

  return `
    <input class="editable wb-edit" value="${escapeHtml(value)}" data-wb-id="${escapeHtml(item.nm_id)}" data-wb-field="${field}" />
    <div class="status ${status.status}" data-status="${escapeHtml(key)}">${escapeHtml(status.text)}</div>
  `;
}

function renderText(item, field) {
  const key = statusKey(item.nm_id, field);
  const status = state.statuses.get(key) || { status: "", text: "" };
  const value = item[field] ?? "";

  return `
    <div class="editable-text editable-div wb-edit" contenteditable="true" data-wb-id="${escapeHtml(item.nm_id)}" data-wb-field="${field}">${escapeHtml(value)}</div>
    <div class="status ${status.status}" data-status="${escapeHtml(key)}">${escapeHtml(status.text)}</div>
  `;
}


function imageUploadButton(nmId) {
  return `
    <label class="image-upload-btn">
      \u4e0a\u4f20
      <input type="file" accept="image/png,image/jpeg,image/webp" data-image-upload="${escapeHtml(nmId)}" />
    </label>
  `;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

async function uploadProductImage(nmId, file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    showToast("\u53ea\u652f\u6301 PNG / JPG / WEBP \u56fe\u7247");
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    showToast("\u56fe\u7247\u4e0d\u80fd\u8d85\u8fc7 5MB");
    return;
  }

  const item = getProduct(nmId);
  if (!item) return;
  showToast("\u6b63\u5728\u4e0a\u4f20\u56fe\u7247...");
  const dataUrl = await fileToDataUrl(file);
  const res = await fetch(`${API_BASE}/api/wb/products/${encodeURIComponent(nmId)}/image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "\u56fe\u7247\u4e0a\u4f20\u5931\u8d25");
  Object.assign(item, payload.data || {});
  if (payload.image_url) item.image_url = payload.image_url;
  renderTable();
  showToast("\u56fe\u7247\u5df2\u4e0a\u4f20");
}

function renderTable() {
  $("tableHead").innerHTML = `
    <tr>
      <th>商品</th>
      <th>图片</th>
      <th>FBS库存</th><th>WB库存</th>
      <th>销量</th>
      <th>销售额</th>
      <th>佣金率</th>
      <th>采购成本</th>
      <th>发货成本</th>
      <th>重量</th>
      <th>运费系数</th>
      <th>退货率</th>
      <th>售价</th>
      <th>预期利润</th>
      <th class="competitor-cell">竞品对比</th>
      <th>产品策略</th>
    </tr>
  `;

  const rows = sortedProducts().map(item => `
    <tr data-wb-row="${escapeHtml(item.nm_id)}" class="${String(item.nm_id) === String(state.selectedNmId) ? "selected-row" : ""}">
      <td class="product-cell">
        <strong>${escapeHtml(item.vendor_code || item.title || item.nm_id)}</strong>
        <span>${escapeHtml(item.nm_id)}</span>
        <span>${escapeHtml(item.subject_name || "")}</span>
      </td>
      <td class="image-cell">
              <label class="image-upload-zone" title="Click to upload image">
                ${item.image_url ? `<img class="image-preview" src="${escapeHtml(item.image_url)}" loading="lazy" decoding="async" />` : `<div class="image-empty">\u70b9\u51fb\u4e0a\u4f20</div>`}
                <input type="file" accept="image/png,image/jpeg,image/webp" data-image-upload="${escapeHtml(item.nm_id)}" />
              </label>
            </td>
      <td>${escapeHtml(item.fbs_stock || 0)}</td><td>${escapeHtml(item.fbw_stock || 0)}</td>
      <td>${escapeHtml(item.selected_sales ?? item.yesterday_sales ?? 0)}</td>
      <td>${escapeHtml(formatMoney(item.selected_revenue || 0))}</td>
      <td>${renderInput(item, "commission_rate")}</td>
      <td>${renderInput(item, "purchase_cost")}</td>
      <td>${renderInput(item, "shipping_cost")}</td>
      <td>${renderInput(item, "weight")}</td>
      <td>${renderInput(item, "freight_rate")}</td>
      <td>${renderInput(item, "return_rate")}</td>
      <td>${renderInput(item, "price")}</td>
      <td class="profit-cell">${escapeHtml(expectedProfit(item))}</td>
      <td class="competitor-cell">${renderText(item, "competitor_compare")}</td>
      <td>${renderText(item, "strategy")}</td>
    </tr>
  `);

  $("productBody").innerHTML = rows.join("") || `<tr><td colspan="16">暂无 WB 商品数据。WB API 可能仍在限流，稍后点击“同步WB”。</td></tr>`;
}

function renderRevenueTrend() {
  const node = $("storeRevenueChart");
  if (!node) return;
  const rows = state.storeMetrics || [];
  if (!rows.length) {
    node.innerHTML = '<div class="trend-empty">暂无销售额数据</div>';
    return;
  }

  const width = 760;
  const height = 250;
  const padding = { left: 58, right: 24, top: 16, bottom: 34 };
  const points = rows.map((item, index) => ({
    index,
    date: String(item.metric_date || "").slice(5, 10),
    revenue: toNumber(item.revenue)
  }));
  const maxRevenue = Math.max(1, ...points.map(point => point.revenue));
  const x = index => padding.left + (points.length === 1 ? 0 : index * (width - padding.left - padding.right) / (points.length - 1));
  const y = value => height - padding.bottom - value / maxRevenue * (height - padding.top - padding.bottom);
  const line = points.map(point => `${x(point.index)},${y(point.revenue)}`).join(" ");
  const ticks = [0, Math.ceil(maxRevenue / 2), Math.ceil(maxRevenue)];

  node.innerHTML = `
    <div class="chart-title">近 30 天店铺销售额</div>
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${ticks.map(t => `
        <line class="grid-line" x1="${padding.left}" y1="${y(t)}" x2="${width - padding.right}" y2="${y(t)}"></line>
        <text class="axis-label" x="${padding.left - 8}" y="${y(t) + 4}" text-anchor="end">${Math.round(t)}</text>
      `).join("")}
      <line class="axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
      <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
      <polyline class="revenue-line" fill="none" points="${line}"></polyline>
      ${points.map(point => `
        <circle class="revenue-point" cx="${x(point.index)}" cy="${y(point.revenue)}" r="4"></circle>
        <text class="axis-label" x="${x(point.index)}" y="${height - 10}" text-anchor="middle">${point.date}</text>
      `).join("")}
    </svg>
  `;
  renderBusinessBoard();
}

function render() {
  renderStats();
  renderTable();
  renderBusinessBoard();
  applyWbSubView();
}

function ensureWbSubnav() {
  const headerTitle = document.querySelector(".topbar > div");
  const tabs = document.querySelector(".market-tabs");
  const target = headerTitle || tabs;
  if (!target) return;
  let nav = document.querySelector(".wb-subnav");
  if (!nav) {
    nav = document.createElement("div");
    nav.className = "portal-subnav wb-subnav wb-header-subnav";
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "WB 本土看板子项");
    nav.innerHTML = `
      <button class="active" type="button" data-wb-view="products">商品看板</button>
      <button type="button" data-wb-view="business">经营看板</button>
    `;
  }
  nav.classList.add("wb-header-subnav");
  if (headerTitle && headerTitle.lastElementChild !== nav) {
    headerTitle.appendChild(nav);
  } else if (!headerTitle && tabs.nextElementSibling !== nav) {
    tabs.insertAdjacentElement("afterend", nav);
  }
  nav.querySelectorAll("[data-wb-view]").forEach(button => {
    if (button.dataset.bound === "1") return;
    button.dataset.bound = "1";
    button.addEventListener("click", () => setWbSubView(button.dataset.wbView));
  });
}

function applyWbSubView() {
  ensureWbSubnav();
  const view = state.activeView || "products";
  document.querySelectorAll("[data-wb-subview]").forEach(node => {
    node.hidden = node.dataset.wbSubview !== view;
  });
  document.querySelectorAll("[data-wb-view]").forEach(button => {
    const active = button.dataset.wbView === view;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function setWbSubView(view) {
  state.activeView = view === "business" ? "business" : "products";
  applyWbSubView();
  if (state.activeView === "business") renderBusinessBoard();
}

function formatCompact(value) {
  return new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(toNumber(value));
}

function sumProducts(field) {
  return (state.products || []).reduce((sum, item) => sum + toNumber(item[field]), 0);
}

function recentStoreTotals() {
  const rows = (state.storeMetrics || []).slice(-30);
  return rows.reduce((acc, row) => {
    acc.revenue += toNumber(row.revenue);
    acc.sales += toNumber(row.sales_units || row.sales || row.orders || 0);
    return acc;
  }, { revenue: 0, sales: 0 });
}

function renderBusinessStat(label, value, note) {
  return `
    <div class="business-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(note || "")}</small>
    </div>
  `;
}

function renderBusinessRevenueChart() {
  const node = $("wbBusinessRevenueChart");
  if (!node) return;

  const rows = (state.storeMetrics || []).slice(-30);
  if (!rows.length) {
    node.innerHTML = '<div class="trend-empty">暂无近 30 天销售额数据</div>';
    return;
  }

  const points = rows.map((item, index) => ({
    index,
    date: String(item.metric_date || item.date || "").slice(5, 10),
    revenue: toNumber(item.revenue),
    sales: toNumber(item.sales_units || item.sales || item.orders || 0)
  }));
  const width = 760;
  const height = 250;
  const pad = { left: 48, right: 24, top: 20, bottom: 34 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const maxRevenue = Math.max(1, ...points.map(point => point.revenue));
  const maxSales = Math.max(1, ...points.map(point => point.sales));
  const x = index => pad.left + (points.length <= 1 ? innerWidth : index * innerWidth / (points.length - 1));
  const yRevenue = value => pad.top + innerHeight - value / maxRevenue * innerHeight;
  const ySales = value => pad.top + innerHeight - value / maxSales * innerHeight;
  const revenueLine = points.map(point => `${x(point.index)},${yRevenue(point.revenue)}`).join(" ");
  const salesLine = points.map(point => `${x(point.index)},${ySales(point.sales)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map(rate => {
    const y = pad.top + innerHeight - innerHeight * rate;
    return `<line class="grid-line" x1="${pad.left}" x2="${width - pad.right}" y1="${y}" y2="${y}"></line>`;
  }).join("");
  const labels = points
    .filter((_, index) => index === 0 || index === points.length - 1 || index % 7 === 0)
    .map(point => `<text class="axis-label" x="${x(point.index)}" y="${height - 10}" text-anchor="middle">${escapeHtml(point.date)}</text>`)
    .join("");

  node.innerHTML = `
    <div class="chart-title">WB 本土近 30 天经营趋势</div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="WB 本土近 30 天销售额和销量趋势">
      ${grid}
      <line class="axis" x1="${pad.left}" x2="${pad.left}" y1="${pad.top}" y2="${height - pad.bottom}"></line>
      <line class="axis" x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}"></line>
      <text class="axis-label" x="${pad.left}" y="14">₽ ${formatCompact(maxRevenue)}</text>
      <text class="axis-label ad-axis-label" x="${width - pad.right}" y="14" text-anchor="end">${formatCompact(maxSales)} 件</text>
      <polyline class="revenue-line" fill="none" points="${revenueLine}"></polyline>
      <polyline class="sales-line" fill="none" points="${salesLine}"></polyline>
      ${points.map(point => `<circle class="revenue-point" cx="${x(point.index)}" cy="${yRevenue(point.revenue)}" r="3"></circle>`).join("")}
      ${points.map(point => `<circle class="sales-point" cx="${x(point.index)}" cy="${ySales(point.sales)}" r="3"></circle>`).join("")}
      ${labels}
    </svg>
  `;
}

function renderBusinessTopProducts() {
  const node = $("wbBusinessTopProducts");
  if (!node) return;
  const report = state.businessReport;
  const rows = report ? [...(report.rows || [])] : [...(state.products || [])];
  const profitForItem = item => {
    if (!report) return toNumber(item.expected_profit || 0);
    const key = String(item.ozonSku || item.ourSku || "").trim().toLowerCase();
    const cost = state.ozonCostBySku.get(key);
    const retail = item.retailRevenue === null || item.retailRevenue === undefined || item.retailRevenue === ""
      ? null
      : Number(item.retailRevenue);
    if (!cost || retail === null || !Number.isFinite(Number(cost.purchaseCost)) || !Number.isFinite(Number(cost.weightG))) return null;
    const linkedIds = Array.from(new Set(
      String(item.wbLocalLinks || "")
        .split(/\r?\n/)
        .map(line => line.match(/\/\s*(\d+)(?:\s*\/|$)/)?.[1] || "")
        .filter(Boolean)
    ));
    const shipping = linkedIds.reduce((value, nmId) => {
      if (value !== null) return value;
      const product = state.products.find(entry => String(entry.nm_id) === String(nmId));
      return product && product.shipping_cost !== null && product.shipping_cost !== undefined && product.shipping_cost !== ""
        ? Number(product.shipping_cost)
        : null;
    }, null) || 0;
    const firstLeg = Number(cost.weightG) / 1000 * state.logisticsFactorUsdKg * state.usdToCny;
    const volume = toNumber(item.netSales ?? item.sales);
    const landed = (Number(cost.purchaseCost) + firstLeg + shipping) * volume;
    const received = (toNumber(item.finalPayout ?? item.payable) - retail * state.taxRate) * (1 - state.collectionRate) * state.rubToCny;
    return received - landed;
  };
  rows.forEach(item => {
    item._businessGrossProfit = profitForItem(item);
  });
  rows.sort((a, b) =>
    (b._businessGrossProfit === null ? -Infinity : b._businessGrossProfit)
    - (a._businessGrossProfit === null ? -Infinity : a._businessGrossProfit)
  );
  if (!rows.length) {
    node.innerHTML = '<div class="trend-empty">暂无商品排行数据</div>';
    return;
  }

  const topRows = rows.slice(0, 8);
  node.innerHTML = `
    <div class="chart-title">${report ? `${businessMonthLabel(state.businessMonth)}毛利润 Top 8` : "当前日期利润 Top 8"}</div>
    <div class="wb-product-grid">
      ${topRows.map((item, index) => {
        const profit = item._businessGrossProfit;
        const sales = toNumber(item.netSales ?? item.sales ?? item.selected_sales ?? item.yesterday_sales ?? 0);
        const title = item.barcodeSku || item.vendor_code || item.ourSku || item.title || item.nm_id;
        const imageUrl = item.imageUrl || item.image_url || "";
        return `
          <article class="wb-product-card">
            <span class="wb-product-rank">${index + 1}</span>
            ${imageUrl
              ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" loading="lazy" />`
              : `<div class="wb-product-placeholder">暂无图片</div>`}
            <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
            <span>${formatCny(profit)}</span>
            <small>${sales} 件</small>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderBusinessCostChart(report) {
  const node = $("wbBusinessRevenueChart");
  if (!node) return;
  if (!report) {
    renderBusinessRevenueChart();
    return;
  }
  const totals = report.totals || {};
  const bars = [
    ["物流相关费用", totals.logisticsFees],
    ["仓储费", totals.storageFees],
    ["验收费", totals.acceptanceFees],
    ["扣款", totals.deductions],
    ["罚款", totals.fines]
  ];
  const max = Math.max(1, ...bars.map(([, value]) => Math.abs(toNumber(value))));
  node.innerHTML = `
    <div class="chart-title">${businessMonthLabel(state.businessMonth)}费用结构</div>
    <div class="business-cost-bars">
      ${bars.map(([label, value]) => {
        const amount = toNumber(value);
        const width = Math.max(2, Math.abs(amount) / max * 100);
        return `
          <div class="business-cost-row">
            <span>${escapeHtml(label)}</span>
            <div class="rank-bar"><i style="width:${width}%"></i></div>
            <strong>${formatMoney(amount)}</strong>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function renderBusinessDetailTable(report, options = {}) {
  const node = $("wbBusinessTable");
  if (!node) return;
  const previousShell = options.preserveScroll ? node.querySelector(".business-table-shell") : null;
  const scrollSnapshot = options.preserveScroll
    ? {
        pageX: window.scrollX,
        pageY: window.scrollY,
        tableLeft: previousShell?.scrollLeft || 0,
        tableTop: previousShell?.scrollTop || 0
      }
    : null;
  if (!report || !(report.rows || []).length) {
    node.innerHTML = "";
    return;
  }
  const allRows = report.rows || [];
  const rows = allRows;
  const totals = report.totals || {};
  const businessCost = (item) => state.ozonCostBySku.get(String(item.ozonSku || item.ourSku || "").trim().toLowerCase()) || null;
  const firstLeg = (cost) => {
    if (!cost || cost.weightG === null || cost.weightG === "" || !Number.isFinite(Number(cost.weightG))) return null;
    return Number(cost.weightG) / 1000 * state.logisticsFactorUsdKg * state.usdToCny;
  };
  const linkedNmIds = (item) => Array.from(new Set(
    String(item.wbLocalLinks || "")
      .split(/\r?\n/)
      .map(line => line.match(/\/\s*(\d+)(?:\s*\/|$)/)?.[1] || "")
      .filter(Boolean)
  ));
  const shippingCost = (item) => {
    for (const nmId of linkedNmIds(item)) {
      const product = state.products.find(entry => String(entry.nm_id) === String(nmId));
      if (product && product.shipping_cost !== null && product.shipping_cost !== undefined && product.shipping_cost !== "") {
        return Number(product.shipping_cost);
      }
    }
    return "";
  };
  const retailSales = (item) => (
    item.retailRevenue === null || item.retailRevenue === undefined || item.retailRevenue === ""
      ? null
      : Number(item.retailRevenue)
  );
  const receivedAmount = (item) => {
    const retail = retailSales(item);
    if (retail === null) return null;
    return (
      (toNumber(item.finalPayout ?? item.payable) - retail * state.taxRate)
      * (1 - state.collectionRate)
      * state.rubToCny
    );
  };
  const landedTotal = (item, cost) => {
    const purchase = cost?.purchaseCost;
    const firstLegCost = firstLeg(cost);
    if (purchase === null || purchase === undefined || purchase === "" || !Number.isFinite(Number(purchase)) || firstLegCost === null) {
      return null;
    }
    return (Number(purchase) + Number(firstLegCost) + Number(shippingCost(item) || 0)) * toNumber(item.netSales ?? item.sales);
  };
  const grossProfit = (item, cost) => {
    const received = receivedAmount(item);
    const landed = landedTotal(item, cost);
    if (received === null || landed === null) return null;
    return received - landed;
  };
  const unitGrossProfit = (item, cost) => {
    const profit = grossProfit(item, cost);
    const sales = toNumber(item.netSales ?? item.sales);
    if (profit === null || sales <= 0) return null;
    return profit / sales;
  };
  const profitClass = (value) => {
    if (value === null) return "";
    return Number(value) >= 0 ? "business-profit-positive" : "business-profit-negative";
  };
  const payoutTotal = toNumber(totals.backendPayableTotal || totals.finalPayout);
  const grossProfitValues = allRows
    .map(item => grossProfit(item, businessCost(item)))
    .filter(value => value !== null);
  const unmatchedReceivedAdjustment =
    toNumber(totals.unmatchedFinanceNet)
    * (1 - state.collectionRate)
    * state.rubToCny;
  const grossProfitTotal =
    grossProfitValues.reduce((sum, value) => sum + value, 0)
    + unmatchedReceivedAdjustment;
  const includedRows = allRows.filter(item => grossProfit(item, businessCost(item)) !== null);
  const includedFinalPayoutRub = includedRows.reduce(
    (sum, item) => sum + toNumber(item.finalPayout ?? item.payable),
    0
  );
  const includedRetailRevenueRub = includedRows.reduce(
    (sum, item) => sum + toNumber(retailSales(item)),
    0
  );
  const taxRub = includedRetailRevenueRub * state.taxRate;
  const afterTaxRub = includedFinalPayoutRub - taxRub;
  const collectionFeeRub = afterTaxRub * state.collectionRate;
  const matchedNetRub = afterTaxRub - collectionFeeRub;
  const matchedReceivedCny = matchedNetRub * state.rubToCny;
  const unmatchedNetRub =
    toNumber(totals.unmatchedFinanceNet) * (1 - state.collectionRate);
  const storeReceivedRub = matchedNetRub + unmatchedNetRub;
  const purchaseTotalCny = includedRows.reduce((sum, item) => {
    const cost = businessCost(item);
    return sum + Number(cost.purchaseCost) * toNumber(item.netSales ?? item.sales);
  }, 0);
  const firstLegTotalCny = includedRows.reduce((sum, item) => {
    const cost = businessCost(item);
    return sum + Number(firstLeg(cost)) * toNumber(item.netSales ?? item.sales);
  }, 0);
  const shippingTotalCny = includedRows.reduce(
    (sum, item) => sum + Number(shippingCost(item) || 0) * toNumber(item.netSales ?? item.sales),
    0
  );
  const landedTotalCny = purchaseTotalCny + firstLegTotalCny + shippingTotalCny;
  const retailTotalNode = $("wbBusinessRetailTotal");
  const grossTotalNode = $("wbBusinessGrossTotal");
  if (retailTotalNode) retailTotalNode.textContent = formatMoney(payoutTotal);
  if (grossTotalNode) {
    grossTotalNode.textContent = grossProfitValues.length ? formatCny(grossProfitTotal) : "—";
    grossTotalNode.className = grossProfitValues.length
      ? (grossProfitTotal >= 0 ? "summary-profit-positive" : "summary-profit-negative")
      : "";
    grossTotalNode.title = `已计入 ${grossProfitValues.length}/${allRows.length} 个成本完整商品；未匹配WB财务净额按回款手续费和汇率折算后，调整 ${formatCny(unmatchedReceivedAdjustment)}`;
  }
  node.innerHTML = `
    <div class="business-relation" aria-label="结算关系说明">
      <div>
        <strong>金额关系</strong>
        <span>最终回款 = 应付卖家 − 物流费用 − 仓储费 − 验收费 − 扣款 − 罚款 + 其他补款/调整</span>
      </div>
      <div class="business-relation-values">
        <span>${formatMoney(totals.payable)}</span><b>−</b>
        <span>${formatMoney(totals.logisticsFees)}</span><b>−</b>
        <span>${formatMoney(totals.storageFees)}</span><b>−</b>
        <span>${formatMoney(totals.acceptanceFees)}</span><b>−</b>
        <span>${formatMoney(totals.deductions)}</span><b>−</b>
        <span>${formatMoney(totals.fines)}</span><b>+</b>
        <span>${formatMoney(totals.otherAdjustments)}</span><b>=</b>
        <strong>${formatMoney(totals.finalPayout)}</strong>
      </div>
      <div>
        <strong>后台总对账</strong>
        <span>已匹配条码SKU最终回款 + 未匹配WB财务净额 = WB后台应付总额</span>
      </div>
      <div class="business-relation-values">
        <span>${formatMoney(totals.finalPayout)}</span><b>+</b>
        <span>${formatMoney(totals.unmatchedFinanceNet)}</span><b>=</b>
        <strong>${formatMoney(totals.backendPayableTotal)}</strong>
        <span>（差异 ${formatMoney(totals.reconciliationDifference)}）</span>
      </div>
      <small>全部金额直接取自 NAS 最新月度报告；rebillLogisticCost 仅作参考分析，不参与 WB 后台应付总额主对账。销量为已交付数量，经营成本和单品毛利按净交付数量计算。</small>
    </div>
    <details class="business-profit-breakdown">
      <summary>
        <span><strong>店铺利润计算过程</strong>（点击展开）</span>
        <strong class="${profitClass(grossProfitTotal)}">${formatCny(grossProfitTotal)}</strong>
      </summary>
      <div class="business-profit-formula">
        <div>
          <strong>① WB销售税费</strong>
          <span>零售销售额 ${formatMoney(totals.retailRevenue || includedRetailRevenueRub)} × ${(state.taxRate * 100).toFixed(1)}%</span>
          <b>= ${formatMoney(taxRub)}</b>
        </div>
        <div>
          <strong>② 后台应付总额</strong>
          <span>已匹配最终回款 ${formatMoney(includedFinalPayoutRub)} + 未匹配财务净额 ${formatMoney(totals.unmatchedFinanceNet)}</span>
          <b>= ${formatMoney(totals.backendPayableTotal)}</b>
        </div>
        <div>
          <strong>③ 扣税后回款</strong>
          <span>后台应付总额 ${formatMoney(totals.backendPayableTotal)} − 税费 ${formatMoney(taxRub)}</span>
          <b>= ${formatMoney(storeReceivedRub / (1 - state.collectionRate))}</b>
        </div>
        <div>
          <strong>④ 回款手续费</strong>
          <span>扣税后回款 ${formatMoney(storeReceivedRub / (1 - state.collectionRate))} × ${(state.collectionRate * 100).toFixed(1)}%</span>
          <b>= ${formatMoney(storeReceivedRub / (1 - state.collectionRate) * state.collectionRate)}</b>
        </div>
        <div>
          <strong>⑤ 店铺到账（卢布）</strong>
          <span>扣税后回款 ${formatMoney(storeReceivedRub / (1 - state.collectionRate))} − 回款手续费 ${formatMoney(storeReceivedRub / (1 - state.collectionRate) * state.collectionRate)}</span>
          <b>= ${formatMoney(storeReceivedRub)}</b>
        </div>
        <div>
          <strong>⑥ 店铺到账（人民币）</strong>
          <span>店铺到账 ${formatMoney(storeReceivedRub)} × 卢布兑人民币汇率 ${state.rubToCny.toFixed(4)}</span>
          <b>= ${formatCny(storeReceivedRub * state.rubToCny)}</b>
        </div>
        <div>
          <strong>⑦ 采购成本</strong>
          <span>各商品单件采购成本 × 净交付数量后汇总</span>
          <b>= ${formatCny(purchaseTotalCny)}</b>
        </div>
        <div>
          <strong>⑧ 头程费用</strong>
          <span>各商品重量kg × ${state.logisticsFactorUsdKg}美元/kg × 美元汇率 ${state.usdToCny.toFixed(4)} × 净交付数量后汇总</span>
          <b>= ${formatCny(firstLegTotalCny)}</b>
        </div>
        <div>
          <strong>⑨ 海外仓发货成本</strong>
          <span>各商品单件海外仓发货成本 × 净交付数量后汇总</span>
          <b>= ${formatCny(shippingTotalCny)}</b>
        </div>
        <div>
          <strong>⑩ 到俄总成本</strong>
          <span>采购成本 ${formatCny(purchaseTotalCny)} + 头程费用 ${formatCny(firstLegTotalCny)} + 海外仓发货成本 ${formatCny(shippingTotalCny)}</span>
          <b>= ${formatCny(landedTotalCny)}</b>
        </div>
        <div class="business-profit-result">
          <strong>⑪ 店铺总毛利</strong>
          <span>店铺到账 ${formatCny(storeReceivedRub * state.rubToCny)} − 到俄总成本 ${formatCny(landedTotalCny)}</span>
          <b>= ${formatCny(grossProfitTotal)}</b>
        </div>
      </div>
      <small>本次计入 ${includedRows.length}/${allRows.length} 个采购成本和重量完整的商品；海外仓发货成本未填写时暂按 ¥0 计算。税费、回款手续费或汇率修改后，本计算过程会同步刷新。</small>
    </details>
    <div class="business-table-toolbar">
      <div class="business-table-title">${businessMonthLabel(state.businessMonth)}按条码SKU合并明细（共 ${allRows.length} 个）</div>
      <span class="business-single-page-note">全部商品单页显示</span>
    </div>
    <div class="business-table-shell">
      <table class="business-table">
        <thead>
          <tr>
            <th>图片</th>
            <th>条码SKU</th>
            <th><span>采购成本</span><small>（人民币/件）</small></th>
            <th><span>头程费用</span><small>（人民币/件）</small></th>
            <th><span>海外仓发货成本</span><small>（人民币/件）</small></th>
            <th>已交付</th>
            <th>退货</th>
            <th>净交付</th>
            <th title="（采购成本 + 头程费用 + 海外仓发货成本）× 净交付数量"><span>到俄总成本</span><small>（人民币）</small></th>
            <th title="来源：NAS更新版WB统计文档，按条码SKU汇总零售价销售额">WB零售价销售额（卢布）</th>
            <th title="（最终回款 − 零售销售额 × 税费系数）×（1 − 回款系数）× 卢布兑人民币汇率">到账金额（人民币）</th>
            <th class="business-profit-heading" title="到账金额 − 到俄总成本">毛利（人民币）</th>
            <th class="business-profit-heading" title="毛利 ÷ 净交付数量">单件毛利（人民币/件）</th>
            <th>WB销售额（卢布）</th>
            <th>应付卖家（卢布）</th>
            <th>物流费用</th>
            <th>仓储费</th>
            <th>验收费</th>
            <th>扣款</th>
            <th>罚款</th>
            <th>其他补款/调整</th>
            <th>最终回款</th>
            <th>财务明细行</th>
            <th>关联商品</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(item => {
            const cost = businessCost(item);
            const nmIds = linkedNmIds(item);
            const itemGrossProfit = grossProfit(item, cost);
            const itemUnitGrossProfit = unitGrossProfit(item, cost);
            return `
            <tr>
              <td>${item.imageUrl ? `<img class="business-thumb" src="${escapeHtml(item.imageUrl)}" alt="">` : ""}</td>
              <td><strong>${escapeHtml(item.barcodeSku)}</strong></td>
              <td title="${cost ? `来源：Ozon经营看板 ${escapeHtml(cost.offerId || cost.sku || "")}` : "Ozon经营看板未匹配"}">${formatCny(cost?.purchaseCost)}</td>
              <td title="${cost ? `重量 ${toNumber(cost.weightG)}g × ${state.logisticsFactorUsdKg}美元/kg × 汇率 ${state.usdToCny.toFixed(4)}` : "Ozon经营看板未匹配"}">${formatCny(firstLeg(cost))}</td>
              <td>
                <input class="business-shipping-input" type="number" min="0" step="0.01"
                  data-business-shipping="${escapeHtml(item.barcodeSku)}"
                  data-business-nm-ids="${escapeHtml(nmIds.join(","))}"
                  value="${escapeHtml(shippingCost(item))}" placeholder="手填" ${nmIds.length ? "" : "disabled"}>
                <small class="business-save-status" data-business-save-status="${escapeHtml(item.barcodeSku)}">${nmIds.length ? "" : "未关联WB商品"}</small>
              </td>
              <td>${toNumber(item.delivered ?? item.sales).toLocaleString("ru-RU")}</td>
              <td>${toNumber(item.returns).toLocaleString("ru-RU")}</td>
              <td>${toNumber(item.netSales ?? item.sales).toLocaleString("ru-RU")}</td>
              <td class="business-landed-total" title="（采购成本 + 头程费用 + 海外仓发货成本）× 净交付数量">${formatCny(landedTotal(item, cost))}</td>
              <td class="business-retail-sales" title="来源：NAS更新版WB统计文档；不参与应付卖家财务对账">${retailSales(item) === null ? "—" : formatMoney(retailSales(item))}</td>
              <td class="business-received-amount" title="（${formatMoney(item.finalPayout)} − 零售销售额 ${formatMoney(retailSales(item))} × ${(state.taxRate * 100).toFixed(1)}%）×（1 − ${(state.collectionRate * 100).toFixed(1)}%）× ${state.rubToCny.toFixed(4)}">${formatCny(receivedAmount(item))}</td>
              <td class="business-profit-cell ${profitClass(itemGrossProfit)}" title="到账金额 − 到俄总成本">${formatCny(itemGrossProfit)}</td>
              <td class="business-profit-cell ${profitClass(itemUnitGrossProfit)}" title="毛利率 ÷ WB销量">${formatCny(itemUnitGrossProfit)}</td>
              <td>${formatMoney(item.revenue)}</td>
              <td>${formatMoney(item.payable)}</td>
              <td>${formatMoney(item.logisticsFees)}</td>
              <td>${formatMoney(item.storageFees)}</td>
              <td>${formatMoney(item.acceptanceFees)}</td>
              <td>${formatMoney(item.deductions)}</td>
              <td>${formatMoney(item.fines)}</td>
              <td>${formatMoney(item.otherAdjustments)}</td>
              <td><strong>${formatMoney(item.finalPayout)}</strong></td>
              <td>${toNumber(item.detailRows).toLocaleString("ru-RU")}</td>
              <td class="business-links">${escapeHtml(item.wbLocalLinks || "")}</td>
            </tr>
          `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
  if (scrollSnapshot) {
    const restoreScroll = () => {
      const currentShell = node.querySelector(".business-table-shell");
      if (currentShell) {
        currentShell.scrollLeft = scrollSnapshot.tableLeft;
        currentShell.scrollTop = scrollSnapshot.tableTop;
      }
      window.scrollTo({
        left: scrollSnapshot.pageX,
        top: scrollSnapshot.pageY,
        behavior: "auto"
      });
    };
    restoreScroll();
    requestAnimationFrame(restoreScroll);
  }
  node.querySelectorAll("[data-business-shipping]").forEach(input => {
    input.addEventListener("change", async () => {
      const nmIds = String(input.dataset.businessNmIds || "").split(",").filter(Boolean);
      const status = node.querySelector(`[data-business-save-status="${CSS.escape(input.dataset.businessShipping)}"]`);
      const value = input.value === "" ? null : Number(input.value);
      if (!nmIds.length || (value !== null && (!Number.isFinite(value) || value < 0))) return;
      input.disabled = true;
      if (status) status.textContent = "保存中…";
      try {
        const results = await Promise.all(nmIds.map(nmId => fetch(`${API_BASE}/api/wb/products/${encodeURIComponent(nmId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ shipping_cost: value })
        })));
        if (results.some(response => !response.ok)) throw new Error("保存失败");
        for (const nmId of nmIds) {
          const product = state.products.find(entry => String(entry.nm_id) === String(nmId));
          if (product) product.shipping_cost = value;
        }
        if (status) status.textContent = `已保存到 ${nmIds.length} 个关联商品`;
        renderBusinessDetailTable(report, { preserveScroll: true });
        renderBusinessTopProducts();
      } catch (error) {
        if (status) status.textContent = error.message;
      } finally {
        input.disabled = false;
      }
    });
  });
}

function syncBusinessCalculationControls() {
  const taxInput = $("wbTaxRateInput");
  const collectionInput = $("wbCollectionRateInput");
  const exchangeInput = $("wbRubToCnyInput");
  const canEdit = window.dashboardUser?.role === "admin";

  const saveSettings = async (patch) => {
    const response = await fetch("/api/wb/business/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.error || "经营参数保存失败");
    return payload.data || {};
  };

  if (taxInput) {
    taxInput.value = (state.taxRate * 100).toFixed(1);
    taxInput.disabled = !canEdit;
    taxInput.title = canEdit ? "修改后对所有账号统一生效" : "经营参数由管理员统一设置";
    taxInput.onchange = async () => {
      const value = Number(taxInput.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        taxInput.value = (state.taxRate * 100).toFixed(1);
        return;
      }
      try {
        const settings = await saveSettings({ taxRate: value / 100 });
        state.taxRate = Number(settings.taxRate);
        renderBusinessDetailTable(state.businessReport);
        renderBusinessTopProducts();
      } catch (error) {
        taxInput.value = (state.taxRate * 100).toFixed(1);
        showToast(error.message);
      }
    };
  }
  if (collectionInput) {
    collectionInput.value = (state.collectionRate * 100).toFixed(1);
    collectionInput.disabled = !canEdit;
    collectionInput.title = canEdit ? "修改后对所有账号统一生效" : "经营参数由管理员统一设置";
    collectionInput.onchange = async () => {
      const value = Number(collectionInput.value);
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        collectionInput.value = (state.collectionRate * 100).toFixed(1);
        return;
      }
      try {
        const settings = await saveSettings({ collectionRate: value / 100 });
        state.collectionRate = Number(settings.collectionRate);
        renderBusinessDetailTable(state.businessReport);
        renderBusinessTopProducts();
      } catch (error) {
        collectionInput.value = (state.collectionRate * 100).toFixed(1);
        showToast(error.message);
      }
    };
  }
  if (exchangeInput) {
    exchangeInput.value = state.rubToCny.toFixed(4);
    exchangeInput.title = state.exchangeRateUpdatedAt
      ? `中国银行汇率，更新时间：${new Date(state.exchangeRateUpdatedAt).toLocaleString()}`
      : "中国银行卢布兑人民币汇率";
  }
}

function renderBusinessBoard() {
  const stats = $("wbBusinessStats");
  if (!stats) return;
  syncBusinessCalculationControls();

  const report = state.businessReport;
  if (report) {
    const totals = report.totals || {};
    const netSales = toNumber(totals.netSales ?? totals.sales);
    const delivered = toNumber(totals.delivered ?? (netSales + toNumber(totals.returns)));
    const returnRate = delivered ? toNumber(totals.returns) / delivered : 0;
    const payoutRate = toNumber(totals.payable) ? toNumber(totals.backendPayableTotal ?? totals.finalPayout) / toNumber(totals.payable) : 0;
    const periodStart = String(report.period?.start || "");
    const periodMatch = periodStart.match(/^(\d{4})-(\d{2})/);
    const periodLabel = periodMatch
      ? `${periodMatch[1]}年${Number(periodMatch[2])}月`
      : (report.period?.label || "经营期间");
    const title = $("wbBusinessTitle");
    if (title) title.textContent = `${periodLabel}：NAS 最新月度报告，按条码SKU汇总；利润成本按净交付数量计算`;
    renderBusinessMonthControls();
    stats.innerHTML = [
      renderBusinessStat("6月销量", `${netSales.toLocaleString("ru-RU")} 件`, `净交付口径：已交付 ${delivered.toLocaleString("ru-RU")} − 退货 ${toNumber(totals.returns).toLocaleString("ru-RU")}`),
      renderBusinessStat("WB后台应付总额", formatMoney(totals.backendPayableTotal ?? totals.finalPayout), "已匹配最终回款 + 未匹配财务净额"),
      renderBusinessStat("零售销售额", formatMoney(totals.retailRevenue), "NAS报告按条码SKU汇总"),
      renderBusinessStat("退货率", `${(returnRate * 100).toFixed(1)}%`, "退货数量 / 已交付数量"),
      renderBusinessStat("结算率", `${(payoutRate * 100).toFixed(1)}%`, "最终回款 / 应付卖家"),
      renderBusinessStat("经营SKU", `${toNumber(totals.itemCount).toLocaleString("ru-RU")} 个`, `${toNumber(totals.activeItemCount).toLocaleString("ru-RU")} 个有交付`)
    ].join("");
    renderBusinessCostChart(report);
    renderBusinessTopProducts();
    renderBusinessDetailTable(report);
    return;
  }

  const summary = state.summary || {};
  const selectedSales = toNumber(summary.totalSales || summary.totalYesterdaySales || sumProducts("selected_sales") || sumProducts("yesterday_sales"));
  const selectedRevenue = toNumber(summary.totalRevenue || sumProducts("selected_revenue"));
  const totalStock = toNumber(summary.totalStock || sumProducts("stock"));
  const recent = recentStoreTotals();
  const avgPrice = selectedSales ? selectedRevenue / selectedSales : 0;
  const activeProducts = (state.products || []).filter(item => toNumber(item.selected_sales ?? item.yesterday_sales ?? 0) > 0).length;
  const title = $("wbBusinessTitle");
  if (title) title.textContent = `当前日期：${summary.selectedDate || state.metricDate || "-"}；近 30 天趋势来自 WB 本土店铺数据`;
  stats.innerHTML = [
    renderBusinessStat("当前销量", `${selectedSales.toLocaleString("ru-RU")} 件`, "按当前选择日期"),
    renderBusinessStat("当前销售额", formatMoney(selectedRevenue), "按当前选择日期"),
    renderBusinessStat("近30天销售额", formatMoney(recent.revenue), "店铺趋势汇总"),
    renderBusinessStat("均价", formatMoney(avgPrice), "当前销售额 / 当前销量"),
    renderBusinessStat("有销量商品", `${activeProducts} 个`, "当前日期"),
    renderBusinessStat("总库存", `${totalStock.toLocaleString("ru-RU")} 件`, "WB 本土库存")
  ].join("");
  renderBusinessRevenueChart();
  renderBusinessTopProducts();
  renderBusinessDetailTable(null);
}

function updateRowProfit(nmId) {
  const row = document.querySelector(`[data-wb-row="${CSS.escape(String(nmId))}"]`);
  const item = getProduct(nmId);
  if (!row || !item) return;
  const profitCell = row.querySelector(".profit-cell");
  if (profitCell) profitCell.textContent = expectedProfit(item);
}

function scheduleSave(nmId, field, value) {
  const key = statusKey(nmId, field);
  const version = `${Date.now()}:${Math.random()}`;
  scheduleSave.versions = scheduleSave.versions || new Map();
  scheduleSave.versions.set(key, version);

  clearTimeout(state.timers.get(key));
  setStatus(nmId, field, "saving", "待保存");

  const timer = setTimeout(async () => {
    try {
      const body = { [field]: normalizePatchValue(field, value) };
      const res = await fetch(`${API_BASE}/api/wb/products/${encodeURIComponent(nmId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error(`保存失败 ${res.status}`);

      const payload = await res.json();
      if (!payload.ok) throw new Error(payload.error || "保存失败");

      if (scheduleSave.versions.get(key) !== version) return;
      setStatus(nmId, field, "saved", "已保存");
      setTimeout(() => {
        if (scheduleSave.versions.get(key) === version) setStatus(nmId, field, "", "");
      }, 1200);
    } catch (error) {
      setStatus(nmId, field, "error", error.message);
    }
  }, 1200);

  state.timers.set(key, timer);
}

function handleEdit(event) {
  const target = event.target.closest("[data-wb-id][data-wb-field]");
  if (!target) return;

  const nmId = target.dataset.wbId;
  const field = target.dataset.wbField;
  const item = getProduct(nmId);
  if (!item) return;

  const value = target.isContentEditable ? target.textContent : target.value;
  item[field] = value;
  updateRowProfit(nmId);
  scheduleSave(nmId, field, value);
}

function renderTrend(rows, nmId) {
  $("trendTitle").textContent = `${nmId} - WB \u8fd1 30 \u5929\u9500\u91cf\u52a8\u6001`;

  if (!rows.length) {
    $("trendChart").innerHTML = `<div class="trend-empty">\u6682\u65e0 WB \u9500\u91cf\u52a8\u6001\u6570\u636e</div>`;
    return;
  }

  const normalizedRows = rows.map(item => ({
    metric_date: item.metric_date,
    sales_units: Number(item.sales_units || 0)
  }));
  const currentRows = normalizedRows.slice(-30);
  const previousRows = normalizedRows.slice(-60, -30);
  const currentTotal = currentRows.reduce((sum, item) => sum + Number(item.sales_units || 0), 0);
  const previousTotal = previousRows.reduce((sum, item) => sum + Number(item.sales_units || 0), 0);

  const width = 760;
  const height = 250;
  const padding = { left: 42, right: 24, top: 16, bottom: 34 };
  const points = currentRows.map((item, index) => ({
    index,
    date: String(item.metric_date || "").slice(5, 10),
    sales: Number(item.sales_units || 0)
  }));
  const maxSales = Math.max(1, ...points.map(point => point.sales));
  const x = index => padding.left + (points.length === 1 ? 0 : index * (width - padding.left - padding.right) / (points.length - 1));
  const y = value => height - padding.bottom - value / maxSales * (height - padding.top - padding.bottom);
  const line = points.map(point => `${x(point.index)},${y(point.sales)}`).join(" ");
  const ticks = buildSalesTicks(maxSales);

  $("trendChart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img">
      ${ticks.map(t => `
        <line class="grid-line" x1="${padding.left}" y1="${y(t)}" x2="${width - padding.right}" y2="${y(t)}"></line>
        <text class="axis-label" x="${padding.left - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>
      `).join("")}
      <line class="axis" x1="${padding.left}" y1="${height - padding.bottom}" x2="${width - padding.right}" y2="${height - padding.bottom}"></line>
      <line class="axis" x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${height - padding.bottom}"></line>
      <polyline class="sales-line" fill="none" points="${line}"></polyline>
      ${points.map(point => `
        <circle class="sales-point" cx="${x(point.index)}" cy="${y(point.sales)}" r="4"></circle>
        <text class="axis-label" x="${x(point.index)}" y="${height - 10}" text-anchor="middle">${point.date}</text>
      `).join("")}
    </svg>
    <div class="trend-summary">
      <span>\u8fd1 30 \u5929\u8ba2\u5355\u6570\uff1a${currentTotal}</span>
      <span>\u4e0a\u4e2a 30 \u5929\u8ba2\u5355\u6570\uff1a${previousTotal}</span>
    </div>
  `;
}

async function loadMetrics(nmId) {
  if (!nmId) return;
  nmId = String(nmId);
  state.selectedNmId = nmId;

  document.querySelectorAll("[data-wb-row]").forEach(row => {
    row.classList.toggle("selected-row", String(row.dataset.wbRow) === nmId);
  });

  const product = getProduct(nmId);
  const label = product ? (product.vendor_code || product.title || nmId) : nmId;
  $("trendTitle").textContent = label + " - WB 近 30 天销量动态";
  $("trendChart").innerHTML = '<div class="trend-empty">正在加载动态数据...</div>';

  const res = await fetch(`${API_BASE}/api/wb/metrics/${encodeURIComponent(nmId)}?days=60`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "WB 动态加载失败");

  state.metrics = payload.data || [];
  renderTrend(state.metrics, nmId);
}

async function syncWbStocks() {
  const btn = $("syncWbStockBtn");
  btn.disabled = true;
  btn.textContent = "同步库存中...";
  try {
    const res = await fetch(`${API_BASE}/api/sync/wb/stocks`, { method: "POST" });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "WB库存同步失败");
    await loadDashboard();
  } catch (error) {
    showToast(`WB库存同步失败：${error.message}，继续显示上次缓存数据`);
  } finally {
    btn.disabled = false;
    btn.textContent = "同步WB库存";
  }
}

async function syncWb() {
  const btn = $("syncWbBtn");
  btn.disabled = true;
  btn.textContent = "同步中...";
  try {
    const res = await fetch(`${API_BASE}/api/sync/wb?days=3`, { method: "POST" });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "WB 同步失败");
    showToast(payload.data?.message || "WB 同步已提交后台任务，继续显示缓存数据");
    loadSyncStatus().catch(() => {});
    setTimeout(() => loadSyncStatus().catch(() => {}), 2500);
    setTimeout(() => loadDashboard().catch(() => {}), 1500);
  } catch (error) {
    showToast(`WB同步失败：${error.message}，继续显示上次缓存数据`);
  } finally {
    btn.disabled = false;
    btn.textContent = "同步WB";
  }
}

$("refreshBtn").addEventListener("click", () => {
  loadDashboard().catch(error => showToast(error.message));
});

document.getElementById("syncWbBtn")?.addEventListener("click", syncWb);
$("syncStatusRefreshBtn")?.addEventListener("click", () => loadSyncStatus().catch(error => showToast(error.message)));
document.getElementById("syncWbStockBtn")?.addEventListener("click", syncWbStocks);

$("wbBusinessMonthSelect")?.addEventListener("change", event => {
  const month = event.target.value;
  if (!availableBusinessMonths().has(month)) {
    showToast("该月份尚未同步");
    renderBusinessMonthControls();
    return;
  }
  loadBusinessReport(month).catch(error => showToast(error.message));
});

$("wbBusinessPrevMonth")?.addEventListener("click", () => {
  const month = monthOffset(state.businessMonth, -1);
  if (!availableBusinessMonths().has(month)) return showToast("该月份尚未同步");
  loadBusinessReport(month).catch(error => showToast(error.message));
});

$("wbBusinessNextMonth")?.addEventListener("click", () => {
  const month = monthOffset(state.businessMonth, 1);
  if (!availableBusinessMonths().has(month)) return showToast("该月份尚未同步");
  loadBusinessReport(month).catch(error => showToast(error.message));
});

$("searchInput").addEventListener("input", event => {
  state.search = event.target.value;
  renderTable();
});

$("salesSort").addEventListener("change", event => {
  state.salesSort = event.target.value;
  renderTable();
});

ensureWbSubnav();

if ($("metricDateInput")) {
  $("metricDateInput").value = state.metricDate;
  $("metricDateInput").addEventListener("change", event => {
    state.metricDate = formatDateKey(event.target.value) || defaultMetricDate();
    loadDashboard().catch(error => showToast(error.message));
  });
}

document.addEventListener("input", handleEdit);

document.addEventListener("click", event => {
  if (event.target.closest("[data-wb-id][data-wb-field], input, textarea, [contenteditable='true'], button, select, label")) return;
  const row = event.target.closest("[data-wb-row]");
  if (!row) return;
  loadMetrics(row.dataset.wbRow).catch(error => showToast(error.message));
});

loadSyncStatus().catch(() => {});
loadSyncStatus().catch(() => {});
loadBusinessData().catch(error => showToast(error.message));
loadDashboard().catch(error => {
  $("syncText").textContent = "WB 加载失败";
  showToast(error.message);
});

(function forceWbStrategyColumnWidth() {
  function apply() {
    const headers = Array.from(document.querySelectorAll("#tableHead th"));
    const strategyIndex = headers.findIndex(th => th.textContent.includes("产品策略"));
    if (strategyIndex < 0) return;

    headers[strategyIndex].classList.add("strategy-cell");
    document.querySelectorAll("#productBody tr").forEach(row => {
      if (row.cells[strategyIndex]) row.cells[strategyIndex].classList.add("strategy-cell");
    });
  }

  new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
  requestAnimationFrame(apply);
  setTimeout(apply, 500);
})();



function installWbMetricClickFix() {
  const body = $("productBody");
  if (!body || body.dataset.metricClickFix === "1") return;
  body.dataset.metricClickFix = "1";

  body.addEventListener("click", event => {
    if (event.target.closest("[data-wb-id][data-wb-field], input, textarea, [contenteditable='true'], button, select, label, a")) return;

    const row = event.target.closest("[data-wb-row]");
    if (!row || !row.dataset.wbRow) return;

    loadMetrics(row.dataset.wbRow).catch(error => {
      $("trendChart").innerHTML = '<div class="trend-empty">WB 动态加载失败：' + escapeHtml(error.message) + '</div>';
      showToast(error.message);
    });
  });
}

installWbMetricClickFix();
document.addEventListener("DOMContentLoaded", installWbMetricClickFix);

(function installMappingDialog() {
  const mappingState = { rows: [], search: "" };

  function mappingNodes() {
    return {
      dialog: document.getElementById("mappingDialog"),
      open: document.getElementById("mappingBtn"),
      close: document.getElementById("closeMappingBtn"),
      refresh: document.getElementById("refreshMappingBtn"),
      add: document.getElementById("addMappingBtn"),
      search: document.getElementById("mappingSearchInput"),
      local: document.getElementById("newLocalNmId"),
      cross: document.getElementById("newCrossNmId"),
      body: document.getElementById("mappingBody")
    };
  }

  function mappingText(row) {
    return [
      row.wb_nm_id,
      row.wb_vendor_code,
      row.wb_title,
      row.wb_cross_nm_id,
      row.wb_cross_vendor_code,
      row.wb_cross_title
    ].map(value => String(value || "").toLowerCase()).join(" ");
  }

  function renderMappings() {
    const nodes = mappingNodes();
    if (!nodes.body) return;
    const term = mappingState.search.trim().toLowerCase();
    const rows = term ? mappingState.rows.filter(row => mappingText(row).includes(term)) : mappingState.rows;
    nodes.body.innerHTML = rows.map(row => `
      <tr>
        <td>
          <strong>${escapeHtml(row.wb_vendor_code || row.wb_nm_id)}</strong>
          <span>${escapeHtml(row.wb_nm_id || "")}</span>
          <small>${escapeHtml(row.wb_title || "")}</small>
        </td>
        <td>
          <strong>${escapeHtml(row.wb_cross_vendor_code || row.wb_cross_nm_id)}</strong>
          <span>${escapeHtml(row.wb_cross_nm_id || "")}</span>
          <small>${escapeHtml(row.wb_cross_title || "")}</small>
        </td>
        <td>${row.updated_at ? new Date(row.updated_at).toLocaleString() : ""}</td>
        <td><button type="button" class="secondary mapping-delete" data-mapping-id="${escapeHtml(row.id)}">\u5220\u9664</button></td>
      </tr>
    `).join("") || `<tr><td colspan="4">No mappings</td></tr>`;
  }

  async function loadMappings() {
    const res = await fetch(`${API_BASE}/api/wb/mappings`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "Mapping load failed");
    mappingState.rows = payload.data || [];
    renderMappings();
  }

  async function addMapping() {
    const nodes = mappingNodes();
    const wbNmId = nodes.local.value.trim();
    const wbCrossNmId = nodes.cross.value.trim();
    if (!wbNmId || !wbCrossNmId) {
      showToast("Please enter local nm_id and cross-border nm_id");
      return;
    }

    const res = await fetch(`${API_BASE}/api/wb/mappings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wb_nm_id: wbNmId, wb_cross_nm_id: wbCrossNmId })
    });
    const payload = await res.json();
    if (!res.ok || !payload.ok) throw new Error(payload.error || "\u6620\u5c04\u4fdd\u5b58\u5931\u8d25");
    nodes.local.value = "";
    nodes.cross.value = "";
    await loadMappings();
    showToast("\u6620\u5c04\u5df2\u4fdd\u5b58");
  }

  async function deleteMapping(id) {
    const res = await fetch(`${API_BASE}/api/wb/mappings/${encodeURIComponent(id)}`, { method: "DELETE" });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) throw new Error(payload.error || "\u6620\u5c04\u5220\u9664\u5931\u8d25");
    await loadMappings();
    showToast("\u6620\u5c04\u5df2\u5220\u9664");
  }

  function bind() {
    const nodes = mappingNodes();
    if (!nodes.dialog || nodes.dialog.dataset.bound === "1") return;
    nodes.dialog.dataset.bound = "1";

    nodes.open?.addEventListener("click", () => {
      nodes.dialog.showModal();
      loadMappings().catch(error => showToast(error.message));
    });
    nodes.close?.addEventListener("click", () => nodes.dialog.close());
    nodes.refresh?.addEventListener("click", () => loadMappings().catch(error => showToast(error.message)));
    nodes.add?.addEventListener("click", () => addMapping().catch(error => showToast(error.message)));
    nodes.search?.addEventListener("input", event => {
      mappingState.search = event.target.value;
      renderMappings();
    });
    nodes.body?.addEventListener("click", event => {
      const button = event.target.closest("[data-mapping-id]");
      if (!button) return;
      deleteMapping(button.dataset.mappingId).catch(error => showToast(error.message));
    });
  }

  bind();
  document.addEventListener("DOMContentLoaded", bind);
})();
