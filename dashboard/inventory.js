const API_BASE = "";
const state = {
  products: [], search: "", showHidden: false, summary: {}, addMarket: "wb",
  dailyShipments: new Map(), orderSyncStatus: null,
  shishengHidden: localStorage.getItem("inventory-shisheng-hidden") === "1"
};

const WAREHOUSES = [
  { key: "linting", label: "林挺", match: ["林挺"] },
  { key: "shisheng", label: "世晟", match: ["世晟"] },
];

function $(id) { return document.getElementById(id); }
function text(value) { return String(value ?? ""); }
function esc(value) {
  return text(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function num(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}
function fmt(value) {
  return num(value).toLocaleString("zh-CN");
}
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 2400);
}
function titleOf(item) {
  return item.title || item.offer_id || item.product_id || "";
}
function sourceLabel(item) {
  if (item.source_label) return item.source_label;
  if (text(item.offer_id).startsWith("WBLOCAL-")) return "WB本土";
  if (text(item.offer_id).startsWith("WBCROSS-")) return "WB跨境";
  return "Ozon";
}
function productMeta(item) {
  const source = sourceLabel(item);
  if (source !== "Ozon") return `${source} / ${item.offer_id}`;
  return `${item.offer_id} / SKU ${item.ozon_sku || ""}`;
}
function linkRows(item, market) {
  return (item.links || []).filter((link) => link.market === market);
}
function amountOf(row) {
  return num(row.amount ?? row.available ?? row.stock ?? row.quantity);
}
function rowMatchesWarehouse(row, patterns) {
  if (row.source === "product_stock" && patterns.includes("林挺")) return true;
  const haystack = [row.warehouse_name, row.name, row.office_name, row.cluster_name, row.warehouse_id]
    .map((value) => text(value).toLowerCase())
    .join(" ");
  return patterns.some((pattern) => haystack.includes(pattern.toLowerCase()));
}
function cardLabel(link) {
  return link.vendor_code || link.title || link.nm_id || link.product_id || "商品卡";
}
function linkWarehouseBreakdown(item, market, patterns) {
  const parts = [];
  for (const link of linkRows(item, market)) {
    const rows = link.warehouses || link.stocks || [];
    const amount = rows.reduce((sum, row) => (
      rowMatchesWarehouse(row, patterns) ? sum + amountOf(row) : sum
    ), 0);
    if (amount > 0 || linkRows(item, market).length > 1) {
      parts.push({ label: cardLabel(link), nmId: link.nm_id, amount });
    }
  }
  return { total: parts.reduce((sum, part) => sum + part.amount, 0), parts };
}
function manualFbsCell(item, value, overAllocated) {
  const shown = item.manual_fbs_stock === null || item.manual_fbs_stock === undefined ? "" : fmt(value);
  return `<td class="manual-fbs-cell ${overAllocated ? "allocation-warn" : ""}">
    <input class="manual-fbs-input" type="number" min="0" step="1" data-offer="${esc(item.offer_id)}" value="${esc(shown)}" placeholder="填写" />
    ${overAllocated ? `<div class="allocation-text">分配超出</div>` : ""}
  </td>`;
}

function unallocatedCell(item) {
  const value = num(item.unallocated_stock);
  const details = item.unallocated_details || [];
  if (!value) return `<td class="num unallocated-cell group-start zero"></td>`;
  const rows = details.map((detail) => `<div class="unallocated-tooltip-row">
    <span class="unallocated-mark">${esc(detail.box_mark || "未标注箱唛")}</span>
    <span class="unallocated-boxes">箱号 ${esc(detail.box_numbers || "待确认")}（单箱 ${esc(fmt(detail.per_box_qty))} 件）</span>
  </div>`).join("");
  return `<td class="num unallocated-cell group-start" tabindex="0">
    <div class="stock-number">${esc(fmt(value))}</div>
    <div class="unallocated-tooltip" role="tooltip">
      <div class="unallocated-tooltip-title">未分配库存：${esc(fmt(value))} 件 / ${esc(fmt(item.unallocated_boxes))} 箱</div>
      <div class="unallocated-tooltip-list">${rows}</div>
    </div>
  </td>`;
}

function barcodeCell(item) {
  return `<td class="barcode-cell">
    <input class="barcode-input" type="text" data-offer="${esc(item.offer_id)}" value="${esc(item.barcode || "")}" placeholder="条码" />
  </td>`;
}

function qtyCell(value, extraClass = "", parts = []) {
  const n = num(value);
  const detail = parts.length
    ? `<div class="stock-detail">${parts.map((part) => (
        `<div><span>${esc(part.label)}</span><b>${esc(fmt(part.amount))}</b></div>`
      )).join("")}</div>`
    : "";
  return `<td class="num ${extraClass} ${n ? "" : "zero"}"><div class="stock-number">${esc(fmt(n))}</div>${detail}</td>`;
}
function firstLegCell(item) {
  const shown = item.first_leg_transit === null || item.first_leg_transit === undefined ? "" : fmt(item.first_leg_transit);
  return `<td class="first-leg-cell"><input class="first-leg-input" type="number" min="0" step="1" data-offer="${esc(item.offer_id)}" value="${esc(shown)}" placeholder="\u624b\u586b" /></td>`;
}

