const https = require("https");

const BOC_URL = "https://www.bankofchina.com/sourcedb/whpj/";
let cache = null;

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      },
      timeout: 20000
    }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`BOC exchange rate HTTP ${res.statusCode}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("timeout", () => req.destroy(new Error("BOC exchange rate timeout")));
    req.on("error", reject);
    req.end();
  });
}

function stripTags(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCurrency(html, currencyName) {
  const escaped = currencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rowMatch = html.match(new RegExp(`<tr[^>]*data-currency=['"]${escaped}['"][\\s\\S]*?<\\/tr>`, "i"));
  if (!rowMatch) return null;
  const section = stripTags(rowMatch[0]);
  const numbers = section.match(/\d+(?:\.\d+)?/g) || [];
  const conversionRate = Number(numbers[4]);
  if (!Number.isFinite(conversionRate) || conversionRate <= 0) return null;
  const dateMatch = section.match(/\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}/);
  return { conversionRate, publishedAt: dateMatch ? dateMatch[0] : null };
}

async function getRubRate() {
  if (cache && Date.now() - cache.cachedAt < 6 * 60 * 60 * 1000) return cache;
  try {
    const html = await fetchHtml(BOC_URL);
    const rub = parseCurrency(html, "卢布");
    const usd = parseCurrency(html, "美元");
    if (!rub) throw new Error("BOC RUB conversion rate not found");
    if (!usd) throw new Error("BOC USD conversion rate not found");
    cache = {
      cnyToRub: 100 / rub.conversionRate,
      rubToCny: rub.conversionRate / 100,
      bocConversionRate: rub.conversionRate,
      usdToCny: usd.conversionRate / 100,
      usdBocConversionRate: usd.conversionRate,
      source: "Bank of China foreign exchange quotation",
      sourceUrl: BOC_URL,
      publishedAt: rub.publishedAt || usd.publishedAt,
      fetchedAt: new Date().toISOString(),
      cachedAt: Date.now()
    };
  } catch (error) {
    cache = {
      cnyToRub: 1 / 0.0907,
      rubToCny: 0.0907,
      usdToCny: 7.2,
      source: "fallback",
      warning: error.message,
      fetchedAt: new Date().toISOString(),
      cachedAt: Date.now()
    };
  }
  return cache;
}

module.exports = { getRubRate };
