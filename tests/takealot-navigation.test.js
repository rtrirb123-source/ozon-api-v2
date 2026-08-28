const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("unified navigation keeps Russia dashboards and adds South Africa on the right", () => {
  const nav = read("dashboard/auth-guard.js");
  assert.doesNotMatch(nav, /跨境经营看板/);
  assert.match(nav, /portal-country-group-ru/);
  assert.match(nav, /portal-country-group-sa/);
  for (const href of ["/index.html", "/wb.html", "/wb-cross.html", "/inventory.html"]) {
    assert.match(nav, new RegExp(href.replaceAll("/", "\\/")));
  }
  assert.ok(nav.indexOf("俄罗斯") < nav.indexOf("南非"));
  assert.ok(nav.indexOf('href="/inventory.html"') < nav.indexOf('href="/takealot.html"'));
  assert.match(nav, /Takealot看板/);
});

test("Takealot page wires the protected dashboard API and required operating sections", () => {
  const html = read("dashboard/takealot.html");
  const js = read("dashboard/takealot.js");
  for (const id of ["stats", "trendChart", "alerts", "regionalStock", "productBody"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /dashboardAuthReady/);
  assert.match(js, /\/api\/takealot\/dashboard/);
  assert.match(js, /佣金VAT/);
  assert.match(js, /履约VAT/);
});

test("protected inventory formula and disabled FBW default remain unchanged", () => {
  const backend = read("src/inventory.js");
  const frontend = read("dashboard/inventory.js");
  assert.match(backend, /WB_FBW_RELIABLE_SOURCE_ENABLED === "1"/);
  assert.match(frontend, /fbo \+ fboTransit \+ fbw \+ manualFbsTotal \+ unallocated/);
  assert.match(frontend, /replenish60 = Math\.max\(0, Math\.ceil\(dailyDemand \* 60 - total\)\)/);
  assert.match(frontend, /unallocated_details/);
  assert.match(frontend, /daily-shipment-history/);
});