function replenishmentCell(item, values) {
  const demand = item.replenishment_demand || {};
  const title = `30-day units: FBO ${fmt(demand.fbo || 0)}; WB local ${fmt(demand.wb_local || 0)}; WB cross ${fmt(demand.wb_cross || 0)}`;
  return `<td class="shortage-cell ${values.replenish60 > 0 ? "warn" : "sufficient"}" title="${esc(title)}">
    <div class="stock-plan-line"><span>60\u5929</span><b>${esc(fmt(values.replenish60))}</b></div>
    <div class="stock-plan-line"><span>90\u5929</span><b>${esc(fmt(values.replenish90))}</b></div>
    <div class="stock-plan-avg">\u65e5\u5747 ${esc(values.dailyDemand.toFixed(1))}</div>
  </td>`;
}

function warehouseTotalCell(item, warehouseKey, warehouse) {
  const manual = item.manual_warehouse_actual_stock || {};
  const manualShown = manual[warehouseKey] === null || manual[warehouseKey] === undefined ? "" : fmt(manual[warehouseKey]);
  const warehouseClass = warehouseKey === "shisheng" ? "shisheng-column" : "";
  return `<td class="dual-box-cell group-start total-num stock-history-trigger ${warehouseClass} ${warehouse.overAllocated ? "allocation-warn" : ""}" data-offer="${esc(item.offer_id)}" data-warehouse="${esc(warehouseKey)}">
    <div class="single-box">
      <input class="dual-box-input manual-box warehouse-actual-input stock-history-trigger" type="number" min="0" step="1" data-offer="${esc(item.offer_id)}" data-warehouse="${esc(warehouseKey)}" data-history-kind="manual" value="${esc(manualShown)}" placeholder="\u624b\u586b" title="\u4eba\u5de5\u586b\u5199\u603b\u6570" />
    </div>
    ${warehouse.overAllocated ? `<div class="allocation-text">\u5206\u914d\u8d85\u51fa ${esc(fmt(Math.abs(warehouse.unallocated)))}</div>` : ""}
  </td>`;
}

function dailyShipmentCell(item, warehouseKey) {
  const key = `${item.offer_id}:${warehouseKey}`;
  const systemValue = num(state.dailyShipments.get(key));
  const manual = item.manual_daily_shipments || {};
  const manualShown = manual[warehouseKey] === null || manual[warehouseKey] === undefined ? "" : fmt(manual[warehouseKey]);
  const warehouseClass = warehouseKey === "shisheng" ? "shisheng-column" : "";
  return `<td class="dual-box-cell daily-shipment-cell stock-history-trigger ${warehouseClass} ${systemValue ? "" : "zero"}" data-offer="${esc(item.offer_id)}" data-warehouse="${esc(warehouseKey)}" data-history-kind="shipment">
    <div class="dual-boxes">
      <input class="dual-box-input system-box daily-shipment-system" type="text" value="${esc(fmt(systemValue))}" readonly title="系统每日发货数：API后台导入" />
      <input class="dual-box-input manual-box daily-shipment-manual-input" type="number" min="0" step="1" data-offer="${esc(item.offer_id)}" data-warehouse="${esc(warehouseKey)}" value="${esc(manualShown)}" placeholder="手填" title="人工填写每日发货数" />
    </div>
  </td>`;
}

