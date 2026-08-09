const fs = require("fs");
const path = require("path");

const DEFAULT_COOLDOWN_SECONDS = 3 * 60 * 60;
const DEFAULT_STATE_PATH = "/var/lib/ozon-api-v2/wb-stats-rate-limit.json";

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function cooldownError(state, nowMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil((state.blockedUntilMs - nowMs) / 1000));
  const error = new Error(`WB statistics API cooldown is active for ${retryAfterSeconds}s`);
  error.statusCode = 429;
  error.retryAfterSeconds = retryAfterSeconds;
  error.blockedUntil = new Date(state.blockedUntilMs).toISOString();
  error.details = state.lastErrorDetails || null;
  error.cooldownActive = true;
  return error;
}

function createWbStatsLimiter({
  statePath = process.env.WB_STATS_RATE_LIMIT_STATE_PATH || DEFAULT_STATE_PATH,
  fallbackCooldownSeconds = positiveInteger(
    process.env.WB_STATS_429_COOLDOWN_SECONDS,
    DEFAULT_COOLDOWN_SECONDS
  ),
  now = () => Date.now(),
} = {}) {
  let queue = Promise.resolve();
  let state = readState();

  function readState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return {
        blockedUntilMs: Number(parsed.blockedUntilMs || 0),
        lastLimitedAt: parsed.lastLimitedAt || "",
        lastErrorDetails: parsed.lastErrorDetails || null,
      };
    } catch {
      return { blockedUntilMs: 0, lastLimitedAt: "", lastErrorDetails: null };
    }
  }

  function writeState() {
    const directory = path.dirname(statePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    fs.renameSync(temporary, statePath);
  }

  async function execute(task) {
    state = readState();
    const nowMs = now();
    if (state.blockedUntilMs > nowMs) throw cooldownError(state, nowMs);

    try {
      return await task();
    } catch (error) {
      if (Number(error && error.statusCode) !== 429) throw error;
      const retryAfterSeconds = positiveInteger(
        error.retryAfterSeconds,
        fallbackCooldownSeconds
      );
      const limitedAtMs = now();
      state = {
        blockedUntilMs: limitedAtMs + retryAfterSeconds * 1000,
        lastLimitedAt: new Date(limitedAtMs).toISOString(),
        lastErrorDetails: error.details || null,
      };
      try {
        writeState();
      } catch (persistenceError) {
        error.cooldownPersistenceError = persistenceError.message;
      }
      error.retryAfterSeconds = retryAfterSeconds;
      error.blockedUntil = new Date(state.blockedUntilMs).toISOString();
      throw error;
    }
  }

  function run(task) {
    const job = queue.then(() => execute(task), () => execute(task));
    queue = job.catch(() => undefined);
    return job;
  }

  function status() {
    state = readState();
    const nowMs = now();
    return {
      blocked: state.blockedUntilMs > nowMs,
      blockedUntil: state.blockedUntilMs
        ? new Date(state.blockedUntilMs).toISOString()
        : "",
      retryAfterSeconds: state.blockedUntilMs > nowMs
        ? Math.ceil((state.blockedUntilMs - nowMs) / 1000)
        : 0,
      lastLimitedAt: state.lastLimitedAt,
    };
  }

  return { run, status };
}

module.exports = {
  createWbStatsLimiter,
  DEFAULT_COOLDOWN_SECONDS,
};
