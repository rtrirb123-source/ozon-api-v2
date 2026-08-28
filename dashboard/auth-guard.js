(function () {
  "use strict";

  document.documentElement.classList.add("auth-checking");
  const ready = fetch("/api/auth/me", { credentials: "same-origin", cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) {
        const next = encodeURIComponent(location.pathname + location.search + location.hash);
        location.replace(`/login.html?next=${next}`);
        throw new Error("未登录");
      }
      const payload = await response.json();
      window.dashboardUser = payload.user;
      document.documentElement.classList.remove("auth-checking");
      document.dispatchEvent(new CustomEvent("dashboard-auth-ready", { detail: payload.user }));
      injectAccountControls(payload.user);
      injectPortalNavigation();
      return payload.user;
    });

  window.dashboardAuthReady = ready;

  function injectAccountControls(user) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => injectAccountControls(user), { once: true });
      return;
    }
    const host = document.querySelector(".shell, .page-shell, main, body");
    if (!host || document.querySelector(".account-controls")) return;
    const controls = document.createElement("div");
    controls.className = "account-controls";
    controls.innerHTML = `
      <span class="account-name"></span>
      ${user.role === "admin" ? '<a href="/user-management.html">用户管理</a>' : ""}
      <button type="button">退出登录</button>
    `;
    controls.querySelector(".account-name").textContent =
      user.role === "admin" ? `${user.username}（管理员）` : `${user.username}（${user.operator}）`;
    controls.querySelector("button").addEventListener("click", async () => {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
      location.replace("/login.html");
    });
    host.prepend(controls);
  }

  function injectPortalNavigation() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", injectPortalNavigation, { once: true });
      return;
    }
    if (document.querySelector(".unified-portal-nav")) return;
    const pathname = location.pathname === "/" ? "/index.html" : location.pathname;
    const active = (href) => pathname === href ? " active" : "";
    const isOzonSection = [
      "/index.html", "/russia-operations.html", "/replenishment.html",
    ].includes(pathname);
    const isTakealotSection = pathname === "/takealot.html";
    const nav = document.createElement("div");
    nav.className = "unified-portal-nav";
    nav.innerHTML = `
      <div class="portal-section-title"><span class="portal-status-dot"></span>跨境经营看板</div>
      <div class="portal-country-row">
        <div class="portal-country-group">
          <span class="portal-country-label">俄罗斯</span>
          <nav class="portal-platform-nav" aria-label="俄罗斯平台看板">
            <a class="${active("/index.html")}" href="/index.html">Ozon本土看板</a>
            <a class="${active("/wb.html")}" href="/wb.html">WB本土看板</a>
            <a class="${active("/wb-cross.html")}" href="/wb-cross.html">WB跨境店</a>
            <a class="${active("/inventory.html")}" href="/inventory.html">库存看板</a>
          </nav>
        </div>
        <div class="portal-country-group portal-country-group-sa">
          <span class="portal-country-label">南非</span>
          <nav class="portal-platform-nav" aria-label="南非平台看板">
            <a class="${isTakealotSection ? " active" : ""}" href="/takealot.html">Takealot看板</a>
          </nav>
        </div>
      </div>
      ${isOzonSection ? `
        <nav class="portal-ozon-subnav" aria-label="Ozon子看板">
          <a class="${active("/index.html")}" href="/index.html">经营概览</a>
          <a class="${active("/russia-operations.html")}" href="/russia-operations.html">Ozon经营看板</a>
          <a class="${active("/replenishment.html")}" href="/replenishment.html">补库存</a>
        </nav>` : ""}
    `;
    document.body.prepend(nav);
  }
})();