function unallocatedCell(item) {
  const value = num(item.unallocated_stock);
  const details = item.unallocated_details || [];
  if (!value) return `<td class="num unallocated-cell group-start zero"></td>`;
  const rows = details.map((detail) => `<div class="unallocated-tooltip-row">
    <span class="unallocated-mark">${esc(detail.box_mark || "未标注箱唛")}</span>
    <span class="unallocated-boxes">箱号 ${esc(detail.box_numbers || "待确认")}（单箱 ${esc(fmt(detail.per_box_qty))} 件）</span>
  </div>`).join("");
  return `<td class="num unallocated-cell group-start" tabindex="0">
    <div class="stock-number">${esc(fmt(value))}</div>
    <div class="unallocated-tooltip" role="tooltip">
      <div class="unallocated-tooltip-title">未分配库存：${esc(fmt(value))} 件 / ${esc(fmt(item.unallocated_boxes))} 箱</div>
      <div class="unallocated-tooltip-list">${rows}</div>
    </div>
  </td>`;
}
function matrixValues(item) {
  // fbo_stock is refreshed by the Ozon product sync; warehouse cache is only for transit/details.
  const fbo = num(item.fbo_stock);
  const fboTransit = num(item.ozon_warehouse_transit);
  const fbw = num(item.fbw_stock);
  const manual = item.manual_warehouse_actual_stock || {};
  const warehouses = {};
  for (const warehouse of WAREHOUSES) {
    const local = linkWarehouseBreakdown(item, "wb", warehouse.match);
    const cross = linkWarehouseBreakdown(item, "wb_cross", warehouse.match);
    const ozon = warehouse.key === "linting" ? num(item.fbs_stock) : 0;
    const allocated = ozon + local.total + cross.total;
    const hasManual = manual[warehouse.key] !== null && manual[warehouse.key] !== undefined;
    const manualTotal = hasManual ? num(manual[warehouse.key]) : allocated;
    warehouses[warehouse.key] = {
      ozon,
      wbLocal: local.total,
      wbCross: cross.total,
      localParts: local.parts,
      crossParts: cross.parts,
      allocated,
      manualTotal,
      hasManual,
      unallocated: manualTotal - allocated,
      overAllocated: allocated > manualTotal,
      total: allocated,
    };
  }
  const unallocated = num(item.unallocated_stock);
  const overAllocated = false;
  const manualFbsTotal = warehouses.linting.manualTotal + warehouses.shisheng.manualTotal;
  // 商品总库存统一口径：FBO可用 + FBO在途 + FBW + 两个海外仓FBS手填总数 + 未分配库存。
  // 头程在途单独展示，不计入商品总库存；缺货计算直接使用商品总库存。
  const total = fbo + fboTransit + fbw + manualFbsTotal + unallocated;
  const demand = item.replenishment_demand || {};
  const dailyDemand = num(demand.daily_avg);
  const replenish60 = Math.max(0, Math.ceil(dailyDemand * 60 - total));
  const replenish90 = Math.max(0, Math.ceil(dailyDemand * 90 - total));
  return { fbo, fboTransit, fbw, warehouses, manualFbsTotal, unallocated, overAllocated, total,
    dailyDemand, replenish60, replenish90, shortage: replenish60 > 0 };
}
function visibleProducts() {
  const term = state.search.trim().toLowerCase();
  return state.products.filter((item) => {
    if (!state.showHidden && item.hidden) return false;
    if (!term) return true;
    return [item.offer_id, item.product_id, item.ozon_sku, item.title]
      .some((value) => text(value).toLowerCase().includes(term));
  });
}
function renderStats(summary) {
  const items = [
    ["商品数", summary.productCount || 0],
    ["隐藏商品", summary.hiddenCount || 0],
    ["FBO总库存", summary.ozonFbo || 0],
    ["Ozon FBS", summary.ozonFbs || 0],
    ["超分配商品", summary.overAllocatedCount || 0],
    ["WB本土已关联", summary.wbLocalLinkedFbs || 0],
    ["WB跨境已关联", summary.wbCrossLinkedFbs || 0],
  ];
  $("stats").innerHTML = items.map(([label, value]) => (
    `<div class="stat"><span>${esc(label)}</span><strong>${esc(fmt(value))}</strong></div>`
  )).join("");
}
function renderRows() {
  const html = visibleProducts().map((item) => {
    const v = matrixValues(item);
    const hiddenText = item.hidden ? "恢复" : "隐藏";
    return `
      <tr class="${item.hidden ? "hidden-row" : ""} ${v.overAllocated ? "row-warning" : ""}">
        <td>
          <div class="product-cell" data-offer="${esc(item.offer_id)}">
            ${item.image_url ? `<img src="${esc(item.image_url)}" loading="lazy" decoding="async" />` : `<div class="image-empty"></div>`}
            <div class="product-main">
              <strong>${esc(titleOf(item))}</strong>
              <span>${esc(productMeta(item))}</span>
            </div>
          </div>
        </td>
        ${barcodeCell(item)}
        ${qtyCell(v.total, "total-num")}
        ${qtyCell(v.fbo, "group-start")}
        ${qtyCell(v.fboTransit)}
        ${qtyCell(v.fbw)}
        ${warehouseTotalCell(item, "linting", v.warehouses.linting)}
        ${dailyShipmentCell(item, "linting")}
        ${qtyCell(v.warehouses.linting.ozon, "ozon-fbs-col")}
        ${qtyCell(v.warehouses.linting.wbLocal, "", v.warehouses.linting.localParts)}
        ${qtyCell(v.warehouses.linting.wbCross, "", v.warehouses.linting.crossParts)}
        ${warehouseTotalCell(item, "shisheng", v.warehouses.shisheng)}
        ${dailyShipmentCell(item, "shisheng")}
        ${qtyCell(v.warehouses.shisheng.ozon, "shisheng-column ozon-fbs-col")}
        ${qtyCell(v.warehouses.shisheng.wbLocal, "shisheng-column", v.warehouses.shisheng.localParts)}
        ${qtyCell(v.warehouses.shisheng.wbCross, "shisheng-column", v.warehouses.shisheng.crossParts)}
        ${unallocatedCell(item)}
        ${replenishmentCell(item, v)}
        ${firstLegCell(item)}
        <td><button class="secondary hide-btn" data-offer="${esc(item.offer_id)}" data-hidden="${item.hidden ? "0" : "1"}">${hiddenText}</button></td>
      </tr>
    `;
  }).join("");
  $("productBody").innerHTML = html || `<tr><td colspan="20" class="muted">暂无商品</td></tr>`;
  applyWarehouseVisibility();
}
function render() { renderRows(); }
function todayChina() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date());
}
async function loadDailyShipments() {
  const res = await fetch(`${API_BASE}/api/inventory/daily-shipments?date=${encodeURIComponent(todayChina())}`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "每日发货数加载失败");
  state.dailyShipments = new Map();
  for (const row of payload.data?.rows || []) {
    const key = `${row.offer_id}:${row.warehouse_key}`;
    state.dailyShipments.set(key, num(state.dailyShipments.get(key)) + num(row.quantity));
  }
}
async function loadOrderSyncStatus() {
  const res = await fetch(`${API_BASE}/api/inventory/order-sync/status`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "每日发货同步状态加载失败");
  state.orderSyncStatus = payload.data || null;
}
function orderSyncStatusText() {
  const status = state.orderSyncStatus;
  if (!status) return "";
  const dataDate = status.dataDate || status.lastSuccessDataDate || "暂无";
  if (status.lastError) {
    const failedAt = status.lastFinishedAt ? new Date(status.lastFinishedAt).toLocaleString() : "未知时间";
    return `；每日发货数据日 ${dataDate}，最近同步失败 ${failedAt}：${status.lastError}`;
  }
  if (status.lastOkAt) {
    return `；每日发货数据日 ${dataDate}，同步成功 ${new Date(status.lastOkAt).toLocaleString()}`;
  }
  return `；每日发货数据日 ${dataDate}，尚无成功记录`;
}
function applyWarehouseVisibility() {
  document.body.classList.toggle("hide-shisheng", state.shishengHidden);
  const fbsHeader = document.querySelector(".group-title");
  if (fbsHeader) fbsHeader.colSpan = state.shishengHidden ? 5 : 10;
  const button = $("toggleShishengBtn");
  if (button) button.textContent = state.shishengHidden ? "恢复世晟仓库" : "隐藏世晟仓库";
}
async function startBackgroundRefresh() {
  const res = await fetch(`${API_BASE}/api/inventory/dashboard/refresh?show_hidden=${state.showHidden ? "1" : "0"}`, { method: "POST" });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "后台刷新启动失败");
  toast(payload.data?.running && !payload.data?.accepted ? "后台刷新已在运行" : "已启动后台刷新，页面继续显示缓存数据");
  pollRefreshStatus();
}

