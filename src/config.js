const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    let value = trimmed.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadDotEnv();

const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || "",
  autoMigrate: (process.env.AUTO_MIGRATE || "true").toLowerCase() !== "false",
  ozonClientId: process.env.OZON_CLIENT_ID || "",
  ozonApiKey: process.env.OZON_API_KEY || "",
  ozonPerformanceClientId: process.env.OZON_PERFORMANCE_CLIENT_ID || "",
  ozonPerformanceClientSecret: process.env.OZON_PERFORMANCE_CLIENT_SECRET || "",
  allowedOrigins: (process.env.ALLOWED_ORIGINS || "*")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
};

module.exports = { config };
