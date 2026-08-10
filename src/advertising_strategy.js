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
  // Ozon uses ALL_SKU_PROMO for campaigns that still expose an explicit
  // product list. Treating it as a non-product campaign drops every linked
  // SKU from the operations centre even though the Performance API returns
  // those links (for example campaign 23441397).
  const productCampaign = ["SKU", "ALL_SKU_PROMO"].includes(type);
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
  } else if (pricing.blocked || costProfitRatio === null) {
    action = "blocked";
    reason = "成本利润率数据不完整，拦截该商品广告执行";
    riskLevel = "high";
  } else if (costProfitRatio < 0 || adRate >= 25) {
    action = "pause_product";
    reason = costProfitRatio < 0 ? "当前净利润为负，建议暂停该商品广告" : "广告费率达到25%以上，建议暂停该商品广告";
    riskLevel = "high";
  } else if (profitZone === "safe" && adRate <= 10 && stock > Math.max(14, sales7 * 2)) {
    action = "increase_bid";
    reason = "成本利润率在80%以上安全区，广告费率和库存满足放量条件，可小幅提高该商品出价";
    riskLevel = "medium";
  } else if (adRate > 15 || profitZone === "danger") {
    action = "reduce_bid";
    reason = adRate > 15 ? "广告费率偏高，建议小幅降低该商品出价" : "成本利润率低于50%危险线，建议收紧该商品广告投入";
    riskLevel = "medium";
  }

  const activeCampaign = campaigns[0] || null;
  if (!["hold", "wait_data"].includes(action) && !activeCampaign) {
    action = "review_campaign_setup";
    reason = "存在广告优化信号，但当前没有关联到运行中的可控商品广告活动；请先检查或新建PPC活动";
    riskLevel = "medium";
  }
  const currentBudget = activeCampaign ? number(activeCampaign.weekly_budget || activeCampaign.daily_budget || activeCampaign.total_budget) : null;
  const currentBid = activeCampaign?.bid == null ? null : number(activeCampaign.bid);
  const targetBid = currentBid === null || !["increase_bid", "reduce_bid", "pause_product"].includes(action) ? null
    : action === "pause_product" ? 0
      : Number((currentBid * (action === "increase_bid" ? 1.1 : 0.9)).toFixed(2));

  return {
    offerId: product.offerId, sku: product.sku, title: product.title, adRate14: adRate,
    adSpend14Rub: product.adSpend14Rub, costProfitRatio: costProfitRatio ?? null, profitZone, stock, sales7,
    campaignId: activeCampaign?.campaign_id || "", campaignTitle: activeCampaign?.campaign_title || "",
    currentBudget, currentBid, targetBid, targetBudget: null,
    action, reason, riskLevel, executable: false,
    executionBlock: "Performance API写接口尚未验证；所有动作仅进入待执行队列"
  };
}

function recommendCampaignBudgets(productRows = [], campaignInventory = []) {
  return campaignInventory.filter((campaign) => campaign.kind === "product_campaign" && campaign.running).map((campaign) => {
    const linked = productRows.filter((row) => row.campaignId === campaign.campaignId);
    const covered = linked.filter((row) => row.adRate14 !== null);
    const positive = covered.filter((row) => row.action === "increase_bid");
    const negative = covered.filter((row) => ["reduce_bid", "pause_product"].includes(row.action));
    const minimumCoverage = Math.max(2, Math.ceil(number(campaign.productLinks) * 0.5));
    const currentBudget = number(campaign.weeklyBudget || campaign.dailyBudget || campaign.totalBudget);
    let action = "hold_budget";
    let reason = "活动内商品信号分化，保持当前总预算";
    let targetBudget = null;
    let riskLevel = "low";

    if (covered.length < minimumCoverage) {
      action = "wait_campaign_data";
      reason = `仅${covered.length}/${campaign.productLinks}个关联商品有广告数据，不调整活动总预算`;
    } else if (negative.length / covered.length >= 0.6) {
      action = "reduce_budget";
      targetBudget = Number((currentBudget * 0.9).toFixed(2));
      reason = `${negative.length}/${covered.length}个有数据商品需收紧，活动总预算只生成一条10%下调建议`;
      riskLevel = "medium";
    } else if (positive.length / covered.length >= 0.6) {
      action = "review_budget_capacity";
      reason = `${positive.length}/${covered.length}个有数据商品可放量，但缺少活动预算利用率，先核实预算是否受限`;
      riskLevel = "medium";
    }

    return {
      campaignId: campaign.campaignId, title: campaign.title, action, reason, riskLevel,
      productLinks: number(campaign.productLinks), coveredProducts: covered.length,
      positiveProducts: positive.length, negativeProducts: negative.length,
      currentBudget, targetBudget, executable: false
    };
  });
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
  const campaignRecommendations = recommendCampaignBudgets(rows, inventory.campaigns);
  return {
    generatedAt: new Date().toISOString(), mode: "advisory", platformWrite: false, rows,
    campaignInventory: inventory.campaigns,
    campaignRecommendations,
    externalTrackingRecords: inventory.externalTrackingRecords,
    summary: {
      products: rows.length,
      covered: rows.filter((row) => row.adRate14 !== null).length,
      increase: rows.filter((row) => row.action === "increase_bid").length,
      reduce: rows.filter((row) => ["reduce_bid", "pause_product"].includes(row.action)).length,
      waiting: rows.filter((row) => row.action === "wait_data").length,
      campaignSetup: rows.filter((row) => row.action === "review_campaign_setup").length,
      mappedCampaigns: rows.filter((row) => row.campaignId).length,
      campaignBudgetChanges: campaignRecommendations.filter((row) => row.targetBudget !== null).length,
      executable: 0,
      ...inventory.summary
    }
  };
}

async function refreshQueue() {
  const data = await recommendations();
  const actionable = data.rows.filter((row) => !["hold", "wait_data", "blocked"].includes(row.action));
  const productProposals = actionable.map((row) => ({
    actionType: row.action,
    entityType: "product",
    entityId: row.offerId,
    title: row.title,
    reason: row.reason,
    riskLevel: row.riskLevel,
    payload: { sku: row.sku, adRate14: row.adRate14, margin: row.margin, campaignId: row.campaignId,
      currentBudget: row.currentBudget, currentBid: row.currentBid, targetBid: row.targetBid, targetBudget: null,
      currentState: { budget: row.currentBudget, bid: row.currentBid } },
    requiresApproval: true
  }));
  const campaignProposals = data.campaignRecommendations.filter((row) => row.targetBudget !== null).map((row) => ({
    actionType: row.action,
    entityType: "campaign",
    entityId: row.campaignId,
    title: row.title || row.campaignId,
    reason: row.reason,
    riskLevel: row.riskLevel,
    payload: { campaignId: row.campaignId, currentBudget: row.currentBudget, targetBudget: row.targetBudget,
      coveredProducts: row.coveredProducts, positiveProducts: row.positiveProducts, negativeProducts: row.negativeProducts,
      currentState: { budget: row.currentBudget } },
    requiresApproval: true
  }));
  const result = await operationQueue.replaceProposals("ozon_advertising", [...productProposals, ...campaignProposals]);
  return { ...data.summary, queued: result.created, platformWrite: false };
}

module.exports = { classifyCampaign, summarizeCampaignInventory, recommend, recommendCampaignBudgets, recommendations, refreshQueue };