async function pollRefreshStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/inventory/dashboard/refresh-status`);
    const payload = await res.json();
    if (!res.ok || !payload.ok) return;
    const data = payload.data || {};
    if (data.running) {
      $("syncText").textContent = `后台同步中，当前显示缓存数据，开始时间 ${new Date(data.lastStartedAt || Date.now()).toLocaleString()}`;
      setTimeout(pollRefreshStatus, 5000);
      return;
    }
    if (data.lastError) {
      toast(`后台同步失败：${data.lastError}`);
      return;
    }
    if (data.lastOkAt) await loadDashboard(false);
  } catch {}
}

async function loadDashboard(refresh = false) {
  if (refresh) {
    await startBackgroundRefresh();
    return;
  }
  $("syncText").textContent = "正在加载库存...";
  const res = await fetch(`${API_BASE}/api/inventory/dashboard?show_hidden=${state.showHidden ? "1" : "0"}&refresh=0`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || `加载失败: ${res.status}`);
  state.products = payload.data.products || [];
  state.summary = payload.data.summary || {};
  await Promise.all([
    loadDailyShipments().catch((error) => toast(error.message)),
    loadOrderSyncStatus().catch((error) => toast(error.message))
  ]);
  renderStats(state.summary);
  render();
  const errors = payload.data.source?.sourceErrors || {};
  const warn = Object.entries(errors).filter(([, value]) => value).map(([key]) => key).join(", ");
  $("syncText").textContent = `已加载 ${state.products.length} 个库存商品，更新时间 ${new Date(payload.data.source?.fetchedAt || Date.now()).toLocaleString()}${warn ? `，部分数据限流: ${warn}` : ""}${orderSyncStatusText()}`;
}
function findProduct(offerId) {
  return state.products.find((item) => text(item.offer_id) === text(offerId));
}
function historyKindLabel(kind) {
  if (kind === "shipment") return "每日发货数";
  return kind === "manual" ? "手填总数" : "系统总数";
}

function parseHistoryDate(value) {
  const raw = text(value).slice(0, 10);
  const [year, month, day] = raw.split("-").map((part) => Number(part));
  return new Date(year, month - 1, day);
}

function renderHistoryCalendar(rows) {
  const weekLabels = ["一", "二", "三", "四", "五", "六", "日"];
  const ordered = [...rows].reverse();
  const cells = ordered.map((row) => {
    const date = parseHistoryDate(row.date);
    const day = date.getDate();
    const isToday = text(row.date).slice(0, 10) === todayChina();
    const isShipment = row.kind === "shipment";
    const stockText = row.stock === null || row.stock === undefined ? "—" : fmt(row.stock);
    const note = isShipment
      ? `系${fmt(row.system_quantity || 0)} 手${fmt(row.manual_quantity || 0)}`
      : row.source_note === "carried_forward" ? "沿用" : row.source_note === "daily_snapshot" ? "快照" : row.stock === null || row.stock === undefined ? "" : "变动";
    return `<div class="history-day ${isToday ? "today" : ""} ${row.stock === null || row.stock === undefined ? "empty" : ""} ${isShipment ? "shipment-history-day" : ""}">
      <div class="history-day-num">${esc(day)}</div>
      <div class="history-stock">${esc(stockText)}</div>
      <div class="history-note">${esc(note)}</div>
    </div>`;
  }).join("");
  return `<div class="history-week-head">${weekLabels.map((label) => `<span>${label}</span>`).join("")}</div>
    <div class="history-calendar">${cells}</div>`;
}

function positionStockHistoryPopover(cell, popover) {
  const gap = 10;
  const edge = 8;
  const rect = cell.getBoundingClientRect();
  const width = popover.offsetWidth || 350;
  const height = popover.offsetHeight || 390;

  // Keep the popover beside the edited field so it never covers that field.
  let left = rect.left - width - gap;
  if (left < edge) left = rect.right + gap;
  left = Math.min(Math.max(edge, left), Math.max(edge, window.innerWidth - width - edge));

  // Align to the field, then clamp the full panel inside the visible viewport.
  let top = rect.top;
  top = Math.min(Math.max(edge, top), Math.max(edge, window.innerHeight - height - edge));
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

async function showStockHistory(cell) {
  const popover = $("stockHistoryPopover");
  const warehouse = WAREHOUSES.find((item) => item.key === cell.dataset.warehouse);
  const kind = cell.dataset.historyKind || (cell.classList.contains("warehouse-actual-input") ? "manual" : "system");
  popover.innerHTML = `<div class="history-title">${esc(warehouse?.label || "")}${esc(historyKindLabel(kind))}近30天</div><div class="history-loading">正在加载...</div>`;
  popover.hidden = false;
  positionStockHistoryPopover(cell, popover);
  const endpoint = kind === "shipment"
    ? `${API_BASE}/api/inventory/products/${encodeURIComponent(cell.dataset.offer)}/daily-shipment-history?warehouse=${encodeURIComponent(cell.dataset.warehouse)}&days=30`
    : `${API_BASE}/api/inventory/products/${encodeURIComponent(cell.dataset.offer)}/warehouse-history?warehouse=${encodeURIComponent(cell.dataset.warehouse)}&days=30&kind=${encodeURIComponent(kind)}`;
  const res = await fetch(endpoint);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || (kind === "shipment" ? "每日发货历史加载失败" : "库存历史加载失败"));
  const rows = payload.data || [];
  popover.innerHTML = `<div class="history-title">${esc(warehouse?.label || "")}${esc(historyKindLabel(kind))}近30天</div>
    ${kind === "shipment" ? `<div class="history-subtitle">上方数字为合计，下方为系统/手填</div>` : ""}
    ${rows.length ? renderHistoryCalendar(rows) : `<div class="history-empty">近30天暂无记录</div>`}`;
  positionStockHistoryPopover(cell, popover);
}
async function loadCandidates(item) {
  if (item.candidatesLoaded) return;
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(item.offer_id)}/candidates`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "候选商品加载失败");
  item.candidates = payload.data || { wb: [], wb_cross: [] };
  item.candidatesLoaded = true;
}

