const test = require("node:test");
const assert = require("node:assert/strict");
const advertising = require("../src/advertising_strategy");
const promotions = require("../src/promotion_strategy");
const content = require("../src/content_strategy");
const operationQueue = require("../src/operation_queue");
const executionGuard = require("../src/execution_guard");
const promotionSync = require("../src/ozon_promotion_sync");

test("advertising strategy scales only profitable stocked products", () => {
  const row = advertising.recommend({ offerId: "A", sku: "1", adCostRate14: 8, adSpend14Rub: 1000 }, {
    currentMargin: 24, stock: 100, sales7: 10, blocked: false
  }, [{ campaign_id: "10", campaign_title: "PPC", weekly_budget: 1000, bid: 20 }]);
  assert.equal(row.action, "increase_budget");
  assert.equal(row.targetBudget, 1100);
  assert.equal(row.executable, false);
});

test("advertising strategy blocks action without ad data", () => {
  const row = advertising.recommend({ offerId: "A", sku: "1", adCostRate14: null }, { currentMargin: 20, stock: 100, sales7: 10 });
  assert.equal(row.action, "wait_data");
});

test("advertising strategy does not invent a budget action without an active campaign", () => {
  const row = advertising.recommend({ offerId: "A", sku: "1", adCostRate14: 8 }, {
    currentMargin: 24, stock: 100, sales7: 10, blocked: false
  }, []);
  assert.equal(row.action, "review_campaign_setup");
  assert.equal(row.campaignId, "");
});

test("advertising inventory separates product campaigns from external tracking", () => {
  const data = advertising.summarizeCampaignInventory([
    { campaign_id: "1", state: "CAMPAIGN_STATE_RUNNING", adv_object_type: "SKU", controllable: true, product_links: 2 },
    { campaign_id: "2", state: "CAMPAIGN_STATE_RUNNING", adv_object_type: "REF_VK", controllable: false, product_links: 0 },
    { campaign_id: "3", state: "CAMPAIGN_STATE_RUNNING", adv_object_type: "BANNER", controllable: false, product_links: 0 },
  ]);
  assert.equal(data.summary.runningControllable, 1);
  assert.equal(data.summary.ready, 1);
  assert.equal(data.summary.externalTracking, 1);
  assert.equal(data.summary.total, 2);
  assert.equal(data.summary.productTotal, 1);
  assert.equal(data.summary.runningProducts, 1);
  assert.equal(data.summary.otherTotal, 1);
  assert.equal(data.summary.runningOther, 1);
  assert.equal(data.campaigns.length, 2);
  assert.equal(data.externalTrackingRecords[0].readiness, "tracking_only");
});

test("Ozon backend architecture excludes banking from automation", () => {
  const architecture = require("../src/ozon_backend_architecture").overview();
  assert.equal(architecture.summary.total, 9);
  assert.equal(architecture.modules.find((item) => item.key === "bank").status, "excluded");
  assert.match(architecture.modules.find((item) => item.key === "advertising").automation, /分开统计/);
});

test("promotion strategy protects the profit floor", () => {
  const row = promotions.recommend(
    { offerId: "A", currentMargin: 6, currentPrice: 1200, minimumPrice: 1000, stock: 100, sales7: 10, blocked: false },
    [{ action_id: 9, relation: "participating", action_price: 900, max_action_price: 950, action_title: "Sale" }]
  );
  assert.equal(row.action, "review_exit");
  assert.equal(row.activityId, "9");
  assert.equal(row.executable, false);
});

test("promotion strategy joins only a real candidate above the profit floor", () => {
  const row = promotions.recommend(
    { offerId: "B", currentMargin: 28, currentPrice: 2000, minimumPrice: 1500, stock: 100, sales7: 10, blocked: false },
    [{ action_id: 10, relation: "candidate", action_price: 0, max_action_price: 1700, action_title: "Boost" }]
  );
  assert.equal(row.action, "review_join");
  assert.equal(row.maxActionPrice, 1700);
});

test("promotion sync keeps a current activity when used as an array filter", () => {
  const actions = [{ date_start: "2026-07-01T00:00:00Z", date_end: "2026-09-01T00:00:00Z" }];
  assert.equal(actions.filter((action) => promotionSync.relevant(action, Date.parse("2026-08-03T00:00:00Z"))).length, 1);
});

test("pricing recommendations expose the Ozon product id for promotion mapping", () => {
  const row = require("../src/pricing_strategy").recommendPrice(
    { offer_id: "A", product_id: "123", ozon_sku: "456", price: 2000, purchase_cost: 100, weight: 1, commission_rate: 10, fbo_stock: 20 },
    { sales_7d: 1, sales_prev_7d: 1 }, { rubToCny: 0.08, usdToCny: 7 },
    { taxRate: 0, withdrawalRate: 0, firstLegRateUsdPerKg: 0, exchangeLossRate: 0 }, {}, {}
  );
  assert.equal(row.productId, "123");
});

test("content strategy identifies missing foundations", () => {
  const row = content.recommend({ offer_id: "A", ozon_sku: "1", title: "短标题", image_url: "", competitor_compare: "" });
  assert.equal(row.action, "optimize_content");
  assert.ok(row.issues.includes("缺少主图"));
});

test("action queue accepts only explicit review decisions", () => {
  assert.equal(operationQueue.normalizeDecision("approved"), "approved");
  assert.equal(operationQueue.normalizeDecision("cancelled"), "cancelled");
  assert.throws(() => operationQueue.normalizeDecision("executing"), /approved or cancelled/);
});

test("execution preview blocks advertising actions without campaign and target values", () => {
  const preview = executionGuard.buildSimulation({
    id: 1, status: "approved", source: "ozon_advertising", action_type: "increase_budget",
    entity_type: "product", entity_id: "A", payload: { adRate14: 8, margin: 20 }
  });
  assert.equal(preview.ready, false);
  assert.equal(preview.platformWrite, false);
  assert.ok(preview.checks.some((item) => item.key === "campaign_id" && !item.passed));
  assert.equal(preview.rollbackPayload.platformWrite, false);
});

test("execution preview can become ready without enabling platform writes", () => {
  const preview = executionGuard.buildSimulation({
    id: 2, status: "approved", source: "ozon_advertising", action_type: "increase_budget",
    entity_type: "product", entity_id: "B", payload: { campaignId: "10", targetBudget: 1200, currentState: { budget: 1000 } }
  });
  assert.equal(preview.ready, true);
  assert.equal(preview.platformWrite, false);
  assert.equal(preview.liveExecutionAllowed, false);
});
