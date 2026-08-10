const assert = require("node:assert/strict");
const { JOB_DEFINITIONS } = require("../src/automation");

const campaignSync = JOB_DEFINITIONS.find((job) => job.key === "ozon_ad_campaign_read_sync");
const strategyRefresh = JOB_DEFINITIONS.find((job) => job.key === "ozon_advertising_strategy_refresh");

assert.deepEqual(
  { mode: campaignSync.scheduleMode, minutes: campaignSync.intervalMinutes, writes: campaignSync.platformWrite },
  { mode: "interval", minutes: 180, writes: false }
);
assert.deepEqual(
  { mode: strategyRefresh.scheduleMode, minutes: strategyRefresh.intervalMinutes, writes: strategyRefresh.platformWrite },
  { mode: "interval", minutes: 180, writes: false }
);
console.log("automation schedule tests passed");