function cardsFor(item, market) {
  const byId = new Map();
  for (const card of item.candidates?.[market] || []) {
    byId.set(text(card.nm_id), { ...card, market, linked: Boolean(card.linked) });
  }
  for (const link of linkRows(item, market)) {
    const id = text(link.nm_id);
    byId.set(id, {
      ...byId.get(id),
      ...link,
      market,
      nm_id: link.nm_id,
      linked: true,
      fbs_stock: num(link.fbs_stock ?? link.stock),
    });
  }
  return Array.from(byId.values());
}
function cardHtml(card, offerId) {
  const linked = Boolean(card.linked);
  return `
    <label class="card-row">
      <input type="checkbox" class="link-check" data-original="${linked ? "1" : "0"}" data-offer="${esc(offerId)}" data-market="${esc(card.market)}" data-nm-id="${esc(card.nm_id)}" ${linked ? "checked" : ""} />
      ${card.image_url ? `<img src="${esc(card.image_url)}" loading="lazy" decoding="async" />` : `<div></div>`}
      <span class="card-text">
        <strong>${esc(card.title || card.vendor_code || card.nm_id)}</strong>
        <span>${esc(card.vendor_code || "")} / ${esc(card.nm_id)} / 匹配 ${esc(card.score || 0)} / 库存 ${esc(card.fbs_stock ?? card.stock ?? 0)}</span>
      </span>
    </label>
  `;
}
function panelHtml(title, market, offerId, cards) {
  return `
    <section class="match-panel">
      <h3>${esc(title)}</h3>
      <div class="card-list">${(cards || []).map((card) => cardHtml(card, offerId)).join("") || `<div class="card-row muted">暂无自动候选</div>`}</div>
      <div class="manual-add">
        <input class="manual-input" data-market="${market}" placeholder="输入 nm_id / vendor_code / 商品名" />
        <button class="manual-btn" type="button" data-offer="${esc(offerId)}" data-market="${market}">添加并关联</button>
      </div>
    </section>
  `;
}
function pendingLinkChanges(pop = $("linkPopover")) {
  return Array.from(pop.querySelectorAll(".link-check")).filter((check) => (
    (check.checked ? "1" : "0") !== check.dataset.original
  ));
}
function updateConfirmState() {
  const button = $("confirmLinksBtn");
  if (!button) return;
  const count = pendingLinkChanges().length;
  button.disabled = count === 0;
  button.textContent = count ? `确认关联(${count})` : "确认关联";
}
function placePopover(target) {
  const pop = $("linkPopover");
  const rect = target.getBoundingClientRect();
  pop.style.left = `${Math.min(window.innerWidth - pop.offsetWidth - 12, Math.max(12, rect.left))}px`;
  pop.style.top = `${Math.min(window.innerHeight - pop.offsetHeight - 12, Math.max(12, rect.bottom + 8))}px`;
}
function renderPopoverContent(pop, item, offerId, loading = false) {
  pop.innerHTML = `
    <div class="popover-head">
      <div>
        <h2>${esc(titleOf(item))}</h2>
        <p>${loading ? "正在加载候选商品卡..." : `${esc(item.offer_id)}: 勾选后先暂存，点击确认关联后才并入该行 FBS 库存`}</p>
      </div>
      <div class="popover-actions">
        <button id="confirmLinksBtn" type="button" disabled>确认关联</button>
        <button class="secondary" id="closePopoverBtn" type="button">关闭</button>
      </div>
    </div>
    <div class="popover-grid">
      ${loading ? `<section class="match-panel"><h3>WB 本土候选</h3><div class="card-row muted">加载中...</div></section><section class="match-panel"><h3>WB 跨境候选</h3><div class="card-row muted">加载中...</div></section>` : `${panelHtml("WB 本土候选", "wb", offerId, cardsFor(item, "wb"))}${panelHtml("WB 跨境候选", "wb_cross", offerId, cardsFor(item, "wb_cross"))}`}
    </div>
  `;
}

