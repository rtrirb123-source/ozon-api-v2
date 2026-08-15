const { config } = require("./config");
const { query } = require("./db");

const JOB_DEFINITIONS = Object.freeze([
  {
    key: "ozon_products_read_sync",
    name: "Ozon 商品读取同步",
    description: "从现有 Ozon API 读取商品资料并更新本地看板数据。",
    intervalMinutes: 30,
    scheduleMode: "interval",
    dailyTimes: [],
    platformWrite: false
  },
  {
    key: "ozon_metrics_read_sync",
    name: "Ozon 经营指标读取同步",
    description: "读取销量、库存及经营指标并更新本地看板数据。",
    intervalMinutes: 240,
    scheduleMode: "daily_times",
    dailyTimes: ["04:10", "08:10", "12:10"],
    platformWrite: false
  },
  {
    key: "seerfar_monitor_read_sync",
    name: "Seerfar 套餐竞品监控同步",
    description: "读取套餐内商品监控数据并更新本地竞品快照，不调用付费 Open API。",
    intervalMinutes: 1440,
    scheduleMode: "daily_times",
    dailyTimes: ["06:30"],
    platformWrite: false
  },
  {
    key: "ozon_selected_products_daily_tracking",
    name: "Ozon 已勾选商品每日跟踪",
    description: "每天只读更新已勾选商品的销量、库存、经营指标及其 Seerfar 竞品数据。",
    intervalMinutes: 1440,
    scheduleMode: "daily_times",
    dailyTimes: ["08:30"],
    defaultEnabled: true,
    platformWrite: false
  },
  {
    key: "ozon_ad_campaign_read_sync",
    name: "Ozon 广告活动读取同步",
    description: "读取广告活动ID、类型、状态、预算、出价和商品关联，供策略预演使用。",
    intervalMinutes: 180,
    scheduleMode: "interval",
    dailyTimes: [],
    platformWrite: false
  },
  {
    key: "ozon_advertising_strategy_refresh",
    name: "Ozon 广告策略刷新",
    description: "根据广告消耗、利润和库存生成预算调整建议与待审核队列。",
    intervalMinutes: 180,
    scheduleMode: "interval",
    dailyTimes: [],
    platformWrite: false
  },
  {
    key: "ozon_promotion_read_sync",
    name: "Ozon 促销活动读取同步",
    description: "读取真实活动、已参加商品、可参加商品和活动价格，只保存本地快照。",
    intervalMinutes: 1440,
    scheduleMode: "daily_times",
    dailyTimes: ["07:10"],
    platformWrite: false
  },
  {
    key: "ozon_promotion_strategy_refresh",
    name: "Ozon 促销策略刷新",
    description: "按利润底线评估参加或退出促销的候选商品。",
    intervalMinutes: 1440,
    scheduleMode: "daily_times",
    dailyTimes: ["07:20"],
    platformWrite: false
  },
  {
    key: "ozon_content_strategy_refresh",
    name: "Ozon 内容优化策略刷新",
    description: "检查标题、主图和竞品资料并生成内容优化待审核任务。",
    intervalMinutes: 1440,
    scheduleMode: "daily_times",
    dailyTimes: ["07:40"],
    platformWrite: false
  }
]);

const state = globalThis.__ozonAutomationState || (globalThis.__ozonAutomationState = {
  timer: null,
  polling: false,
  handlers: new Map()
});

function definition(jobKey) {
  return JOB_DEFINITIONS.find((item) => item.key === jobKey) || null;
}

function nextRunAt(from, intervalMinutes) {
  const base = from ? new Date(from) : new Date();
  return new Date(base.getTime() + Math.max(1, Number(intervalMinutes) || 1) * 60000);
}

function normalizeDailyTimes(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter((item) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item)))].sort();
}

function nextDailyRunAt(from, dailyTimes) {
  const now = from ? new Date(from) : new Date();
  const times = normalizeDailyTimes(dailyTimes);
  if (!times.length) throw new Error("At least one valid Beijing daily time is required");
  const china = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset += 1) {
    for (const time of times) {
      const [hour, minute] = time.split(":").map(Number);
      const target = new Date(Date.UTC(
        china.getUTCFullYear(), china.getUTCMonth(), china.getUTCDate() + dayOffset,
        hour - 8, minute, 0, 0
      ));
      if (target.getTime() > now.getTime()) return target;
    }
  }
  throw new Error("Unable to calculate next Beijing run time");
}

function calculateNextRunAt(job, from = new Date()) {
  return job.schedule_mode === "daily_times"
    ? nextDailyRunAt(from, job.daily_times)
    : nextRunAt(from, job.interval_minutes);
}

