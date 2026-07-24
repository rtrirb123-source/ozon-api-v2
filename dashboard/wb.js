const API_BASE = "";
const state = {
  products: [],
  summary: {},
  metrics: [],
  storeMetrics: [],
  selectedNmId: "",
  search: "",
  salesSort: "desc",
  metricDate: defaultMetricDate(),
  timers: new Map(),
  statuses: new Map(),
  rubToCny: 9.07 / 100
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
  const adRub = priceRub * toNumber(item.ad_ratio) / 100;
  const returnRub = priceRub * toNumber(item.return_rate) / 100;
  const tailRub = priceRub * 0.14;
  const taxRub = priceRub * 0.12;
  const acquiringRub = priceRub * 0.02;
  const remainingRub = priceRub - commissionRub - adRub - returnRub - tailRub - taxRub - acquiringRub;
  const remittanceRub = remainingRub * 0.06;

  const incomeCny = priceRub * rubToCny;
  const platformCny = (commissionRub + adRub + returnRub + tailRub + taxRub + acquiringRub + remittanceRub) * rubToCny;
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
      <th>广告比例</th>
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
      <td>${renderInput(item, "ad_ratio")}</td>
      <td class="profit-cell">${escapeHtml(expectedProfit(item))}</td>
      <td class="competitor-cell">${renderText(item, "competitor_compare")}</td>
      <td>${renderText(item, "strategy")}</td>
    </tr>
  `);

  $("productBody").innerHTML = rows.join("") || `<tr><td colspan="17">暂无 WB 商品数据。WB API 可能仍在限流，稍后点击“同步WB”。</td></tr>`;
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
}

function render() {
  renderStats();
  renderTable();
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

$("searchInput").addEventListener("input", event => {
  state.search = event.target.value;
  renderTable();
});

$("salesSort").addEventListener("change", event => {
  state.salesSort = event.target.value;
  renderTable();
});

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
