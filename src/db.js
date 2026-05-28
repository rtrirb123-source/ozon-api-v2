const { config } = require("./config");

let pool;
let Pool;

function getPool() {
  if (!config.databaseUrl) {
    const error = new Error("DATABASE_URL is not configured");
    error.statusCode = 500;
    throw error;
  }

  if (!pool) {
    try {
      ({ Pool } = require("pg"));
    } catch (error) {
      error.message = `PostgreSQL driver is not installed. Run npm install before starting the service. ${error.message}`;
      error.statusCode = 500;
      throw error;
    }

    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false }
    });
  }

  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

module.exports = { getPool, query };
