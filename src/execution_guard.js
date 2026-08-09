const { query } = require("./db");
const { config } = require("./config");

async function ensureSchema() {
  await query(`CREATE TABLE IF NOT EXISTS automation_action_executions (
    id BIGSERIAL PRIMARY KEY,
    action_id BIGINT NOT NULL REFERENCES automation_action_queue(id),
    mode TEXT NOT NULL DEFAULT 'simulation' CHECK (mode IN ('simulation','live')),
    status TEXT NOT NULL CHECK (status IN ('simulated','blocked','executed','rolled_back','failed')),
    platform_write BOOLEAN NOT NULL DEFAULT FALSE,
    before_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    proposed_change JSONB NOT NULL DEFAULT '{}'::jsonb,
    rollback_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    checks JSONB NOT NULL DEFAULT '[]'::jsonb,
    executed_by TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    error TEXT NOT NULL DEFAULT ''
  )`);
  await query(`CREATE INDEX IF NOT EXISTS automation_action_executions_action_idx
    ON automation_action_executions(action_id, created_at DESC)`);
}

function buildSimulation(action) {
  const payload = action.payload && typeof action.payload === "object" ? action.payload : {};
  const checks = [
    { key: "approved", passed: action.status === "approved", message: "动作已经人工批准" },
    { key: "write_switch", passed: false, message: "Ozon平台写入总开关保持关闭" }
  ];
  if (action.source === "ozon_advertising") {
    checks.push({ key: "campaign_id", passed: Boolean(payload.campaignId), message: payload.campaignId ? "已关联广告活动" : "缺少广告活动ID" });
    checks.push({ key: "target_value", passed: payload.targetBudget != null || payload.targetBid != null, message: payload.targetBudget != null || payload.targetBid != null ? "已有目标预算或出价" : "尚未计算目标预算或出价" });
  } else if (action.source === "ozon_promotions") {
    checks.push({ key: "activity_id", passed: Boolean(payload.activityId), message: payload.activityId ? "已关联促销活动" : "缺少Ozon促销活动ID" });
  } else if (action.source === "ozon_content") {
    checks.push({ key: "content_version", passed: Boolean(payload.proposedTitle || payload.proposedImageUrl || payload.proposedKeywords), message: payload.proposedTitle || payload.proposedImageUrl || payload.proposedKeywords ? "已有待发布内容版本" : "尚未生成可发布的标题、主图或关键词版本" });
  }
  const ready = checks.filter((item) => item.key !== "write_switch").every((item) => item.passed);
  return {
    ready,
    platformWrite: false,
    liveExecutionAllowed: ready && config.automationAllowPlatformWrites,
    checks,
    beforeSnapshot: { source: action.source, actionType: action.action_type, entityId: action.entity_id, payload },
    proposedChange: { actionType: action.action_type, entityType: action.entity_type, entityId: action.entity_id, payload },
    rollbackPayload: { actionId: action.id, restore: payload.currentState || payload, platformWrite: false }
  };
}

async function simulate(actionId, user = {}) {
  await ensureSchema();
  const result = await query(`SELECT * FROM automation_action_queue WHERE id=$1`, [Number(actionId)]);
  if (!result.rows.length) {
    const error = new Error("Action queue item not found");
    error.statusCode = 404;
    throw error;
  }
  const action = result.rows[0];
  if (action.status !== "approved") {
    const error = new Error("Only approved actions can be simulated");
    error.statusCode = 409;
    throw error;
  }
  const preview = buildSimulation(action);
  const saved = await query(`INSERT INTO automation_action_executions
    (action_id, mode, status, platform_write, before_snapshot, proposed_change, rollback_payload, checks, executed_by)
    VALUES ($1,'simulation',$2,FALSE,$3,$4,$5,$6,$7) RETURNING *`, [
    action.id, preview.ready ? "simulated" : "blocked", JSON.stringify(preview.beforeSnapshot),
    JSON.stringify(preview.proposedChange), JSON.stringify(preview.rollbackPayload), JSON.stringify(preview.checks),
    String(user.username || user.operator || "admin").slice(0, 100)
  ]);
  return { ...saved.rows[0], preview };
}

async function list({ limit = 100 } = {}) {
  await ensureSchema();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
  const result = await query(`SELECT e.*, q.source, q.action_type, q.entity_id, q.title
    FROM automation_action_executions e JOIN automation_action_queue q ON q.id=e.action_id
    ORDER BY e.created_at DESC, e.id DESC LIMIT $1`, [safeLimit]);
  return result.rows;
}

module.exports = { buildSimulation, ensureSchema, list, simulate };
