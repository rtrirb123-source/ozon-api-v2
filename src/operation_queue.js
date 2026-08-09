const { query } = require("./db");

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS automation_action_queue (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      action_type TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      reason TEXT NOT NULL DEFAULT '',
      risk_level TEXT NOT NULL DEFAULT 'medium' CHECK (risk_level IN ('low','medium','high')),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','executing','succeeded','failed','cancelled')),
      requires_approval BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      executed_at TIMESTAMPTZ,
      reviewed_by TEXT NOT NULL DEFAULT '',
      reviewed_at TIMESTAMPTZ,
      error TEXT NOT NULL DEFAULT ''
    )
  `);
  await query(`ALTER TABLE automation_action_queue ADD COLUMN IF NOT EXISTS reviewed_by TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE automation_action_queue ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`);
  await query(`CREATE INDEX IF NOT EXISTS automation_action_queue_status_idx ON automation_action_queue(status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS automation_action_queue_entity_idx ON automation_action_queue(source, entity_type, entity_id)`);
}

async function replaceProposals(source, proposals = []) {
  await ensureSchema();
  await query(`UPDATE automation_action_queue SET status='cancelled', updated_at=NOW()
    WHERE source=$1 AND status='proposed'`, [source]);
  let created = 0;
  for (const item of proposals) {
    await query(`INSERT INTO automation_action_queue
      (source, action_type, entity_type, entity_id, title, reason, risk_level, payload, requires_approval)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
      source, item.actionType, item.entityType, String(item.entityId), item.title || "", item.reason || "",
      item.riskLevel || "medium", JSON.stringify(item.payload || {}), item.requiresApproval !== false
    ]);
    created += 1;
  }
  return { source, created };
}

async function list({ status = "proposed", limit = 200 } = {}) {
  await ensureSchema();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
  const result = await query(`SELECT * FROM automation_action_queue
    WHERE ($1='' OR status=$1) ORDER BY created_at DESC, id DESC LIMIT $2`, [String(status || ""), safeLimit]);
  return result.rows;
}

async function summary() {
  await ensureSchema();
  const result = await query(`SELECT status, source, COUNT(*)::int AS count
    FROM automation_action_queue GROUP BY status, source ORDER BY status, source`);
  return { generatedAt: new Date().toISOString(), rows: result.rows };
}

function normalizeDecision(value) {
  const decision = String(value || "").trim().toLowerCase();
  if (!['approved', 'cancelled'].includes(decision)) {
    const error = new Error("Decision must be approved or cancelled");
    error.statusCode = 400;
    throw error;
  }
  return decision;
}

async function review(id, decision, user = {}) {
  await ensureSchema();
  const queueId = Number(id);
  if (!Number.isSafeInteger(queueId) || queueId <= 0) {
    const error = new Error("Invalid action queue id");
    error.statusCode = 400;
    throw error;
  }
  const status = normalizeDecision(decision);
  const reviewer = String(user.username || user.operator || "admin").slice(0, 100);
  const result = await query(`UPDATE automation_action_queue
    SET status=$2, reviewed_by=$3, reviewed_at=NOW(), updated_at=NOW()
    WHERE id=$1 AND status='proposed' RETURNING *`, [queueId, status, reviewer]);
  if (!result.rows.length) {
    const error = new Error("Action is no longer pending review");
    error.statusCode = 409;
    throw error;
  }
  return result.rows[0];
}

module.exports = { ensureSchema, list, normalizeDecision, replaceProposals, review, summary };
