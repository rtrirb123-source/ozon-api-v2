const actualCosts = require("./actual_costs");
const pricingStrategy = require("./pricing_strategy");
const operationQueue = require("./operation_queue");
const { query } = require("./db");

const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;

function classifyCampaign(row = {}) {
  const type = String(row.adv_object_type || "UNKNOWN");
  const state = String(row.state || "");
  const productLinks = number(row.product_links);
  const running = state === "CAMPAIGN_STATE_RUNNING";
  const controllable = row.controllable === true;
  const externalTracking = ["REF_VK", "REF_BLOGGER"].includes(type);
  const productCampaign = type === "SKU";
  return {
    campaignId: String(row.campaign_id || ""), title: row.title || "", type, state,
    running, controllable, productLinks,
    dailyBudget: number(row.daily_budget), weeklyBudget: number(row.weekly_budget), totalBudget: number(row.total_budget),
    kind: externalTracking ? "external_tracking" : productCampaign ? "product_campaign" : "other",
    readiness: running && productCampaign && controllable && productLinks > 0 ? "ready" : running && productCampaign && controllable ? "missing_products" : externalTracking ? "tracking_only" : "not_controllable"
  };
}

function summarizeCampaignInventory(rows = []) {
  const allRecords = rows.map(classifyCampaign);
  const campaigns = allRecords.filter((row) => row.kind !== "external_tracking");
  const externalTrackingRecords = allRecords.filter((row) => row.kind === "external_tracking");
  const productCampaigns = campaigns.filter((row) => row.kind === "product_campaign");
  const otherCampaigns = campaigns.filter((row) => row.kind === "other");
  return {
    campaigns,
    externalTrackingRecords,
    summary: {
      total: campaigns.length,
      running: campaigns.filter((row) => row.running).length,
      productTotal: productCampaigns.length,
      runningProducts: productCampaigns.filter((row) => row.running).length,
      otherTotal: otherCampaigns.length,
      runningOther: otherCampaigns.filter((row) => row.running).length,
      runningControllable: campaigns.filter((row) => row.running && row.controllable).length,
      ready: campaigns.filter((row) => row.readiness === "ready").length,
      mappedProductLinks: campaigns.reduce((sum, row) => sum + row.productLinks, 0),
      externalTracking: externalTrackingRecords.length
    }
  };
}

function recommend(product, pricing = {}, campaigns = []) {
  const adRate = product.adCostRate14;
  const costProfitRatio = pricing.currentCostProfitRatio;
  const profitZone = pricing.profitZone || "unknown";
  const stock = number(pricing.stock);
  const sales7 = number(pricing.sales7);
  let action = "hold";
  let reason = "广告消耗与利润暂时处于观察区间";
  let riskLevel = "low";

  if (adRate === null) {
    action = "wait_data";
    reason = "缺少近14天广告消耗数据，不执行预算或出价操作";
  } else if (pricing.blocked || costProfitRatio === null || costProfitRatio < 0 || adRate >= 25) {
    action = "reduce_or_pause";
    reason = pricing.blocked || costProfitRatio === null ? "成本利润率数据不完整，广告执行被拦截" : costProfitRatio < 0 ? "当前净利润为负，建议降低预算或暂停" : "广告费率达到25%以上，建议降低预算或暂停";
    riskLevel = "high";
  } else if (profitZone === "safe" && adRate <= 10 && stock > Math.max(14, sales7 * 2)) {
    action = "increase_budget";
    reason = "成本利润率在80%以上安全区，广告费率和库存满足放量条件，可小幅增加预算";
    riskLevel = "medium";
  } else if (adRate > 15 || profitZone === "danger") {
    action = "reduce_budget";
    reason = adRate > 15 ? "广告费率偏高，建议小幅降低预算" : "成本利润率低于50%危险线，建议收紧广告投入";
    riskLevel = "medium";
  }

  const activeCampaign = campaigns[0] || null;
  if (!["hold", "wait_data"].includes(action) && !activeCampaign) {
    action = "review_campaign_setup";
    reason = "存在广告优化信号，但当前没有关联到运行中的可控商品广告活动；请先检查或新建PPC活动";
    riskLevel = "medium";
  }
  const currentBudget = activeCampaign ? number(activeCampaign.weekly_budget || activeCampaign.daily_budget || activeCampaign.total_budget) : null;
  const targetBudget = currentBudget === null ? null : Number((currentBudget * (action === "increase_budget" ? 1.1 : action === "reduce_budget" ? 0.9 : action === "reduce_or_pause" ? 0.75 : 1)).toFixed(2));

  return {
    offerId: product.offerId, sku: product.sku, title: product.title, adRate14: adRate,
    adSpend14Rub: product.adSpend14Rub, costProfitRatio: costProfitRatio ?? null, profitZone, stock, sales7,
    campaignId: activeCampaign?.campaign_id || "", campaignTitle: activeCampaign?.campaign_title || "",
    currentBudget, currentBid: activeCampaign?.bid == null ? null : number(activeCampaign.bid), targetBudget,
    action, reason, riskLevel, executable: false,
    executionBlock: "Performance API写接口尚未验证；所有动作仅进入待执行队列"
  };
}

