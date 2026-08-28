const test = require("node:test");
const assert = require("node:assert/strict");
const { buildDashboard, VAT_RATE } = require("../src/takealot");

function daysAgo(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  date.setUTCHours(10, 0, 0, 0);
  return date.toISOString();
}

test("buildDashboard reconciles sales, stock, returns and Takealot VAT details", () => {
  const payload = buildDashboard({
    offers: [{
      offer_id: 101, sku: "ZA-001", title: "Slow feeder insert", status: "buyable",
      selling_price: 179, rrp: 199, benchmark_price: 189,
      page_views_30_days: 100, conversion_percentage_30_days: 4.5,
      conversion_percentage_previous_30_days: 5.5, listing_quality: 76,
      takealot_warehouse_stock: [
        { region: "JHB", quantity_available: 4, stock_on_way: 2, stock_in_receiving: 1, quantity_sold_30_days: 20 },
        { region: "CPT", quantity_available: 2, stock_on_way: 0, stock_in_receiving: 0, quantity_sold_30_days: 10 },
      ],
      offer_charges: [{ order_type: "in_stock", estimated_success_fee: 17.9, estimated_fulfilment_fee: 33 }],
    }],
    sales: [
      { offer_id: 101, order_date: daysAgo(2), sale_status: "Shipped", selling_price: 179, quantity: 2, total_fees: 55 },
      { offer_id: 101, order_date: daysAgo(35), sale_status: "Shipped", selling_price: 169, quantity: 1, total_fees: 50 },
      { offer_id: 101, order_date: daysAgo(1), sale_status: "Cancelled", selling_price: 179, quantity: 9, total_fees: 55 },
    ],
    returns: [{ offer_id: 101, return_date: daysAgo(1).slice(0, 10), quantity: 1, return_reason: "defective_or_damaged" }],
    fetchedAt: "2026-08-27T00:00:00.000Z",
  });

  assert.equal(VAT_RATE, 0.15);
  assert.equal(payload.summary.offerCount, 1);
  assert.equal(payload.summary.units30, 2);
  assert.equal(payload.summary.revenue30, 358);
  assert.equal(payload.summary.actualFees30, 110);
  assert.equal(payload.summary.platformReceivable30, 248);
  assert.equal(payload.summary.returnRate30, 0.5);
  assert.equal(payload.summary.availableStock, 6);
  assert.equal(payload.summary.onWayStock, 3);

  const product = payload.products[0];
  assert.equal(product.previousUnits30, 1);
  assert.equal(product.salesGrowth30, 1);
  assert.equal(product.stock.coverDays, 6);
  assert.ok(Math.abs(product.charges.commissionVat - 2.685) < 1e-9);
  assert.ok(Math.abs(product.charges.fulfilmentVat - 4.95) < 1e-9);
  assert.ok(Math.abs(product.charges.contribution - 120.465) < 1e-9);
  assert.deepEqual(product.returnReasons, { defective_or_damaged: 1 });
  assert.ok(product.alerts.includes("库存不足14天"));
  assert.ok(product.alerts.includes("转化下降"));
  assert.ok(product.alerts.includes("Listing质量低"));
  assert.ok(product.alerts.includes("退货率偏高"));
});

test("buildDashboard creates a complete 30-day trend without sales", () => {
  const payload = buildDashboard({ offers: [], sales: [], returns: [] });
  assert.equal(payload.trend.length, 30);
  assert.ok(payload.trend.every((row) => row.units === 0 && row.revenue === 0));
  assert.equal(payload.summary.returnRate30, 0);
});
