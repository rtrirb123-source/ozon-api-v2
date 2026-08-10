const assert = require("node:assert/strict");
const { classifyCampaign, summarizeCampaignInventory } = require("../src/advertising_strategy");

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
console.log("advertising strategy tests passed");