async function recommendations() {
  const [costs, pricing] = await Promise.all([actualCosts.snapshot(), pricingStrategy.recommendations()]);
  const pricingByOffer = new Map(pricing.rows.map((row) => [row.offerId, row]));
  let campaignRows = [];
  let campaignInventoryRows = [];
  try {
    const [mapped, inventory] = await Promise.all([
      query(`SELECT cp.sku,c.campaign_id,c.title AS campaign_title,c.daily_budget,c.weekly_budget,c.total_budget,cp.bid
        FROM ozon_ad_campaign_products cp JOIN ozon_ad_campaigns c ON c.campaign_id=cp.campaign_id
        WHERE c.state='CAMPAIGN_STATE_RUNNING' AND c.controllable IS TRUE ORDER BY c.fetched_at DESC,c.campaign_id`),
      query(`SELECT c.campaign_id,c.title,c.state,c.adv_object_type,c.controllable,c.daily_budget,c.weekly_budget,c.total_budget,
        COUNT(cp.sku)::int AS product_links FROM ozon_ad_campaigns c
        LEFT JOIN ozon_ad_campaign_products cp ON cp.campaign_id=c.campaign_id
        GROUP BY c.campaign_id ORDER BY (c.state='CAMPAIGN_STATE_RUNNING') DESC,c.controllable DESC,c.campaign_id`)
    ]);
    campaignRows = mapped.rows;
    campaignInventoryRows = inventory.rows;
  } catch (error) {
    if (!/does not exist|column .* does not exist/i.test(error.message || "")) throw error;
  }
  const campaignsBySku = new Map();
  for (const row of campaignRows) {
    const key = String(row.sku || "");
    if (!campaignsBySku.has(key)) campaignsBySku.set(key, []);
    campaignsBySku.get(key).push(row);
  }
  const rows = costs.rows.map((row) => recommend(row, pricingByOffer.get(row.offerId) || {}, campaignsBySku.get(String(row.sku || "")) || []));
  const inventory = summarizeCampaignInventory(campaignInventoryRows);
  return {
    generatedAt: new Date().toISOString(), mode: "advisory", platformWrite: false, rows,
    campaignInventory: inventory.campaigns,
    externalTrackingRecords: inventory.externalTrackingRecords,
    summary: {
      products: rows.length,
      covered: rows.filter((row) => row.adRate14 !== null).length,
      increase: rows.filter((row) => row.action === "increase_budget").length,
      reduce: rows.filter((row) => ["reduce_budget", "reduce_or_pause"].includes(row.action)).length,
      waiting: rows.filter((row) => row.action === "wait_data").length,
      campaignSetup: rows.filter((row) => row.action === "review_campaign_setup").length,
      mappedCampaigns: rows.filter((row) => row.campaignId).length,
      executable: 0,
      ...inventory.summary
    }
  };
}

async function refreshQueue() {
  const data = await recommendations();
  const actionable = data.rows.filter((row) => !["hold", "wait_data"].includes(row.action));
  const result = await operationQueue.replaceProposals("ozon_advertising", actionable.map((row) => ({
    actionType: row.action,
    entityType: "product",
    entityId: row.offerId,
    title: row.title,
    reason: row.reason,
    riskLevel: row.riskLevel,
    payload: { sku: row.sku, adRate14: row.adRate14, margin: row.margin, campaignId: row.campaignId,
      currentBudget: row.currentBudget, currentBid: row.currentBid, targetBudget: row.targetBudget,
      currentState: { budget: row.currentBudget, bid: row.currentBid } },
    requiresApproval: true
  })));
  return { ...data.summary, queued: result.created, platformWrite: false };
}

module.exports = { classifyCampaign, summarizeCampaignInventory, recommend, recommendations, refreshQueue };
