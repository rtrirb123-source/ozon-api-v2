const MONTHS_URL = "/api/russia/months";
const state = {
  rows: [], filtered: [], meta: null, rubToCny: 0.0866, usdToCny: 7.2,
  logisticsFactorUsdKg: 3, taxRate: 0.12, withdrawalRate: 0.03,
  operators: {}, currentUser: null,
  searchTerm: "", selectedOperator: "",
  months: [], currentMonth: "",
};

const money = (value) => `${Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ₽`;
const absSum = (rows, keys) => Math.abs(rows.reduce((sum, row) => (
  sum + keys.reduce((part, key) => part + Number(row[key] || 0), 0)
), 0));
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
const salesTotal = (row) => ["revenue", "discountPoints", "partnerPrograms"]
  .reduce((total, key) => total + Number(row[key] || 0), 0);
const rowFeeTotal = (row, keys) => Math.abs(
  keys.reduce((total, key) => total + Number(row[key] || 0), 0)
);
const deliveryStorageTotal = (row) => rowFeeTotal(
  row, ["shipmentProcessing", "logistics", "lastMile", "storage"]
);
const returnsTotal = (row) => rowFeeTotal(
  row, ["returnProcessing", "reverseLogistics"]
);
const additionalServicesTotal = (row) => rowFeeTotal(
  row, ["disposal", "oversizeProcessing", "operationalErrors"]
);
const promotionAdsTotal = (row) => rowFeeTotal(
  row, ["payPerClick", "payPerOrder", "starProducts", "paidBrand", "reviews"]
);
const firstLegCost = (row) => {
  if (row.weightG === null || row.weightG === "" || !Number.isFinite(Number(row.weightG))) return null;
  return Number(row.weightG) / 1000 * state.logisticsFactorUsdKg * state.usdToCny;
};
const landedTotalCost = (row) => {
  const firstLeg = firstLegCost(row);
  if (row.purchaseCost === null || row.purchaseCost === "" || firstLeg === null) return null;
  return (Number(row.purchaseCost) + firstLeg) * Number(row.delivered || 0);
};
const salesExpense = (row) => Math.abs([
  "ozonCommission", "acquiring",
  "shipmentProcessing", "logistics", "lastMile", "storage",
  "returnProcessing", "reverseLogistics",
  "disposal", "oversizeProcessing", "operationalErrors",
  "payPerClick", "payPerOrder", "starProducts", "paidBrand", "reviews",
].reduce((total, key) => total + Number(row[key] || 0), 0));
const afterTaxTotalSales = (row) => salesTotal(row) * (1 - state.taxRate);
const grossProfit = (row) => {
  const landed = landedTotalCost(row);
  if (landed === null) return null;
  return (afterTaxTotalSales(row) - salesExpense(row))
    * (1 - state.withdrawalRate) * state.rubToCny - landed;
};
const unitProfit = (row) => {
  const gross = grossProfit(row);
  const delivered = Number(row.delivered || 0);
  return gross === null || delivered <= 0 ? null : gross / delivered;
};
const cny = (value) => value !== null && value !== "" && Number.isFinite(Number(value))
  ? `¥${Number(value).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  : "—";
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 2600);
}

function costGroups(rows) {
  return [
    ["Ozon佣金", absSum(rows, ["ozonCommission"])],
    ["收单业务", absSum(rows, ["acquiring"])],
    ["配送和存储", absSum(rows, ["shipmentProcessing", "logistics", "lastMile", "storage"])],
    ["退货", absSum(rows, ["returnProcessing", "reverseLogistics"])],
    ["附加服务", absSum(rows, ["disposal", "oversizeProcessing", "operationalErrors"])],
    ["推广和广告", absSum(rows, ["payPerClick", "payPerOrder", "starProducts", "paidBrand", "reviews"])],
  ];
}

function renderKpis() {
  const rows = state.filtered;
  const revenue = sum(rows, "revenue");
  const totalSales = rows.reduce((total, row) => total + salesTotal(row), 0);
  const delivered = sum(rows, "delivered");
  const platform = absSum(rows, ["ozonCommission", "acquiring"]);
  const fulfillment = absSum(rows, ["shipmentProcessing", "logistics", "lastMile", "storage", "returnProcessing", "reverseLogistics", "disposal", "oversizeProcessing", "operationalErrors"]);
  const ads = absSum(rows, ["payPerClick", "payPerOrder", "starProducts", "paidBrand", "reviews"]);
  const purchaseCostTotal = rows.reduce((total, row) => (
    total + (Number(row.purchaseCost) || 0) * (Number(row.delivered) || 0)
  ), 0);
  const matchedCostCount = rows.filter((row) => Number.isFinite(Number(row.purchaseCost))).length;
  const grossProfitTotal = rows.reduce((total, row) => {
    const value = grossProfit(row);
    return total + (value === null ? 0 : value);
  }, 0);
  document.getElementById("selectedProfitTotal").textContent = `所选商品毛利润合计 ${cny(grossProfitTotal)}`;
  const items = [
    ["销售总额", money(totalSales), "营业收入＋折扣积分＋合作伙伴计划", "#168f91"],
    ["已交付数量", delivered.toLocaleString("zh-CN"), "件", "#2367d1"],
    ["平台佣金及收单", money(platform), `${totalSales ? (platform / totalSales * 100).toFixed(1) : 0}% 销售总额占比`, "#f2b134"],
    ["配送及服务费用", money(fulfillment), `${totalSales ? (fulfillment / totalSales * 100).toFixed(1) : 0}% 销售总额占比`, "#da8b28"],
    ["推广和广告", money(ads), `${totalSales ? (ads / totalSales * 100).toFixed(1) : 0}% 销售总额占比`, "#e76f51"],
    ["商品数", rows.length.toLocaleString("zh-CN"), "当前筛选", "#243a5a"],
  ];
  items[5] = ["采购成本合计", cny(purchaseCostTotal), `${matchedCostCount}/${rows.length} 个商品已匹配`, "#243a5a"];
  document.getElementById("kpiGrid").innerHTML = items.map(([label, value, note, color]) => `
    <article class="kpi" style="--accent:${color}">
      <span>${label}</span><strong>${value}</strong><small>${note}</small>
    </article>
  `).join("");
}

function renderCostBars() {
  const groups = costGroups(state.filtered);
  const max = Math.max(1, ...groups.map((item) => item[1]));
  document.getElementById("costBars").innerHTML = groups.map(([label, value]) => `
    <div class="cost-row">
      <span>${label}</span>
      <div class="cost-track"><div class="cost-fill" style="width:${Math.max(2, value / max * 100)}%"></div></div>
      <strong class="cost-value">${money(value)}</strong>
    </div>
  `).join("");
}

function renderTopProducts() {
  const top = [...state.filtered]
    .filter((row) => grossProfit(row) !== null)
    .sort((a, b) => grossProfit(b) - grossProfit(a))
    .slice(0, 8);
  document.getElementById("topProducts").innerHTML = top.map((row) => `
    <article class="product-card">
      <img src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(row.offerId)}" loading="lazy" />
      <strong title="${escapeHtml(row.offerId)}">${escapeHtml(row.offerId)}</strong>
      <span>${cny(grossProfit(row))}</span>
    </article>
  `).join("");
}

const cell = (value, className = "") => `<td class="${className}">${value}</td>`;
const moneyCell = (value) => cell(escapeHtml(money(value)), `money ${Number(value) < 0 ? "negative" : ""}`);
const cnyCell = (value) => cell(escapeHtml(cny(value)), "money");

function renderTable() {
  const body = document.getElementById("productBody");
  body.innerHTML = state.filtered.map((row) => `
    <tr>
      ${cell(state.currentUser?.role === "admin"
        ? `<select class="operator-input" data-sku="${escapeHtml(row.sku)}">
            <option value="" ${!state.operators[row.sku] ? "selected" : ""}>未分配</option>
            <option value="梦婷" ${state.operators[row.sku] === "梦婷" ? "selected" : ""}>梦婷</option>
            <option value="云湖" ${state.operators[row.sku] === "云湖" ? "selected" : ""}>云湖</option>
          </select>`
        : escapeHtml(state.currentUser?.operator || ""))}
      ${cell(`<img class="product-image" src="${escapeHtml(row.imageUrl)}" alt="${escapeHtml(row.offerId)}" loading="lazy" />`)}
      ${cell(escapeHtml(row.sku))}
      ${cell(escapeHtml(row.offerId))}
      ${cnyCell(row.purchaseCost)}
      ${cell(Number(row.delivered || 0).toLocaleString("zh-CN"))}
      ${cnyCell(firstLegCost(row))}
      ${cnyCell(landedTotalCost(row))}
      ${moneyCell(afterTaxTotalSales(row))}
      ${moneyCell(salesExpense(row))}
      ${cnyCell(grossProfit(row))}
      ${cnyCell(unitProfit(row))}
      ${moneyCell(salesTotal(row))}
      ${moneyCell(row.revenue)}
      ${moneyCell(row.discountPoints)}
      ${moneyCell(row.partnerPrograms)}
      ${moneyCell(row.ozonCommission)}
      ${moneyCell(row.acquiring)}
      ${moneyCell(row.shipmentProcessing)}
      ${moneyCell(row.logistics)}
      ${moneyCell(row.lastMile)}
      ${moneyCell(row.storage)}
      ${cell(escapeHtml(money(deliveryStorageTotal(row))), "money group-total-cell")}
      ${moneyCell(row.returnProcessing)}
      ${moneyCell(row.reverseLogistics)}
      ${cell(escapeHtml(money(returnsTotal(row))), "money group-total-cell")}
      ${moneyCell(row.disposal)}
      ${moneyCell(row.oversizeProcessing)}
      ${moneyCell(row.operationalErrors)}
      ${cell(escapeHtml(money(additionalServicesTotal(row))), "money group-total-cell")}
      ${moneyCell(row.payPerClick)}
      ${moneyCell(row.payPerOrder)}
      ${moneyCell(row.starProducts)}
      ${moneyCell(row.paidBrand)}
      ${moneyCell(row.reviews)}
      ${cell(escapeHtml(money(promotionAdsTotal(row))), "money group-total-cell")}
    </tr>
  `).join("") || `<tr><td colspan="36">没有匹配商品</td></tr>`;
  document.getElementById("rowCount").textContent = `${state.filtered.length} 个商品`;
}

function render() {
  renderKpis();
  renderCostBars();
  renderTopProducts();
  renderTable();
}

function applyFilters() {
  const value = state.searchTerm;
  state.filtered = state.rows.filter((row) => {
    const matchesSearch = !value
      || [row.sku, row.offerId].some((item) => String(item).toLowerCase().includes(value));
    const matchesOperator = !state.selectedOperator
      || state.operators[row.sku] === state.selectedOperator;
    return matchesSearch && matchesOperator;
  });
  document.querySelectorAll(".operator-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.operator === state.selectedOperator);
  });
  render();
}

function filterRows(term) {
  state.searchTerm = String(term || "").trim().toLowerCase();
  applyFilters();
}

function exportCsv() {
  const headers = ["运营", "SKU", "货号", "采购成本（人民币）", "已交付数量", "头程费用（人民币）", "到俄总成本（人民币）", "税后总销售额（卢布）", "销售总费用（卢布）", "毛利润（人民币）", "单品利润（人民币）", "销售总额", "营业收入", "折扣积分", "合作伙伴计划", "Ozon平台佣金", "收单手续费", "货件处理", "物流", "配送至取货点", "存储费用", "配送和存储汇总", "退货处理", "逆向物流", "退货汇总", "销毁", "体积和重量特征额外处理", "操作错误", "附加服务汇总", "按点击付费", "按订单付费", "明星商品", "品牌推广", "评价管理", "推广和广告汇总"];
  const keys = ["operator", "sku", "offerId", "purchaseCost", "delivered", "firstLegCost", "landedTotalCost", "afterTaxTotalSales", "salesExpense", "grossProfit", "unitProfit", "salesTotal", "revenue", "discountPoints", "partnerPrograms", "ozonCommission", "acquiring", "shipmentProcessing", "logistics", "lastMile", "storage", "deliveryStorageTotal", "returnProcessing", "reverseLogistics", "returnsTotal", "disposal", "oversizeProcessing", "operationalErrors", "additionalServicesTotal", "payPerClick", "payPerOrder", "starProducts", "paidBrand", "reviews", "promotionAdsTotal"];
  const csv = [headers, ...state.filtered.map((row) => keys.map((key) => {
    if (key === "operator") return state.operators[row.sku] || "";
    if (key === "salesTotal") return salesTotal(row);
    if (key === "firstLegCost") return firstLegCost(row);
    if (key === "landedTotalCost") return landedTotalCost(row);
    if (key === "afterTaxTotalSales") return afterTaxTotalSales(row);
    if (key === "salesExpense") return salesExpense(row);
    if (key === "grossProfit") return grossProfit(row);
    if (key === "unitProfit") return unitProfit(row);
    if (key === "deliveryStorageTotal") return deliveryStorageTotal(row);
    if (key === "returnsTotal") return returnsTotal(row);
    if (key === "additionalServicesTotal") return additionalServicesTotal(row);
    if (key === "promotionAdsTotal") return promotionAdsTotal(row);
    return row[key];
  }))]
    .map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"', '""')}"`).join(",")).join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" }));
  link.download = `ozon-russia-operations-${state.meta.period.from}-${state.meta.period.to}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
  showToast("已导出当前筛选数据");
}

async function loadExchangeRates() {
  try {
    const response = await fetch("/api/exchange-rate", { cache: "no-store" });
    const payload = await response.json();
    const rubRate = Number(payload?.data?.rubToCny);
    const usdRate = Number(payload?.data?.usdToCny);
    if (Number.isFinite(rubRate) && rubRate > 0) state.rubToCny = rubRate;
    if (Number.isFinite(usdRate) && usdRate > 0) state.usdToCny = usdRate;
    document.getElementById("rateSource").textContent =
      `中国银行 · 美元兑人民币 ${state.usdToCny.toFixed(4)} · ${payload?.data?.publishedAt || "最新"}`;
  } catch {
    document.getElementById("rateSource").textContent = "汇率暂用最近成功值";
  }
  document.getElementById("rubRateInput").value = state.rubToCny.toFixed(4);
  document.getElementById("logisticsFactorInput").value = state.logisticsFactorUsdKg;
  document.getElementById("taxRateInput").value = (state.taxRate * 100).toFixed(1);
  document.getElementById("withdrawalRateInput").value = (state.withdrawalRate * 100).toFixed(1);
}

function updateMonthButtons() {
  const index = state.months.findIndex((item) => item.month === state.currentMonth);
  document.getElementById("prevMonthBtn").disabled = index <= 0;
  document.getElementById("nextMonthBtn").disabled = index < 0 || index >= state.months.length - 1;
}

async function loadMonth(month) {
  const entry = state.months.find((item) => item.month === month);
  if (!entry) return;
  const response = await fetch(`/api/russia/month/${encodeURIComponent(month)}?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`数据加载失败：${response.status}`);
  state.meta = await response.json();
  state.rows = state.meta.rows || [];
  state.currentMonth = month;
  document.getElementById("monthSelect").value = month;
  updateMonthButtons();
  document.getElementById("syncText").textContent = `已加载 ${state.rows.length} 个商品 · ${state.meta.period.from} 至 ${state.meta.period.to} · 数据源：${state.meta.source}`;
  applyFilters();
}

