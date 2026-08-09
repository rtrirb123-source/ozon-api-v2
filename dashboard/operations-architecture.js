(function () {
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const statusText = { connected: "已接入", partial: "部分接入", gap: "待开发", excluded: "排除" };
  const statusClass = { connected: "raise", partial: "hold", gap: "blocked", excluded: "blocked" };
  let adSummary = null;

  async function getData(url) {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || "数据加载失败");
    return body.data;
  }

  function renderArchitecture(data) {
    const summary = data.summary || {};
    const audit = data.audit || {};
    document.getElementById("architectureStatus").innerHTML = `<strong>后台模块 ${summary.total || 0} 个 · 已接入 ${summary.connected || 0} · 部分接入 ${summary.partial || 0} · 待开发 ${summary.gap || 0}</strong><span>${escapeHtml(audit.source || "")} · 巡查时间 ${audit.observedAt ? new Date(audit.observedAt).toLocaleString("zh-CN") : "—"} · 页面数值为巡查快照，不作为实时值</span>`;
    document.getElementById("architectureRows").innerHTML = (data.modules || []).map((item) => `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.source)}</td><td><span class="tag ${statusClass[item.status] || "hold"}">${statusText[item.status] || item.status}</span></td><td>${escapeHtml(item.automation)}</td><td>${escapeHtml(item.writePolicy)}</td></tr>`).join("");
    document.getElementById("architectureFacts").innerHTML = (audit.facts || []).map((fact, index) => `<div class="quality-row"><strong>${index + 1}</strong><span>${escapeHtml(fact)}</span></div>`).join("");
  }

  function renderAdvertisingHeader() {
    if (!adSummary) return;
    const target = document.getElementById("adStatus");
    if (!target) return;
    const a = adSummary;
    const html = `<strong>商品广告运行 ${a.runningProducts || 0}/${a.productTotal || 0} · 非商品推广运行 ${a.runningOther || 0}/${a.otherTotal || 0} · 可控就绪 ${a.ready || 0}</strong><span>真实广告记录 ${a.total || 0} · 商品关联 ${a.mappedProductLinks || 0} · VK/博主追踪 ${a.externalTracking || 0} · 需检查或新建商品活动 ${a.campaignSetup || 0} · 写操作保持锁定</span>`;
    if (target.innerHTML !== html) target.innerHTML = html;
  }

  async function load() {
    const [architecture, advertising] = await Promise.all([
      getData("/api/automation/backend-architecture"),
      getData("/api/automation/advertising-recommendations"),
    ]);
    renderArchitecture(architecture);
    adSummary = advertising.summary || {};
    renderAdvertisingHeader();
  }

  const adStatus = document.getElementById("adStatus");
  if (adStatus) new MutationObserver(renderAdvertisingHeader).observe(adStatus, { childList: true, subtree: true });
  document.getElementById("refresh")?.addEventListener("click", () => load().catch(() => {}));
  load().catch((error) => {
    const target = document.getElementById("architectureStatus");
    if (target) target.innerHTML = `<strong>后台架构加载失败</strong><span>${escapeHtml(error.message)}</span>`;
  });
})();
