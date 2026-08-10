const assert = require("node:assert/strict");
const { classifyCampaign, summarizeCampaignInventory, recommend, recommendCampaignBudgets } = require("../src/advertising_strategy");

const allSku = classifyCampaign({
  campaign_id: "23441397",
  adv_object_type: "ALL_SKU_PROMO",
  state: "CAMPAIGN_STATE_RUNNING",
  controllable: true,
  product_links: 17,
  weekly_budget: 48000
});

assert.equal(allSku.kind, "product_campaign");
assert.equal(allSku.readiness, "ready");
assert.equal(allSku.productLinks, 17);

const summary = summarizeCampaignInventory([{
  campaign_id: "23441397",
  adv_object_type: "ALL_SKU_PROMO",
  state: "CAMPAIGN_STATE_RUNNING",
  controllable: true,
  product_links: 17
}]).summary;

assert.equal(summary.runningProducts, 1);
assert.equal(summary.ready, 1);
assert.equal(summary.mappedProductLinks, 17);

const product = recommend({ offerId: "offer-1", sku: "sku-1", title: "A", adCostRate14: 5, adSpend14Rub: 100 }, {
  currentCostProfitRatio: 100, profitZone: "safe", stock: 100, sales7: 10
}, [{ campaign_id: "23441397", campaign_title: "PPC", weekly_budget: 48000, bid: 15 }]);
assert.equal(product.action, "increase_bid");
assert.equal(product.currentBid, 15);
assert.equal(product.targetBid, 16.5);
assert.equal(product.targetBudget, null);

const inventory = [{
  campaignId: "23441397", title: "PPC", kind: "product_campaign", running: true,
  productLinks: 4, weeklyBudget: 48000
}];
const positiveRows = [
  { campaignId: "23441397", adRate14: 3, action: "increase_bid" },
  { campaignId: "23441397", adRate14: 4, action: "increase_bid" },
  { campaignId: "23441397", adRate14: 5, action: "increase_bid" },
  { campaignId: "23441397", adRate14: 8, action: "hold" }
];
const positiveCampaign = recommendCampaignBudgets(positiveRows, inventory);
assert.equal(positiveCampaign.length, 1);
assert.equal(positiveCampaign[0].action, "review_budget_capacity");
assert.equal(positiveCampaign[0].targetBudget, null);

const negativeCampaign = recommendCampaignBudgets([
  { campaignId: "23441397", adRate14: 30, action: "pause_product" },
  { campaignId: "23441397", adRate14: 20, action: "reduce_bid" },
  { campaignId: "23441397", adRate14: 18, action: "reduce_bid" },
  { campaignId: "23441397", adRate14: 8, action: "hold" }
], inventory);
assert.equal(negativeCampaign.length, 1);
assert.equal(negativeCampaign[0].action, "reduce_budget");
assert.equal(negativeCampaign[0].targetBudget, 43200);

const sparseCampaign = recommendCampaignBudgets([
  { campaignId: "23441397", adRate14: 3, action: "increase_bid" },
  { campaignId: "23441397", adRate14: null, action: "wait_data" }
], [{ ...inventory[0], productLinks: 17 }]);
assert.equal(sparseCampaign[0].action, "wait_campaign_data");
assert.equal(sparseCampaign[0].targetBudget, null);
console.log("advertising strategy tests passed");
