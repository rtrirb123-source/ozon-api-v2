import json
import os
import shutil
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path("/opt/ozon-api-v2/dashboard")
SNAPSHOT = Path("/opt/ozon-api-v2/data/nas-costs-dashboard.json")
PUBLIC_DIR = Path("/var/www/ozon-dashboard")

snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
costs = {str(item["sku"]): item for item in snapshot.get("matched", [])}


def load_product_fallbacks():
    script = r"""
require("./src/config");
const { query } = require("./src/db");
(async () => {
  const result = await query(
    `SELECT ozon_sku, purchase_cost, weight
       FROM products
      WHERE ozon_sku IS NOT NULL
        AND purchase_cost IS NOT NULL
        AND weight IS NOT NULL`
  );
  process.stdout.write(JSON.stringify(result.rows || []));
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
"""
    result = subprocess.run(
        ["node", "-e", script],
        cwd="/opt/ozon-api-v2",
        check=True,
        capture_output=True,
        text=True,
    )
    return {
        str(item["ozon_sku"]): item
        for item in json.loads(result.stdout or "[]")
    }


product_fallbacks = load_product_fallbacks()
months = []
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
for base in sorted(BASE_DIR.glob("russia-unit-economics-????-??.json")):
    match = re.search(r"(\d{4}-\d{2})\.json$", base.name)
    if not match:
        continue
    dashboard = json.loads(base.read_text(encoding="utf-8"))
    fallback_count = 0
    unmatched = []
    for row in dashboard.get("rows", []):
        sku = str(row.get("sku"))
        cost = costs.get(sku)
        fallback = product_fallbacks.get(sku)
        if cost:
            row["purchaseCost"] = cost.get("totalCostCny")
            row["weightG"] = cost.get("weightG")
            row["costMatchSource"] = "NAS"
        elif fallback:
            purchase_cost = fallback.get("purchase_cost")
            weight = fallback.get("weight")
            row["purchaseCost"] = float(purchase_cost) if purchase_cost not in (None, "") else None
            row["weightG"] = float(weight) if weight not in (None, "") else None
            row["costMatchSource"] = "Ozon经营概览"
            fallback_count += 1
        else:
            row["purchaseCost"] = None
            row["weightG"] = None
            row["costMatchSource"] = None
        if row["purchaseCost"] is None or row["weightG"] is None:
            unmatched.append({"sku": row.get("sku"), "offerId": row.get("offerId")})
    dashboard["costCurrency"] = "CNY"
    dashboard["costSource"] = snapshot.get("source")
    dashboard["costSourceUpdatedAt"] = snapshot.get("generatedAt")
    dashboard["costMergedAt"] = datetime.now(timezone.utc).isoformat()
    dashboard["costMatchedCount"] = len(dashboard.get("rows", [])) - len(unmatched)
    dashboard["costFallbackCount"] = fallback_count
    dashboard["costUnmatched"] = unmatched
    tmp = base.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(dashboard, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, base)
    shutil.copy2(base, PUBLIC_DIR / base.name)
    month = match.group(1)
    months.append({
        "month": month,
        "label": dashboard.get("period", {}).get("label") or f"{month[:4]}年{int(month[5:])}月",
        "file": base.name,
        "rows": len(dashboard.get("rows", [])),
    })

manifest = {
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "months": sorted(months, key=lambda item: item["month"]),
}
(PUBLIC_DIR / "russia-unit-economics-months.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
)
print(json.dumps({
    "months": len(months),
    "nasMatched": len(costs),
    "productFallbacks": len(product_fallbacks),
}))