function calculateFollowingRunAt(job, from = new Date()) {
  if (job.schedule_mode !== "daily_times" && job.next_run_at) {
    let next = new Date(job.next_run_at);
    const step = Math.max(1, Number(job.interval_minutes) || 1) * 60000;
    while (next.getTime() <= from.getTime()) next = new Date(next.getTime() + step);
    return next;
  }
  return calculateNextRunAt(job, from);
}

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS automation_jobs (
      job_key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      interval_minutes INTEGER NOT NULL CHECK (interval_minutes >= 1),
      schedule_mode TEXT NOT NULL DEFAULT 'interval' CHECK (schedule_mode IN ('interval', 'daily_times')),
      daily_times JSONB NOT NULL DEFAULT '[]'::jsonb,
      platform_write BOOLEAN NOT NULL DEFAULT FALSE,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`ALTER TABLE automation_jobs ADD COLUMN IF NOT EXISTS schedule_mode TEXT NOT NULL DEFAULT 'interval'`);
  await query(`ALTER TABLE automation_jobs ADD COLUMN IF NOT EXISTS daily_times JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await query(`
    CREATE TABLE IF NOT EXISTS automation_runs (
      id BIGSERIAL PRIMARY KEY,
      job_key TEXT NOT NULL REFERENCES automation_jobs(job_key),
      trigger_source TEXT NOT NULL CHECK (trigger_source IN ('manual', 'schedule')),
      status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'blocked')),
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      duration_ms INTEGER,
      summary JSONB,
      error TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`CREATE INDEX IF NOT EXISTS automation_runs_job_started_idx ON automation_runs (job_key, started_at DESC)`);
  for (const job of JOB_DEFINITIONS) {
    await query(`
      INSERT INTO automation_jobs (job_key, name, description, enabled, interval_minutes, schedule_mode, daily_times, platform_write)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (job_key) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description,
        platform_write = EXCLUDED.platform_write,
        updated_at = NOW()
    `, [job.key, job.name, job.description, Boolean(job.defaultEnabled), job.intervalMinutes, job.scheduleMode, JSON.stringify(job.dailyTimes), job.platformWrite]);
  }
  // Upgrade only the former built-in daily defaults. Custom schedules chosen
  // in the UI are intentionally left untouched.
  await query(`UPDATE automation_jobs
    SET interval_minutes=180, schedule_mode='interval', daily_times='[]'::jsonb,
        next_run_at=NOW(), updated_at=NOW()
    WHERE job_key='ozon_ad_campaign_read_sync'
      AND schedule_mode='daily_times' AND daily_times='["06:50"]'::jsonb`);
  await query(`UPDATE automation_jobs
    SET interval_minutes=180, schedule_mode='interval', daily_times='[]'::jsonb,
        next_run_at=NOW(), updated_at=NOW()
    WHERE job_key='ozon_advertising_strategy_refresh'
      AND schedule_mode='daily_times' AND daily_times='["07:00"]'::jsonb`);
}

function registerHandlers(handlers) {
  state.handlers = new Map(Object.entries(handlers || {}));
}

async function listJobs() {
  await ensureSchema();
  const result = await query(`
    SELECT j.*,
      latest.status AS last_status,
      latest.error AS last_error,
      latest.finished_at AS last_finished_at
    FROM automation_jobs j
    LEFT JOIN LATERAL (
      SELECT status, error, finished_at
      FROM automation_runs r WHERE r.job_key = j.job_key
      ORDER BY r.id DESC LIMIT 1
    ) latest ON TRUE
    ORDER BY j.created_at, j.job_key
  `);
  return result.rows;
}

async function listRuns(limit = 50) {
  await ensureSchema();
  const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
  const result = await query(`
    SELECT r.*, j.name
    FROM automation_runs r
    JOIN automation_jobs j ON j.job_key = r.job_key
    ORDER BY r.id DESC LIMIT $1
  `, [safeLimit]);
  return result.rows;
}

async function updateJob(jobKey, patch = {}) {
  await ensureSchema();
  if (!definition(jobKey)) {
    const error = new Error("Unknown automation job");
    error.statusCode = 404;
    throw error;
  }
  const current = await query(`SELECT * FROM automation_jobs WHERE job_key = $1`, [jobKey]);
  const job = current.rows[0];
  const enabled = patch.enabled === undefined ? job.enabled : patch.enabled === true;
  const interval = patch.intervalMinutes === undefined
    ? Number(job.interval_minutes)
    : Math.min(1440, Math.max(1, Number(patch.intervalMinutes) || 1));
  const scheduleMode = patch.scheduleMode === undefined ? job.schedule_mode : String(patch.scheduleMode);
  if (!["interval", "daily_times"].includes(scheduleMode)) {
    const error = new Error("Schedule mode must be interval or daily_times");
    error.statusCode = 400;
    throw error;
  }
  const dailyTimes = patch.dailyTimes === undefined ? normalizeDailyTimes(job.daily_times) : normalizeDailyTimes(patch.dailyTimes);
  if (scheduleMode === "daily_times" && !dailyTimes.length) {
    const error = new Error("At least one valid Beijing daily time is required");
    error.statusCode = 400;
    throw error;
  }
  const next = enabled ? calculateNextRunAt({ schedule_mode: scheduleMode, daily_times: dailyTimes, interval_minutes: interval }) : null;
  const result = await query(`
    UPDATE automation_jobs
    SET enabled = $2, interval_minutes = $3, schedule_mode = $4, daily_times = $5,
        next_run_at = $6, updated_at = NOW()
    WHERE job_key = $1 RETURNING *
  `, [jobKey, enabled, interval, scheduleMode, JSON.stringify(dailyTimes), next]);
  return result.rows[0];
}

