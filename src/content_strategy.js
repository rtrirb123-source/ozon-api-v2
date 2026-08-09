const { query } = require("./db");
const operationQueue = require("./operation_queue");

function recommend(row) {
  const title = String(row.title || "").trim();
  const issues = [];
  if (!row.image_url) issues.push("缺少主图");
  if (!title) issues.push("缺少标题");
  else if (title.length < 35) issues.push("标题过短，关键词覆盖不足");
  else if (title.length > 180) issues.push("标题过长，建议精简卖点");
  if (!row.competitor_compare) issues.push("缺少竞品匹配，无法提取差异化卖点");
  return {
    offerId: row.offer_id, sku: String(row.ozon_sku || ""), title, imageUrl: row.image_url || "",
    issues, action: issues.length ? "optimize_content" : "hold",
    reason: issues.length ? issues.join("；") : "标题、主图和竞品资料基础完整",
    executable: false,
    executionBlock: "内容变更必须先生成预览并人工审核，当前不会提交Ozon"
  };
}

async function recommendations() {
  const result = await query(`SELECT offer_id, ozon_sku, title, image_url, competitor_compare
    FROM products WHERE COALESCE(hidden,false)=false ORDER BY updated_at DESC`);
  const rows = result.rows.map(recommend);
  return {
    generatedAt: new Date().toISOString(), mode: "advisory", platformWrite: false, rows,
    summary: {
      products: rows.length,
      needsOptimization: rows.filter((row) => row.action === "optimize_content").length,
      missingImage: rows.filter((row) => row.issues.includes("缺少主图")).length,
      missingCompetitor: rows.filter((row) => row.issues.some((issue) => issue.includes("竞品"))).length,
      executable: 0
    }
  };
}

async function refreshQueue() {
  const data = await recommendations();
  const proposals = data.rows.filter((row) => row.action === "optimize_content").map((row) => ({
    actionType: "content_review",
    entityType: "product",
    entityId: row.offerId,
    title: row.title,
    reason: row.reason,
    riskLevel: "medium",
    payload: { sku: row.sku, issues: row.issues },
    requiresApproval: true
  }));
  const queued = await operationQueue.replaceProposals("ozon_content", proposals);
  return { ...data.summary, queued: queued.created, platformWrite: false };
}

module.exports = { recommend, recommendations, refreshQueue };