function openPopover(target, offerId) {
  const item = findProduct(offerId);
  if (!item) return;
  const pop = $("linkPopover");
  pop.dataset.offer = offerId;
  renderPopoverContent(pop, item, offerId, !item.candidatesLoaded);
  pop.hidden = false;
  updateConfirmState();
  requestAnimationFrame(() => placePopover(target));
  if (!item.candidatesLoaded) {
    loadCandidates(item)
      .then(() => {
        if (pop.dataset.offer !== offerId || pop.hidden) return;
        renderPopoverContent(pop, item, offerId, false);
        updateConfirmState();
        requestAnimationFrame(() => placePopover(target));
      })
      .catch((error) => toast(error.message));
  }
}
async function saveBarcode(offerId, barcode) {
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(offerId)}/barcode`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ barcode })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "条形码保存失败");
  const item = findProduct(offerId);
  if (item) item.barcode = payload.data.barcode || "";
  toast("条形码已保存");
}

async function saveWarehouseFbs(offerId, warehouseKey, value) {
  const clean = String(value ?? "").trim();
  const nextValue = clean === "" ? null : Math.max(0, num(clean));
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(offerId)}/manual-warehouse-fbs`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_key: warehouseKey, manual_stock: nextValue })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "仓库总数保存失败");
  const item = findProduct(offerId);
  if (item) {
    item.manual_warehouse_fbs_stock = item.manual_warehouse_fbs_stock || {};
    if (nextValue === null) delete item.manual_warehouse_fbs_stock[warehouseKey];
    else item.manual_warehouse_fbs_stock[warehouseKey] = Number(payload.data.manual_stock || nextValue);
  }
  render();
  toast("仓库总数已保存");
}

async function saveWarehouseActual(offerId, warehouseKey, value) {
  const clean = String(value ?? "").trim();
  const nextValue = clean === "" ? null : Math.max(0, num(clean));
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(offerId)}/manual-warehouse-actual`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_key: warehouseKey, manual_stock: nextValue })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "人工仓库总数保存失败");
  const item = findProduct(offerId);
  if (item) {
    item.manual_warehouse_actual_stock = item.manual_warehouse_actual_stock || {};
    if (nextValue === null) delete item.manual_warehouse_actual_stock[warehouseKey];
    else item.manual_warehouse_actual_stock[warehouseKey] = Number(payload.data.manual_stock || nextValue);
  }
  render();
  toast("人工总数已保存");
}

async function saveManualDailyShipment(offerId, warehouseKey, value) {
  const clean = String(value ?? "").trim();
  const nextValue = clean === "" ? null : Math.max(0, num(clean));
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(offerId)}/manual-daily-shipment`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_key: warehouseKey, shipment_date: todayChina(), manual_quantity: nextValue })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "人工每日发货数保存失败");
  const item = findProduct(offerId);
  if (item) {
    item.manual_daily_shipments = item.manual_daily_shipments || {};
    if (nextValue === null) delete item.manual_daily_shipments[warehouseKey];
    else item.manual_daily_shipments[warehouseKey] = Number(payload.data.manual_quantity || nextValue);

    if (payload.data && payload.data.adjusted_manual_stock !== null && payload.data.adjusted_manual_stock !== undefined) {
      item.manual_warehouse_actual_stock = item.manual_warehouse_actual_stock || {};
      item.manual_warehouse_actual_stock[warehouseKey] = Number(payload.data.adjusted_manual_stock || 0);
    }
  }
  render();
  toast(payload.data && payload.data.deducted_delta ? "人工每日发货数已保存，手填总数已联动扣减" : "人工每日发货数已保存");
}

async function saveFirstLegTransit(offerId, value) {
  const clean = String(value ?? "").trim();
  const nextValue = clean === "" ? null : Math.max(0, num(clean));
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(offerId)}/first-leg-transit`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quantity: nextValue })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "First-leg transit save failed");
  const item = findProduct(offerId);
  if (item) item.first_leg_transit = payload.data.quantity === null ? null : Number(payload.data.quantity || nextValue);
  render();
  toast("\u5934\u7a0b\u5728\u9014\u5df2\u4fdd\u5b58");
}

async function saveManualFbs(offerId, value) {
  const nextValue = Math.max(0, num(value));
  const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(offerId)}/manual-fbs`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ manual_fbs_stock: nextValue })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "FBS库存总数保存失败");
  const item = findProduct(offerId);
  if (item) item.manual_fbs_stock = Number(payload.data.manual_fbs_stock || nextValue);
  render();
  toast("FBS库存总数已保存");
}

