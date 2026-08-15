const assert = require("node:assert/strict");

process.env.MEMORY_STORE = "true";
const products = require("../src/products");

(async () => {
  const offerId = `daily-tracking-${Date.now()}`;
  await products.createProduct({ offer_id: offerId, title: "测试商品" });

  let tracked = await products.listDailyTrackedProducts();
  assert.equal(tracked.some((item) => item.offer_id === offerId), false);

  const enabled = await products.updateProduct(offerId, { daily_tracking: true });
  assert.equal(enabled.daily_tracking, true);
  tracked = await products.listDailyTrackedProducts();
  assert.equal(tracked.some((item) => item.offer_id === offerId), true);

  await products.updateProduct(offerId, { daily_tracking: false });
  tracked = await products.listDailyTrackedProducts();
  assert.equal(tracked.some((item) => item.offer_id === offerId), false);

  console.log("daily tracking tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
