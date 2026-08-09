const pricingStrategy = require("./pricing_strategy");
const promotionSync = require("./ozon_promotion_sync");
const operationQueue = require("./operation_queue");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function recommend(row, promotionRows = []) {
  const margin = row.currentMargin;
  const stock = number(row.stock);
  const sales7 = number(row.sales7);
  const participating = promotionRows.filter((item) => item.relation === "participating");
  const candidates = promotionRows.filter((item) => item.relation === "candidate");
  let action = "hold";
  let reason = promotionRows.length ? "当前促销状态和安全底价均正常" : "尚未在Ozon促销商品清单中匹配到该商品";
  let selected = participating.sort((a, b) => number(a.action_price) - number(b.action_price))[0] || null;

  if (row.blocked || margin === null) {
    action = "blocked";
    reason = "成本或利润数据不完整，禁止生成促销动作";
  } else {
    const unsafe = participating.find((item) => number(item.action_price) > 0 && number(item.action_price) < number(row.minimumPrice));
    if (unsafe) {
      selected = unsafe;
      action = "review_exit";
      reason = `当前活动价 ${number(unsafe.action_price)} ₽ 低于安全底价 ${number(row.minimumPrice)} ₽，建议审核退出`;
    } else if (!participating.length && margin >= 22 && stock > Math.max(20, sales7 * 3)) {
      const safe = candidates
        .filter((item) => number(item.max_action_price) >= number(row.minimumPrice))
        .sort((a, b) => number(b.max_action_price) - number(a.max_action_price))[0];
      if (safe) {
        selected = safe;
        action = "review_join";
        reason = `Ozon允许的活动价上限 ${number(safe.max_action_price)} ₽ 不低于安全底价，可审核参加`;
      }
    }
  }

  const proposedActionPrice = selected
    ? (selected.relation === "participating" ? number(selected.action_price) : number(selected.max_action_price))
    : 0;
  const discountPct = proposedActionPrice > 0 && number(row.currentPrice) > 0
    ? Math.max(0, Number(((1 - proposedActionPrice / number(row.currentPrice)) * 100).toFixed(1))) : 0;
  return {
    offerId: row.offerId, sku: row.sku, title: row.title, currentPrice: row.currentPrice,
    minimumPrice: row.minimumPrice, margin, stock, sales7, action, discountPct, reason,
    activityId: selected ? String(selected.action_id) : "",
    activityTitle: selected?.action_title || "",
    activityType: selected?.action_type || "",
    promotionState: selected?.relation || "unmatched",
    actionPrice: selected ? number(selected.action_price) : 0,
    maxActionPrice: selected ? number(selected.max_action_price) : 0,
    executable: false,
    executionBlock: "只生成真实活动建议；Ozon促销写入仍保持锁定并需人工审核"
  };
}

async function recommendations() {
  const [pricing, snapshot] = await Promise.all([pricingStrategy.recommendations(), promotionSync.snapshot()]);
  const byProduct = new Map();
  for (const item of snapshot.rows) {
    const key = String(item.product_id || "");
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(item);
  }
  const rows = pricing.rows.map((row) => recommend(row, byProduct.get(String(row.productId || row.sku || "")) || []));
  return {
    generatedAt: new Date().toISOString(), mode: "advisory", platformWrite: false, rows,
    sourceStatus: snapshot.summary,
    summary: {
      products: rows.length,
      matched: rows.filter((row) => row.promotionState !== "unmatched").length,
      reviewJoin: rows.filter((row) => row.action === "review_join").length,
      reviewExit: rows.filter((row) => row.action === "review_exit").length,
      blocked: rows.filter((row) => row.action === "blocked").length,
      executable: 0
    }
  };
}

async function refreshQueue() {
  const data = await recommendations();
  const proposals = data.rows.filter((row) => ["review_join", "review_exit"].includes(row.action)).map((row) => ({
    actionType: row.action,
    entityType: "product",
    entityId: row.offerId,
    title: row.title,
    reason: row.reason,
    riskLevel: "high",
    payload: {
      sku: row.sku, activityId: row.activityId, activityTitle: row.activityTitle,
      actionPrice: row.actionPrice, maxActionPrice: row.maxActionPrice, minimumPrice: row.minimumPrice,
      currentState: { relation: row.promotionState, actionPrice: row.actionPrice }
    },
    requiresApproval: true
  }));
  const queued = await operationQueue.replaceProposals("ozon_promotions", proposals);
  return { ...data.summary, queued: queued.created, platformWrite: false };
}

module.exports = { recommend, recommendations, refreshQueue };