async function recordBlocked(jobKey, triggerSource, message) {
  const result = await query(`
    INSERT INTO automation_runs (job_key, trigger_source, status, finished_at, duration_ms, error)
    VALUES ($1, $2, 'blocked', NOW(), 0, $3) RETURNING *
  `, [jobKey, triggerSource, message]);
  return result.rows[0];
}

async function runJob(jobKey, triggerSource = "manual") {
  await ensureSchema();
  const jobDef = definition(jobKey);
  if (!jobDef) {
    const error = new Error("Unknown automation job");
    error.statusCode = 404;
    throw error;
  }
  if (jobDef.platformWrite && !config.automationAllowPlatformWrites) {
    return recordBlocked(jobKey, triggerSource, "Platform write safety switch is disabled");
  }
  const alreadyRunning = await query(`
    SELECT id FROM automation_runs
    WHERE job_key = $1 AND status = 'running' AND started_at > NOW() - INTERVAL '2 hours'
    LIMIT 1
  `, [jobKey]);
  if (alreadyRunning.rows.length) {
    const error = new Error("This automation job is already running");
    error.statusCode = 409;
    throw error;
  }
  const handler = state.handlers.get(jobKey);
  if (!handler) {
    const error = new Error("Automation job handler is not registered");
    error.statusCode = 503;
    throw error;
  }
  const run = await query(`
    INSERT INTO automation_runs (job_key, trigger_source, status)
    VALUES ($1, $2, 'running') RETURNING id, started_at
  `, [jobKey, triggerSource]);
  const runId = run.rows[0].id;
  const jobSettings = await query(`SELECT schedule_mode, daily_times, interval_minutes, next_run_at FROM automation_jobs WHERE job_key=$1`, [jobKey]);
  const started = Date.now();
  try {
    const summary = await handler();
    await query(`
      UPDATE automation_runs SET status='success', finished_at=NOW(), duration_ms=$2, summary=$3
      WHERE id=$1
    `, [runId, Date.now() - started, summary || {}]);
    await query(`
      UPDATE automation_jobs SET last_run_at=NOW(), next_run_at=$2, updated_at=NOW()
      WHERE job_key=$1
    `, [jobKey, calculateFollowingRunAt(jobSettings.rows[0], new Date())]);
  } catch (error) {
    await query(`
      UPDATE automation_runs SET status='failed', finished_at=NOW(), duration_ms=$2, error=$3
      WHERE id=$1
    `, [runId, Date.now() - started, String(error.message || error).slice(0, 2000)]);
  }
  const result = await query(`SELECT * FROM automation_runs WHERE id=$1`, [runId]);
  return result.rows[0];
}

async function pollDueJobs() {
  if (state.polling || !config.automationEnabled) return;
  state.polling = true;
  try {
    await ensureSchema();
    const due = await query(`
      SELECT job_key FROM automation_jobs
      WHERE enabled IS TRUE AND (next_run_at IS NULL OR next_run_at <= NOW())
      ORDER BY next_run_at NULLS FIRST
    `);
    for (const job of due.rows) await runJob(job.job_key, "schedule");
  } finally {
    state.polling = false;
  }
}

function start(handlers) {
  registerHandlers(handlers);
  if (!config.automationEnabled || state.timer) return;
  state.timer = setInterval(() => {
    pollDueJobs().catch((error) => console.error("[automation]", error.message));
  }, config.automationPollSeconds * 1000);
  state.timer.unref?.();
  pollDueJobs().catch((error) => console.error("[automation]", error.message));
}

async function overview() {
  const [jobs, runs] = await Promise.all([listJobs(), listRuns(20)]);
  return {
    masterEnabled: config.automationEnabled,
    platformWritesAllowed: config.automationAllowPlatformWrites,
    pollSeconds: config.automationPollSeconds,
    jobs,
    runs
  };
}

module.exports = {
  JOB_DEFINITIONS,
  calculateNextRunAt,
  calculateFollowingRunAt,
  ensureSchema,
  listJobs,
  listRuns,
  nextRunAt,
  nextDailyRunAt,
  normalizeDailyTimes,
  overview,
  runJob,
  start,
  updateJob
};