async function createLink(offerId, market, nmId) {
  const res = await fetch(`${API_BASE}/api/inventory/links`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ offer_id: offerId, market, nm_id: nmId })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "关联失败");
}
async function deleteLink(offerId, market, nmId) {
  const item = findProduct(offerId);
  const link = (item?.links || []).find((row) => row.market === market && text(row.nm_id) === text(nmId));
  if (!link?.id) return;
  const res = await fetch(`${API_BASE}/api/inventory/links/${encodeURIComponent(link.id)}`, { method: "DELETE" });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "取消关联失败");
}
async function confirmLinks() {
  const changes = pendingLinkChanges();
  if (!changes.length) return;
  const button = $("confirmLinksBtn");
  if (button) {
    button.disabled = true;
    button.textContent = "保存中...";
  }
  for (const check of changes) {
    if (check.checked) await createLink(check.dataset.offer, check.dataset.market, check.dataset.nmId);
    else await deleteLink(check.dataset.offer, check.dataset.market, check.dataset.nmId);
  }
  toast("关联已保存");
  $("linkPopover").hidden = true;
  await loadDashboard(false);
}
async function manualAdd(offerId, market, q) {
  const res = await fetch(`${API_BASE}/api/inventory/cards?market=${encodeURIComponent(market)}&q=${encodeURIComponent(q)}&limit=1`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "查找失败");
  const card = (payload.data || [])[0];
  if (!card) throw new Error("没有找到商品卡");
  await createLink(offerId, market, card.nm_id);
  toast(`已关联 ${card.vendor_code || card.nm_id}`);
  $("linkPopover").hidden = true;
  await loadDashboard(false);
}

function marketName(market) {
  return market === "wb_cross" ? "WB跨境" : "WB本土";
}
function openAddDialog(market) {
  state.addMarket = market === "wb_cross" ? "wb_cross" : "wb";
  $("addDialogTitle").textContent = `新增${marketName(state.addMarket)}商品卡`;
  $("addCardSearchInput").value = "";
  $("addCardResults").innerHTML = `<div class="muted add-empty">输入 nm_id / vendor_code / 商品名后搜索</div>`;
  const dialog = $("addCardDialog");
  if (dialog.showModal) dialog.showModal();
  else dialog.setAttribute("open", "open");
  setTimeout(() => $("addCardSearchInput").focus(), 0);
}
function closeAddDialog() {
  const dialog = $("addCardDialog");
  if (dialog.close) dialog.close();
  else dialog.removeAttribute("open");
}
function addCardRow(card) {
  return `
    <div class="add-card-row">
      ${card.image_url ? `<img src="${esc(card.image_url)}" loading="lazy" decoding="async" />` : `<div class="image-empty"></div>`}
      <div class="add-card-text">
        <strong>${esc(card.title || card.vendor_code || card.nm_id)}</strong>
        <span>${esc(card.vendor_code || "")} / ${esc(card.nm_id)} / 库存 ${esc(card.fbs_stock ?? card.stock ?? 0)}</span>
      </div>
      <button class="add-card-btn" type="button" data-nm-id="${esc(card.nm_id)}">加入库存表</button>
    </div>
  `;
}
async function searchAddCards() {
  const q = $("addCardSearchInput").value.trim();
  if (!q) {
    $("addCardResults").innerHTML = `<div class="muted add-empty">先输入要搜索的商品卡</div>`;
    return;
  }
  $("addCardResults").innerHTML = `<div class="muted add-empty">搜索中...</div>`;
  const res = await fetch(`${API_BASE}/api/inventory/cards?market=${encodeURIComponent(state.addMarket)}&q=${encodeURIComponent(q)}&limit=20`);
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "搜索失败");
  const cards = payload.data || [];
  $("addCardResults").innerHTML = cards.map(addCardRow).join("") || `<div class="muted add-empty">没有找到商品卡</div>`;
}
async function createInventoryProductFromWb(nmId) {
  const res = await fetch(`${API_BASE}/api/inventory/products/from-wb`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ market: state.addMarket, nm_id: nmId })
  });
  const payload = await res.json();
  if (!res.ok || !payload.ok) throw new Error(payload.error || "加入库存表失败");
  toast(`已加入库存表: ${marketName(state.addMarket)} ${nmId}`);
  closeAddDialog();
  await loadDashboard(false);
}
document.addEventListener("mouseover", (event) => {
  const historyCell = event.target.closest(".stock-history-trigger");
  if (historyCell) {
    showStockHistory(historyCell).catch((error) => toast(error.message));
  }
});
document.addEventListener("mouseout", (event) => {
  const historyCell = event.target.closest(".stock-history-trigger");
  if (!historyCell) return;
  const next = event.relatedTarget;
  if (next?.closest?.(".stock-history-trigger") || next?.closest?.("#stockHistoryPopover")) return;
  setTimeout(() => {
    if (!$("stockHistoryPopover").matches(":hover")) $("stockHistoryPopover").hidden = true;
  }, 120);
});
document.addEventListener("click", async (event) => {
  try {
    const addButton = event.target.closest(".add-wb-product-btn");
    if (addButton) {
      openAddDialog(addButton.dataset.market);
      return;
    }
    if (event.target.id === "closeAddDialogBtn") {
      closeAddDialog();
      return;
    }
    if (event.target.id === "searchAddCardBtn") {
      await searchAddCards();
      return;
    }
    const addCardBtn = event.target.closest(".add-card-btn");
    if (addCardBtn) {
      await createInventoryProductFromWb(addCardBtn.dataset.nmId);
      return;
    }
    const productCell = event.target.closest(".product-cell");
    if (productCell) {
      openPopover(productCell, productCell.dataset.offer);
      return;
    }
    if (event.target.id === "closePopoverBtn") {
      $("linkPopover").hidden = true;
      return;
    }
    if (event.target.id === "confirmLinksBtn") {
      await confirmLinks();
      return;
    }
    const hideBtn = event.target.closest(".hide-btn");
    if (hideBtn) {
      const res = await fetch(`${API_BASE}/api/inventory/products/${encodeURIComponent(hideBtn.dataset.offer)}/hidden`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: hideBtn.dataset.hidden === "1" })
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || "操作失败");
      await loadDashboard(false);
      return;
    }
    const manualBtn = event.target.closest(".manual-btn");
    if (manualBtn) {
      const input = manualBtn.parentElement.querySelector(".manual-input");
      const q = input.value.trim();
      if (q) await manualAdd(manualBtn.dataset.offer, manualBtn.dataset.market, q);
    }
  } catch (error) {
    toast(error.message);
    updateConfirmState();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.target.id === "addCardSearchInput" && event.key === "Enter") {
    event.preventDefault();
    searchAddCards().catch((error) => toast(error.message));
    return;
  }
  if ((event.target.closest(".warehouse-total-input") || event.target.closest(".warehouse-actual-input") || event.target.closest(".daily-shipment-manual-input") || event.target.closest(".first-leg-input") || event.target.closest(".barcode-input")) && event.key === "Enter") {
    event.preventDefault();
    event.target.blur();
  }
});

