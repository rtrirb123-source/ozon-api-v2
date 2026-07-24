"use strict";

const https = require("https");
const { SocksProxyAgent } = require("socks-proxy-agent");

const proxyUrl = process.env.API_SOCKS_PROXY;
const enabled = process.env.API_PROXY_ENABLED === "1" && proxyUrl;
const suffixes = [".ozon.ru", ".wildberries.ru"];

if (enabled) {
  const agent = new SocksProxyAgent(proxyUrl);
  const originalRequest = https.request;

  https.request = function proxiedApiRequest(...args) {
    const first = args[0];
    if (first && typeof first === "object" && !(first instanceof URL)) {
      const hostname = String(first.hostname || first.host || "").split(":")[0].toLowerCase();
      if (suffixes.some((suffix) => hostname.endsWith(suffix))) {
        args[0] = { ...first, agent };
      }
    }
    return originalRequest.apply(this, args);
  };

  console.log("[api-proxy] Ozon/WB domain proxy enabled");
}
