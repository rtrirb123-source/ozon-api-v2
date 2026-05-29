const API_BASE = "https://ozon-api-v2-production.up.railway.app";
const dashboardUrl = `${API_BASE}/api/dashboard`;
const columnsKey = "ozon-dashboard-visible-columns";
const dashboardCacheKey = "ozon-dashboard-cache-v1";

const state = {
  products: [],
  summary: {},
  selectedOfferId: "",
  metrics: [],
  search: "",
  salesSort: "desc",
  timers: new Map(),
  versions: new Map(),
  statuses: new Map(),
  visibleColumns: new Set()
};

const editableFields = [
  "commission_rate",
  "purchase_cost",
  "weight",
  "freight_rate",
  "return_rate",
  "price",
  "ad_ratio",
  "competitor_compare",
  "strategy",
  "image_url"
];

const columns = [
  { key: "product", label: "商品", fixed: true },
  { key: "ozon_sku", label: "Ozon SKU" },
  { key: "image_url", label: "图片" },
  { key: "fbo_stock", label: "FBO库存数" },
  { key: "fbs_stock", label: "FBS库存数" },
  { key: "yesterday_sales", label: "昨日销量" },
  { key: "commission_rate", label: "佣金率", type: "number" },
  { key: "purchase_cost", label: "采购成本", type: "number" },
  { key: "weight", label: "重量", type: "number" },
  { key: "freight_rate", label: "运费系数", type: "number" },
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

function formatValue(value) {
  return value === null || value === undefined ? "" : String(value);
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
}

function saveVisibleColumns() {
  localStorage.setItem(columnsKey, JSON.stringify(Array.from(state.visibleColumns)));
}

function visibleColumns() {
  return columns.filter((column) => state.visibleColumns.has(column.key));
}

async function loadDashboard() {
  setSyncText("正在加载数据...");
  renderCachedDashboard();
  const response = await fetch(dashboardUrl);
  if (!response.ok) throw new Error(`加载失败：${response.status}`);
  const payload = await response.json();
  localStorage.setItem(dashboardCacheKey, JSON.stringify(payload));
  state.products = payload.data.products || [];
  state.summary = payload.data.summary || {};
  if (!state.selectedOfferId && state.products[0]) {
    state.selectedOfferId = state.products[0].offer_id;
    loadMetrics(state.selectedOfferId).catch(() => {});
  }
  render();
  setSyncText(`已加载 ${state.products.length} 个商品，更新时间 ${new Date(payload.data.fetchedAt).toLocaleString()}`);
}

function renderCachedDashboard() {
  if (state.products.length) return;
  try {
    const payload = JSON.parse(localStorage.getItem(dashboardCacheKey) || "null");
    if (!payload?.data?.products?.length) return;
    state.products = payload.data.products || [];
    state.summary = payload.data.summary || {};
    if (!state.selectedOfferId && state.products[0]) state.selectedOfferId = state.products[0].offer_id;
    render();
    setSyncText(`先显示缓存数据 ${state.products.length} 个商品，正在后台刷新...`);
  } catch {
    localStorage.removeItem(dashboardCacheKey);
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
    ["总售价", summary.totalPrice || 0],
    ["缺图片", summary.missingImageCount || 0],
    ["缺竞品", summary.missingCompetitorCount || 0],
    ["缺售价", summary.missingPriceCount || 0],
    ["缺佣金", summary.missingCommissionCount || 0]
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
    return `
      <textarea class="editable-text" data-offer="${escapeHtml(product.offer_id)}" data-field="${field}">${escapeHtml(value)}</textarea>
      <div class="status ${status.status}" data-status="${escapeHtml(key)}">${escapeHtml(status.text)}</div>
    `;
  }

  return `
    <input class="editable" type="${type}" value="${escapeHtml(value)}" data-offer="${escapeHtml(product.offer_id)}" data-field="${field}" />
    <div class="status ${status.status}" data-status="${escapeHtml(key)}">${escapeHtml(status.text)}</div>
  `;
}

function expectedProfit(product) {
  const price = toNumber(product.price);
  if (!price) return "";
  const purchase = toNumber(product.purchase_cost);
  const commission = price * toNumber(product.commission_rate) / 100;
  const ad = price * toNumber(product.ad_ratio) / 100;
  const returns = price * toNumber(product.return_rate) / 100;
  const freight = (toNumber(product.weight) / 1000) * toNumber(product.freight_rate);
  return (price - purchase - commission - ad - returns - freight).toFixed(2);
}

function renderImage(product) {
  const image = product.image_url;
  return `
    ${image ? `<img class="image-preview" src="${escapeHtml(image)}" alt="${escapeHtml(product.offer_id)}" loading="lazy" decoding="async" />` : `<div class="image-empty">无图片</div>`}
    ${renderInput(product, "image_url")}
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
  if (column.key === "image_url") return `<td class="image-cell">${renderImage(product)}</td>`;
  if (column.key === "expected_profit") return `<td class="profit-cell">${escapeHtml(expectedProfit(product))}</td>`;
  if (column.key === "status") return `<td class="status">${product.updated_at ? new Date(product.updated_at).toLocaleString() : ""}</td>`;
  if (editableFields.includes(column.key)) return `<td>${renderInput(product, column.key, column.type || "text")}</td>`;
  return `<td>${escapeHtml(formatValue(product[column.key]))}</td>`;
}

function renderTable() {
  const activeColumns = visibleColumns();
  $("tableHead").innerHTML = `<tr>${activeColumns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`;
  const rows = sortedProducts().map((product) => `
    <tr class="${product.offer_id === state.selectedOfferId ? "selected-row" : ""}" data-row-offer="${escapeHtml(product.offer_id)}">
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
}

function normalizePatchValue(field, value) {
  if (field === "competitor_compare" || field === "image_url" || field === "strategy") return value;
  if (value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function renderTrend() {
  const chart = $("trendChart");
  if (!chart) return;
  if (!state.metrics.length) {
    chart.innerHTML = `<div class="trend-empty">暂无动态数据</div>`;
    return;
  }

  const width = 760;
  const height = 250;
  const padding = { left: 42, right: 36, top: 16, bottom: 34 };
  const points = state.metrics.map((item, index) => ({
    index,
    sales: Number(item.sales_units || 0),
    ad: Number(item.ad_ratio || 0)
  }));
  const maxSales = Math.max(1, ...points.map((point) => point.sales));
  const maxAd = Math.max(1, ...points.map((point) => point.ad));
  const x = (index) => padding.left + (points.length === 1 ? 0 : (index * (width - padding.left - padding.right)) / (points.length - 1));
  const ySales = (value) => height - padding.bottom - (value / maxSales) * (height - padding.top - padding.bottom);
  const yAd = (value) => height - padding.bottom - (value / maxAd) * (height - padding.top - padding.bottom);
  const salesTicks = [0, Math.ceil(maxSales / 2), Math.ceil(maxSales)];
  const adTicks = [0, Math.ceil(maxAd / 2), Math.ceil(maxAd)];
  const dateTicks = points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index === 0 || index === points.length - 1 || index === Math.floor((points.length - 1) / 2));
  const yGrid = salesTicks.map((tick) => `
    <line class="grid-line" x1="${padding.left}" y1="${ySales(tick)}" x2="${width - padding.right}" y2="${ySales(tick)}"></line>
    <text class="axis-label" x="${padding.left - 8}" y="${ySales(tick) + 4}" text-anchor="end">${tick}</text>
  `).join("");
  const adLabels = adTicks.map((tick) => `
    <text class="axis-label ad-axis-label" x="${width - padding.right + 8}" y="${yAd(tick) + 4}">${tick}%</text>
  `).join("");
  const xLabels = dateTicks.map(({ point, index }) => {
    const label = String(point.date || "").slice(5, 10);
    return `<text class="axis-label" x="${x(index)}" y="${height - 10}" text-anchor="middle">${label}</text>`;
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
    Object.assign(product, payload.data);
    product[field] = normalizePatchValue(field, value);
  }
  setStatus(offerId, field, "saved", "已保存");
  if (field === "image_url") render();
  if (["price", "purchase_cost", "commission_rate", "ad_ratio", "return_rate", "freight_rate", "weight"].includes(field)) renderTable();
}

function scheduleSave(offerId, field, value) {
  const key = statusKey(offerId, field);
  const version = bumpVersion(offerId, field);
  clearTimeout(state.timers.get(key));
  state.timers.set(
    key,
    setTimeout(async () => {
      try {
        await saveField(offerId, field, value, version);
      } catch (error) {
        if (state.versions.get(key) === version) {
          setStatus(offerId, field, "error", "保存失败");
          showToast(`${fieldLabels[field] || field} 保存失败：${error.message}`);
        }
      }
    }, 700)
  );
}

function handleEdit(event) {
  const target = event.target;
  if (!target.matches("[data-offer][data-field]")) return;
  const offerId = target.dataset.offer;
  const field = target.dataset.field;
  const product = getProduct(offerId);
  if (!product || !editableFields.includes(field)) return;
  product[field] = target.value;
  setStatus(offerId, field, "saving", "待保存");
  scheduleSave(offerId, field, target.value);
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
  await loadDashboard();
}

loadVisibleColumns();
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
  const row = event.target.closest("[data-row-offer]");
  if (!row) return;
  const offerId = row.dataset.rowOffer;
  if (!offerId || offerId === state.selectedOfferId) return;
  state.selectedOfferId = offerId;
  renderTable();
  loadMetrics(offerId).catch((error) => showToast(error.message));
});
$("refreshBtn").addEventListener("click", () => loadDashboard().catch((error) => showToast(error.message)));
$("searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderTable();
});
$("salesSort").addEventListener("change", (event) => {
  state.salesSort = event.target.value;
  renderTable();
});
$("addBtn").addEventListener("click", () => $("addDialog").showModal());
$("cancelAddBtn").addEventListener("click", () => $("addDialog").close());
$("addDialog").querySelector("form").addEventListener("submit", addProduct);

loadDashboard().catch((error) => {
  setSyncText("加载失败");
  showToast(error.message);
});