document.addEventListener("change", async (event) => {
  try {
    const barcodeInput = event.target.closest(".barcode-input");
    if (barcodeInput) {
      const nextValue = barcodeInput.value.trim();
      const previousValue = String(findProduct(barcodeInput.dataset.offer)?.barcode || "");
      if (nextValue !== previousValue) {
        barcodeInput.disabled = true;
        try {
          await saveBarcode(barcodeInput.dataset.offer, nextValue);
          barcodeInput.value = String(findProduct(barcodeInput.dataset.offer)?.barcode || "");
        } finally {
          barcodeInput.disabled = false;
        }
      }
      return;
    }

    const firstLegInput = event.target.closest(".first-leg-input");
    if (firstLegInput) {
      firstLegInput.disabled = true;
      try { await saveFirstLegTransit(firstLegInput.dataset.offer, firstLegInput.value); }
      finally { firstLegInput.disabled = false; }
      return;
    }

    const warehouseActualInput = event.target.closest(".warehouse-actual-input");
    if (warehouseActualInput) {
      warehouseActualInput.disabled = true;
      try {
        await saveWarehouseActual(warehouseActualInput.dataset.offer, warehouseActualInput.dataset.warehouse, warehouseActualInput.value);
      } finally {
        warehouseActualInput.disabled = false;
      }
      return;
    }
    const dailyShipmentManualInput = event.target.closest(".daily-shipment-manual-input");
    if (dailyShipmentManualInput) {
      dailyShipmentManualInput.disabled = true;
      try {
        await saveManualDailyShipment(dailyShipmentManualInput.dataset.offer, dailyShipmentManualInput.dataset.warehouse, dailyShipmentManualInput.value);
      } finally {
        dailyShipmentManualInput.disabled = false;
      }
      return;
    }
    const warehouseTotalInput = event.target.closest(".warehouse-total-input");
    if (warehouseTotalInput) {
      warehouseTotalInput.disabled = true;
      try {
        await saveWarehouseFbs(warehouseTotalInput.dataset.offer, warehouseTotalInput.dataset.warehouse, warehouseTotalInput.value);
      } finally {
        warehouseTotalInput.disabled = false;
      }
      return;
    }
    if (event.target.id === "showHiddenInput") {
      state.showHidden = event.target.checked;
      await loadDashboard(false);
      return;
    }
    const check = event.target.closest(".link-check");
    if (check) updateConfirmState();
  } catch (error) {
    toast(error.message);
  }
});
$("searchInput").addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});
$("refreshBtn").addEventListener("click", () => loadDashboard(true).catch((error) => toast(error.message)));
const toggleShishengBtn = $("toggleShishengBtn");
if (toggleShishengBtn) {
  toggleShishengBtn.addEventListener("click", () => {
    state.shishengHidden = !state.shishengHidden;
    localStorage.setItem("inventory-shisheng-hidden", state.shishengHidden ? "1" : "0");
    applyWarehouseVisibility();
  });
}
applyWarehouseVisibility();
loadDashboard(false).catch((error) => {
  $("syncText").textContent = `加载失败: ${error.message}`;
  toast(error.message);
});
