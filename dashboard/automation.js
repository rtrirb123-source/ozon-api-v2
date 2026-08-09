const safetyGrid = document.querySelector("#safetyGrid");
const jobGrid = document.querySelector("#jobGrid");
const runBody = document.querySelector("#runBody");
const refreshBtn = document.querySelector("#refreshBtn");
const toast = document.querySelector("#toast");

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 2800);
}

async function api(path, options) {
  const response = await fetch(path, { cache: "no-store", ...options, headers: { "Content-Type": "application/json", ...(options?.headers || {}) } });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.data;
}

function renderSafety(data) {
  const cards = [
    ["定时调度总开关", data.masterEnabled ? "已开启" : "已关闭", data.masterEnabled ? "warn" : "safe"],
    ["Ozon 平台写操作", data.platformWritesAllowed ? "已允许" : "安全锁定", data.platformWritesAllowed ? "warn" : "safe"],
    ["调度检查周期", `${data.pollSeconds} 秒`, "safe"]
  ];
  safetyGrid.innerHTML = cards.map(([label, value, cls]) => `<article class="status-card ${cls}"><span>${label}</span><strong>${value}</strong></article>`).join("");
}

function renderJobs(jobs) {
  jobGrid.innerHTML = jobs.map((job) => `
    <article class="job-card" data-key="${escapeHtml(job.job_key)}">
      <div class="job-head"><div><h3>${escapeHtml(job.name)}</h3><p>${escapeHtml(job.description)}</p></div><span class="badge ${escapeHtml(job.last_status || "")}">${escapeHtml(job.last_status || "未运行")}</span></div>
      <div class="job-meta"><span>上次：${formatTime(job.last_run_at)}</span><span>下次：${formatTime(job.next_run_at)}</span><span>平台写入：${job.platform_write ? "是" : "否"}</span></div>
      <div class="job-actions"><label><input class="enabled" type="checkbox" ${job.enabled ? "checked" : ""}> 启用定时</label>${job.schedule_mode === "daily_times" ? `<label>北京时间 <input class="daily-times" value="${escapeHtml((job.daily_times || []).join(","))}" aria-label="北京时间，逗号分隔"></label>` : `<label>间隔 <input class="interval" type="number" min="1" max="1440" value="${Number(job.interval_minutes)}"> 分钟</label>`}<button class="run" type="button">立即运行</button></div>
    </article>`).join("");
}

function renderRuns(runs) {
  runBody.innerHTML = runs.length ? runs.map((run) => `<tr><td>${escapeHtml(run.name)}</td><td>${run.trigger_source === "manual" ? "手动" : "定时"}</td><td><span class="badge ${escapeHtml(run.status)}">${escapeHtml(run.status)}</span></td><td>${formatTime(run.started_at)}</td><td>${run.duration_ms == null ? "—" : `${run.duration_ms} ms`}</td><td>${escapeHtml(run.error || JSON.stringify(run.summary || {})).slice(0, 260)}</td></tr>`).join("") : '<tr><td colspan="6">暂无运行记录</td></tr>';
}

async function load() {
  refreshBtn.disabled = true;
  try {
    const data = await api("/api/automation/overview");
    renderSafety(data); renderJobs(data.jobs); renderRuns(data.runs);
  } catch (error) { showToast(error.message); }
  finally { refreshBtn.disabled = false; }
}

jobGrid.addEventListener("change", async (event) => {
  const card = event.target.closest(".job-card");
  if (!card || !event.target.matches(".enabled, .interval, .daily-times")) return;
  try {
    await api(`/api/automation/jobs/${encodeURIComponent(card.dataset.key)}`, {
      method: "PATCH",
      body: JSON.stringify({
        enabled: card.querySelector(".enabled").checked,
        ...(card.querySelector(".interval") ? { scheduleMode: "interval", intervalMinutes: Number(card.querySelector(".interval").value) } : {}),
        ...(card.querySelector(".daily-times") ? { scheduleMode: "daily_times", dailyTimes: card.querySelector(".daily-times").value.split(",").map((item) => item.trim()) } : {})
      })
    });
    showToast("任务设置已保存"); await load();
  } catch (error) { showToast(error.message); await load(); }
});

jobGrid.addEventListener("click", async (event) => {
  const button = event.target.closest(".run");
  const card = event.target.closest(".job-card");
  if (!button || !card) return;
  button.disabled = true; button.textContent = "运行中…";
  try { await api(`/api/automation/jobs/${encodeURIComponent(card.dataset.key)}/run`, { method: "POST", body: "{}" }); showToast("任务运行完成"); }
  catch (error) { showToast(error.message); }
  finally { await load(); }
});

refreshBtn.addEventListener("click", load);
load();
