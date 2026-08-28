const state = { payload: null, search: "", filter: "all" };

const $ = (id) => document.getElementById(id);
const num = (value) => Number(value) || 0;
const money = (value) => `R${num(value).toLocaleString("en-ZA", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const integer = (value) => Math.round(num(value)).toLocaleString("en-ZA");
const percent = (value, inputIsRatio = false) => `${(num(value) * (inputIsRatio ? 100 : 1)).toFixed(1)}%`;
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function stat(label, value, note, className = "") {
  return `<article class="stat-card ${className}"><span class="stat-label">${label}</span><strong class="stat-value">${value}</strong><span class="stat-note">${note}</span></article>`;
}

function renderStats(summary) {
  $("stats").innerHTML = [
    stat("30天销售额", money(summary.revenue30), `${integer(summary.units30)} 件成交`, "good"),
    stat("API实际销售费用", money(summary.actualFees30), "来自 sales.total_fees"),
    stat("平台回款前余额", money(summary.platformReceivable30), "未扣采购/头程/广告/税"),
    stat("30天退货率", percent(summary.returnRate30, true), `${integer(summary.returnQuantity30)} 件退货`, summary.returnRate30 >= .05 ? "warn" : ""),
    stat("可售 Offer", `${integer(summary.buyableOffers)} / ${integer(summary.offerCount)}`, "当前可售 / 全部"),
    stat("现货库存", `${integer(summary.availableStock)} 件`, "Takealot 三地仓", "good"),
    stat("在途+收货中", `${integer(summary.onWayStock)} 件`, "stock_on_way + receiving"),
    stat("低库存 Offer", `${integer(summary.lowStockOffers)} 个`, "0库存或不足14天", summary.lowStockOffers ? "warn" : ""),
  ].join("");
}

function linePath(points, width, height, max) {
  if (!points.length) return "";
  return points.map((value, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - (num(value) / Math.max(max, 1)) * height;
    return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
}

function renderTrend(trend) {
  const width = 1200, height = 210, top = 10, left = 48;
  const units = trend.map((row) => row.units), revenue = trend.map((row) => row.revenue);
  const maxUnits = Math.max(...units, 1), maxRevenue = Math.max(...revenue, 1);
  const unitsPath = linePath(units, width, height, maxUnits);
  const revenuePath = linePath(revenue, width, height, maxRevenue);
  const grid = [0, .25, .5, .75, 1].map((ratio) => {
    const y = top + height - ratio * height;
    return `<line class="chart-grid" x1="${left}" y1="${y}" x2="${left + width}" y2="${y}"/><text class="chart-label" x="4" y="${y + 4}">${Math.round(maxUnits * ratio)}</text>`;
  }).join("");
  const labels = trend.map((row, index) => index % 5 === 0 || index === trend.length - 1
    ? `<text class="chart-label" x="${left + index / (trend.length - 1) * width}" y="248" text-anchor="middle">${row.date.slice(5)}</text>` : "").join("");
  $("trendChart").innerHTML = `<svg viewBox="0 0 1270 260" role="img"><g>${grid}</g><g transform="translate(${left},${top})"><path class="sales-area" d="${unitsPath} L${width},${height} L0,${height} Z"/><path class="sales-line" d="${unitsPath}"/><path class="revenue-line" d="${revenuePath}"/></g>${labels}<text class="chart-label" x="1260" y="18" text-anchor="end">销售额峰值 ${money(maxRevenue)}</text></svg>`;
}

function renderAlerts(products) {
  const rows = products.filter((item) => item.alerts.length).sort((a, b) => b.alerts.length - a.alerts.length || b.revenue30 - a.revenue30).slice(0, 8);
  $("alerts").innerHTML = rows.length ? rows.map((item) => `<div class="alert-row"><div><strong>${escapeHtml(item.title || item.sku)}</strong><span class="subtext">${escapeHtml(item.sku)} · Offer ${item.offerId}</span></div><div class="alert-tags">${item.alerts.map((alert) => `<span class="tag">${escapeHtml(alert)}</span>`).join("")}</div></div>`).join("") : `<div class="empty">当前没有优先级警报。</div>`;
}

function renderRegions(products) {
  const regions = ["JHB", "CPT", "DBN"].map((code) => products.reduce((result, item) => {
    const row = item.stock.regions[code] || {};
    result.available += num(row.available); result.onWay += num(row.onWay); result.receiving += num(row.receiving); result.sold30 += num(row.sold30);
    return result;
  }, { code, available: 0, onWay: 0, receiving: 0, sold30: 0 }));
  $("regionalStock").innerHTML = regions.map((row) => `<div class="region-card"><b>${row.code}</b><dl><dt>现货</dt><dd>${integer(row.available)}</dd><dt>在途</dt><dd>${integer(row.onWay)}</dd><dt>收货中</dt><dd>${integer(row.receiving)}</dd><dt>30天售出</dt><dd>${integer(row.sold30)}</dd></dl></div>`).join("");
}

function actionText(item) {
  if (item.status !== "buyable") return "查看不可售原因并恢复 Offer";
  if (item.stock.available === 0) return item.stock.onWay + item.stock.receiving > 0 ? "跟进在途/收货入库" : "立即安排补货";
  if (item.stock.coverDays !== null && item.stock.coverDays < 14) return "补货至至少30天覆盖";
  if (item.returnRate30 >= .05) return "按退货原因修正产品或页面";
  if (item.conversion30 < item.previousConversion30) return "检查主图、售价与基准价";
  if (item.listingQuality > 0 && item.listingQuality < 80) return "补全 Listing 质量得分";
  return "保持价格与库存，继续观察";
}

function productMatches(item) {
  const q = state.search.toLowerCase();
  if (q && ![item.title, item.sku, item.offerId, item.tsinId, item.barcode].some((value) => String(value || "").toLowerCase().includes(q))) return false;
  if (state.filter === "buyable" && item.status !== "buyable") return false;
  if (state.filter === "risk" && !item.alerts.length) return false;
  if (state.filter === "low-stock" && !item.alerts.some((alert) => alert.includes("库存"))) return false;
  return true;
}

function renderProducts(products) {
  const visible = products.filter(productMatches);
  $("resultCount").textContent = `显示 ${visible.length} / ${products.length} 个 Offer`;
  $("productBody").innerHTML = visible.length ? visible.map((item) => {
    const cover = item.stock.coverDays === null ? "无销量基准" : `${item.stock.coverDays.toFixed(1)} 天`;
    const growth = item.salesGrowth30 === null ? "无上期基准" : `${item.salesGrowth30 >= 0 ? "+" : ""}${percent(item.salesGrowth30, true)}`;
    const topReason = Object.entries(item.returnReasons).sort((a, b) => b[1] - a[1])[0];
    return `<tr>
      <td><div class="product-cell"><img src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy"/><div><span class="product-title">${escapeHtml(item.title || item.sku)}</span><span class="subtext">${escapeHtml(item.sku)} · Offer ${item.offerId}</span></div></div></td>
      <td><span class="status-pill ${item.status === "buyable" ? "" : "off"}">${escapeHtml(item.status || "未知")}</span>${item.replenishmentBlocks.length ? `<span class="subtext warning">有补货限制</span>` : ""}</td>
      <td><span class="metric-main">${money(item.price)}</span><span class="subtext">基准 ${item.benchmarkPrice ? money(item.benchmarkPrice) : "—"} · RRP ${money(item.rrp)}</span></td>
      <td><span class="metric-main">${integer(item.units7)} / ${integer(item.units30)}</span><span class="subtext ${num(item.salesGrowth30) >= 0 ? "positive" : "negative"}">环比 ${growth}</span></td>
      <td><span class="metric-main">${money(item.revenue30)}</span><span class="subtext">实际费用 ${money(item.actualFees30)}</span></td>
      <td><span class="metric-main">${integer(item.stock.available)} / ${integer(item.stock.onWay + item.stock.receiving)}</span><span class="subtext">JHB ${integer(item.stock.regions.JHB.available)} · CPT ${integer(item.stock.regions.CPT.available)} · DBN ${integer(item.stock.regions.DBN.available)}</span></td>
      <td><span class="metric-main ${item.stock.coverDays !== null && item.stock.coverDays < 14 ? "negative" : ""}">${cover}</span><span class="subtext">30天售出 ${integer(item.stock.sold30)}</span></td>
      <td><span class="metric-main">${integer(item.pageViews30)} / ${percent(item.conversion30)}</span><span class="subtext">上期转化 ${percent(item.previousConversion30)} · 愿望单 +${integer(item.wishlist30)}</span></td>
      <td><div class="fee-lines">佣金 ${money(item.charges.successFee)} + VAT ${money(item.charges.commissionVat)}<br/>履约 ${money(item.charges.fulfilmentFee)} + VAT ${money(item.charges.fulfilmentVat)}<span class="subtext">平台贡献毛利 ${money(item.charges.contribution)}/件</span></div></td>
      <td><span class="metric-main ${item.returnRate30 >= .05 ? "negative" : ""}">${percent(item.returnRate30, true)}</span><span class="subtext">${integer(item.returnQuantity30)} 件${topReason ? ` · ${escapeHtml(topReason[0])}` : ""}</span></td>
      <td><span class="metric-main ${item.listingQuality > 0 && item.listingQuality < 80 ? "warning" : ""}">${item.listingQuality || "—"}</span><span class="subtext">${item.dimensions.weightGrams ? `${integer(item.dimensions.weightGrams)}g` : "重量待补"}</span></td>
      <td class="action-cell"><strong>${escapeHtml(actionText(item))}</strong><div class="alert-tags">${item.alerts.map((alert) => `<span class="tag">${escapeHtml(alert)}</span>`).join("")}</div></td>
    </tr>`;
  }).join("") : `<tr><td colspan="12" class="empty">没有符合当前筛选的商品。</td></tr>`;
}

function render(payload) {
  state.payload = payload;
  renderStats(payload.summary); renderTrend(payload.trend); renderAlerts(payload.products); renderRegions(payload.products); renderProducts(payload.products);
  const refreshed = new Date(payload.meta.fetchedAt).toLocaleString("zh-CN", { timeZone: "Africa/Johannesburg", hour12: false });
  $("freshness").textContent = `数据源：${payload.meta.source} · 南非时间 ${refreshed} · 服务端缓存10分钟`;
  $("sourceNote").textContent = `${payload.meta.caveat} 佣金VAT和履约VAT按15%单独展示；实际销售费用以 Takealot sales API total_fees 为准。`;
}

async function load({ refresh = false } = {}) {
  const button = $("refreshButton"); button.disabled = true; button.textContent = refresh ? "同步中…" : "加载中…";
  $("errorPanel").hidden = true;
  try {
    await window.dashboardAuthReady;
    const response = await fetch(`/api/takealot/dashboard${refresh ? "?refresh=1" : ""}`, { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    render(payload.data);
  } catch (error) {
    $("errorPanel").textContent = `南非看板加载失败：${error.message}`;
    $("errorPanel").hidden = false;
  } finally {
    button.disabled = false; button.textContent = "同步 API";
  }
}

$("searchInput").addEventListener("input", (event) => { state.search = event.target.value.trim(); if (state.payload) renderProducts(state.payload.products); });
$("statusFilter").addEventListener("change", (event) => { state.filter = event.target.value; if (state.payload) renderProducts(state.payload.products); });
$("refreshButton").addEventListener("click", () => load({ refresh: true }));
load();
