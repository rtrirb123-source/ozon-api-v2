const fs = require("fs");
const path = require("path");
const { getPool } = require("./db");

async function migrate() {
  const sql = fs.readFileSync(path.resolve(__dirname, "../sql/schema.sql"), "utf8");
  await getPool().query(sql);
}

module.exports = { migrate };
