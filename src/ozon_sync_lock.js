const { getPool } = require("./db");

const LOCK_NAME = "ozon-api-v2:all-ozon-sync";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 1000;

const state = globalThis.__ozonSyncLockState || (globalThis.__ozonSyncLockState = {
  activeTask: "",
  activeSince: null,
  waiting: 0
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createLockManager({ poolProvider = getPool, wait = sleep } = {}) {
  async function withLock(taskName, handler, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const client = await poolProvider().connect();
    const startedWaiting = Date.now();
    let acquired = false;
    state.waiting += 1;
    try {
      while (!acquired) {
        const result = await client.query(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
          [LOCK_NAME]
        );
        acquired = result.rows[0]?.acquired === true;
        if (acquired) break;
        if (Date.now() - startedWaiting >= timeoutMs) {
          const error = new Error(`Ozon sync queue timed out while waiting for ${taskName}`);
          error.statusCode = 409;
          throw error;
        }
        await wait(POLL_MS);
      }
      state.waiting -= 1;
      state.activeTask = String(taskName || "ozon-sync");
      state.activeSince = new Date().toISOString();
      return await handler();
    } finally {
      if (state.waiting > 0 && !acquired) state.waiting -= 1;
      if (acquired) {
        try {
          await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME]);
        } finally {
          state.activeTask = "";
          state.activeSince = null;
        }
      }
      client.release();
    }
  }

  return { withLock };
}

const manager = createLockManager();

function status() {
  return { ...state };
}

module.exports = { createLockManager, status, withLock: manager.withLock };
