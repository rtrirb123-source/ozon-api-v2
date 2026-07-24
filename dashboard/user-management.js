(async function () {
  const user = await window.dashboardAuthReady;
  if (user.role !== "admin") {
    location.replace("/index.html");
    return;
  }
  const operators = ["梦婷", "云湖"];
  const response = await fetch("/api/admin/users", { cache: "no-store" });
  const payload = await response.json();
  const users = payload.users || [];
  const grid = document.getElementById("user-grid");
  grid.innerHTML = operators.map((operator) => {
    const found = users.find((item) => item.operator === operator);
    return `<section class="card" data-operator="${operator}">
      <h2>${operator}</h2>
      <label class="field">登录账号<input class="username" value="${escapeHtml(found?.username || "")}" autocomplete="off"></label>
      <label class="field">登录密码<input class="password" type="password" placeholder="${found ? "留空则不修改" : "首次设置必须填写"}" autocomplete="new-password"></label>
      <button class="save" type="button">保存设置</button>
      <div class="status"></div>
    </section>`;
  }).join("");
  grid.addEventListener("click", async (event) => {
    const button = event.target.closest(".save");
    if (!button) return;
    const card = button.closest(".card");
    const operator = card.dataset.operator;
    const status = card.querySelector(".status");
    button.disabled = true;
    status.textContent = "保存中…";
    const result = await fetch(`/api/admin/users/${encodeURIComponent(operator)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: card.querySelector(".username").value,
        password: card.querySelector(".password").value,
      }),
    });
    const body = await result.json();
    status.textContent = result.ok ? "已保存" : (body.error || "保存失败");
    if (result.ok) card.querySelector(".password").value = "";
    button.disabled = false;
  });
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }
})();
