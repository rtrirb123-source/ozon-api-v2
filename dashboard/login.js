(function () {
  const form = document.getElementById("login-form");
  const message = document.getElementById("message");
  const button = form.querySelector("button");
  const next = new URLSearchParams(location.search).get("next") || "/index.html";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/index.html";

  fetch("/api/auth/me", { cache: "no-store" }).then((response) => {
    if (response.ok) location.replace(safeNext);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    message.textContent = "";
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          username: document.getElementById("username").value,
          password: document.getElementById("password").value,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "登录失败");
      location.replace(safeNext);
    } catch (error) {
      message.textContent = error.message;
      button.disabled = false;
    }
  });
})();