async function load() {
  state.currentUser = await window.dashboardAuthReady;
  if (state.currentUser.role !== "admin") {
    state.selectedOperator = state.currentUser.operator || "";
    document.querySelectorAll(".operator-filter").forEach((button) => {
      button.hidden = button.dataset.operator !== state.selectedOperator;
    });
  }
  const assignmentResponse = await fetch("/api/russia/operators", { cache: "no-store" });
  if (!assignmentResponse.ok) throw new Error("SKU归属加载失败");
  state.operators = (await assignmentResponse.json()).assignments || {};
  if (state.currentUser.role === "admin" && !Object.keys(state.operators).length) {
    try {
      const legacy = JSON.parse(localStorage.getItem("russiaProductOperators") || "{}");
      const entries = Object.entries(legacy).filter(([, operator]) => (
        operator === "梦婷" || operator === "云湖"
      ));
      for (const [sku, operator] of entries) {
        const response = await fetch(`/api/russia/operators/${encodeURIComponent(sku)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operator }),
        });
        if (response.ok) state.operators[sku] = operator;
      }
      if (entries.length) showToast(`已将 ${entries.length} 个SKU归属迁移到服务器`);
    } catch {
      showToast("旧SKU归属迁移失败，请在运营列重新分配");
    }
  }
  await loadExchangeRates();
  let manifest;
  try {
    const response = await fetch(`${MONTHS_URL}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`月份清单加载失败：${response.status}`);
    manifest = await response.json();
  } catch {
    manifest = { months: [{ month: "2026-06", label: "2026年6月", file: "russia-unit-economics-2026-06.json" }] };
  }
  state.months = [...(manifest.months || [])].sort((a, b) => a.month.localeCompare(b.month));
  if (!state.months.length) throw new Error("尚未发现可用月份数据");
  document.getElementById("monthSelect").innerHTML = state.months
    .map((item) => `<option value="${escapeHtml(item.month)}">${escapeHtml(item.label)}</option>`)
    .join("");
  await loadMonth(state.months[state.months.length - 1].month);
}

document.getElementById("searchInput").addEventListener("input", (event) => filterRows(event.target.value));
document.getElementById("exportBtn").addEventListener("click", exportCsv);
document.getElementById("monthSelect").addEventListener("change", (event) => {
  loadMonth(event.target.value).catch((error) => showToast(error.message));
});
document.getElementById("prevMonthBtn").addEventListener("click", () => {
  const index = state.months.findIndex((item) => item.month === state.currentMonth);
  if (index > 0) loadMonth(state.months[index - 1].month).catch((error) => showToast(error.message));
});
document.getElementById("nextMonthBtn").addEventListener("click", () => {
  const index = state.months.findIndex((item) => item.month === state.currentMonth);
  if (index >= 0 && index < state.months.length - 1) {
    loadMonth(state.months[index + 1].month).catch((error) => showToast(error.message));
  }
});
document.querySelectorAll(".operator-filter").forEach((button) => {
  button.addEventListener("click", () => {
    state.selectedOperator = button.dataset.operator;
    applyFilters();
  });
});
document.getElementById("productBody").addEventListener("change", async (event) => {
  const input = event.target.closest(".operator-input");
  if (!input) return;
  const operator = input.value.trim();
  try {
    const response = await fetch(`/api/russia/operators/${encodeURIComponent(input.dataset.sku)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operator }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "归属保存失败");
    if (operator) state.operators[input.dataset.sku] = operator;
    else delete state.operators[input.dataset.sku];
    showToast("运营人员已保存到服务器");
    if (state.selectedOperator) applyFilters();
  } catch (error) {
    showToast(error.message);
    loadMonth(state.currentMonth).catch(() => {});
  }
});
document.getElementById("taxRateInput").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  if (Number.isFinite(value) && value >= 0) {
    state.taxRate = value / 100;
    render();
  }
});
document.getElementById("withdrawalRateInput").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  if (Number.isFinite(value) && value >= 0) {
    state.withdrawalRate = value / 100;
    render();
  }
});
document.getElementById("rubRateInput").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  if (Number.isFinite(value) && value > 0) state.rubToCny = value;
});
document.getElementById("logisticsFactorInput").addEventListener("input", (event) => {
  const value = Number(event.target.value);
  if (Number.isFinite(value) && value >= 0) {
    state.logisticsFactorUsdKg = value;
    render();
  }
});
load().catch((error) => {
  document.getElementById("syncText").textContent = "加载失败";
  showToast(error.message);
});
