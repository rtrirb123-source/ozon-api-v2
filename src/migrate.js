const { getPool } = require("./db");
const { migrate } = require("./schema");

async function main() {
  await migrate();
  console.log("Migration complete");
  await getPool().end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
