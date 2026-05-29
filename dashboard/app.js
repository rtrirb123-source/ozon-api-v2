const API_BASE = "https://ozon-api-v2-production.up.railway.app";
const dashboardUrl = `${API_BASE}/api/dashboard`;

const state = {
  products: [],
  summary: {},
  selectedOfferId: "",
  metrics: [],
  search: "",
  timers: new Map(),
  versions: new Map(),
  statuses: new Map()
};

const fields = [
  "commission_rate",
  "purchase_cost",
  "weight",
  "freight_rate",
  "return_rate",
  "ad_ratio",
  "price",
  "strategy",
  "competitor_compare",
  "image_url"
];

const fieldLabels = {
  commission_rate: "佣金率",
  purchase_cost: "采购成本",
  weight: "重量",
  freight_rate: "运费系数",
  return_rate: "退货率",
  ad_ratio: "广告比例",
  price: "售价",
  strategy: "产品策略",
  competitor_compare: "竞品对比",
  image_url: "商品图片"
};

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

async function loadDashboard() {
  setSyncText("正在加载数据...");
  const response = await fetch(dashboardUrl);
  if (!response.ok) {
    throw new Error(`加载失败：${response.status}`);
  }
  const payload = await response.json();
  state.products = payload.data.products || [];
  state.summary = payload.data.summary || {};
  if (!state.selectedOfferId && state.products[0]) {
    state.selectedOfferId = state.products[0].offer_id;
    loadMetrics(state.selectedOfferId).catch(() => {});
  }
  render();
  setSyncText(`已加载 ${state.products.length} 个商品，更新时间 ${new Date(payload.data.fetchedAt).toLocaleString()}`);
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
  return [
    product.offer_id,
    product.product_id,
    product.title,
    product.strategy,
    product.competitor_compare
  ].some((value) => String(value || "").toLowerCase().includes(term));
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

function renderImage(product) {
  const image = product.image_url;
  return `
    ${image ? `<img class="image-preview" src="${escapeHtml(image)}" alt="${escapeHtml(product.offer_id)}" />` : `<div class="image-empty">无图片</div>`}
    ${renderInput(product, "image_url")}
  `;
}

function renderTable() {
  const rows = state.products.filter(productMatches).map((product) => `
    <tr class="${product.offer_id === state.selectedOfferId ? "selected-row" : ""}" data-row-offer="${escapeHtml(product.offer_id)}">
      <td class="product-cell">
        <strong>${escapeHtml(product.offer_id)}</strong>
        <span>${escapeHtml(product.product_id)}</span>
      </td>
      <td>${escapeHtml(product.ozon_sku)}</td>
      <td class="image-cell">${renderImage(product)}</td>
      <td>${renderInput(product, "commission_rate", "number")}</td>
      <td>${renderInput(product, "purchase_cost", "number")}</td>
      <td>${renderInput(product, "weight", "number")}</td>
      <td>${renderInput(product, "freight_rate", "number")}</td>
      <td>${renderInput(product, "return_rate", "number")}</td>
      <td>${renderInput(product, "ad_ratio", "number")}</td>
      <td>${renderInput(product, "price", "number")}</td>
      <td>${renderInput(product, "strategy")}</td>
      <td>${renderInput(product, "competitor_compare")}</td>
      <td class="status">${product.updated_at ? new Date(product.updated_at).toLocaleString() : ""}</td>
    </tr>
  `);

  $("productBody").innerHTML = rows.join("") || `<tr><td colspan="13">没有匹配商品</td></tr>`;
}

function render() {
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
  const height = 220;
  const padding = 28;
  const points = state.metrics.map((item, index) => ({
    index,
    date: item.metric_date,
    sales: Number(item.sales_units || 0),
    ad: Number(item.ad_ratio || 0)
  }));
  const maxSales = Math.max(1, ...points.map((point) => point.sales));
  const maxAd = Math.max(1, ...points.map((point) => point.ad));
  const x = (index) => padding + (points.length === 1 ? 0 : (index * (width - padding * 2)) / (points.length - 1));
  const ySales = (value) => height - padding - (value / maxSales) * (height - padding * 2);
  const yAd = (value) => height - padding - (value / maxAd) * (height - padding * 2);
  const salesPath = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${ySales(point.sales).toFixed(2)}`).join(" ");
  const adPath = points.map((point, index) => `${index ? "L" : "M"} ${x(index).toFixed(2)} ${yAd(point.ad).toFixed(2)}`).join(" ");
  const bars = points.map((point, index) => {
    const barHeight = height - padding - ySales(point.sales);
    return `<rect x="${x(index) - 4}" y="${ySales(point.sales)}" width="8" height="${barHeight}" rx="2"></rect>`;
  }).join("");

  chart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="近 30 天销量和广告比例">
      <line class="axis" x1="${padding}" y1="${height - padding}" x2="${width - padding}" y2="${height - padding}"></line>
      <g class="sales-bars">${bars}</g>
      <path class="sales-line" d="${salesPath}"></path>
      <path class="ad-line" d="${adPath}"></path>
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
  if (!response.ok) {
    throw new Error(`保存失败：${response.status}`);
  }
  const payload = await response.json();
  if (state.versions.get(statusKey(offerId, field)) !== version) return;
  const product = getProduct(offerId);
  if (product && payload.data) {
    Object.assign(product, payload.data);
    product[field] = normalizePatchValue(field, value);
  }
  setStatus(offerId, field, "saved", "已保存");
  if (field === "image_url") render();
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
  if (!product || !fields.includes(field)) return;
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

document.addEventListener("input", handleEdit);
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
$("addBtn").addEventListener("click", () => $("addDialog").showModal());
$("cancelAddBtn").addEventListener("click", () => $("addDialog").close());
$("addDialog").querySelector("form").addEventListener("submit", addProduct);

loadDashboard().catch((error) => {
  setSyncText("加载失败");
  showToast(error.message);
});
