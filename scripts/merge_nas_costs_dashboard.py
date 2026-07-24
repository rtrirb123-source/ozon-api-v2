import json
import os
import shutil
import re
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path("/opt/ozon-api-v2/dashboard")
SNAPSHOT = Path("/opt/ozon-api-v2/data/nas-costs-dashboard.json")
PUBLIC_DIR = Path("/var/www/ozon-dashboard")

snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
costs = {str(item["sku"]): item for item in snapshot.get("matched", [])}
months = []
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
for base in sorted(BASE_DIR.glob("russia-unit-economics-????-??.json")):
    match = re.search(r"(\d{4}-\d{2})\.json$", base.name)
    if not match:
        continue
    dashboard = json.loads(base.read_text(encoding="utf-8"))
    for row in dashboard.get("rows", []):
        cost = costs.get(str(row.get("sku")))
        row["purchaseCost"] = cost.get("totalCostCny") if cost else None
        row["weightG"] = cost.get("weightG") if cost else None
    dashboard["costCurrency"] = "CNY"
    dashboard["costSource"] = snapshot.get("source")
    dashboard["costSourceUpdatedAt"] = snapshot.get("generatedAt")
    dashboard["costMergedAt"] = datetime.now(timezone.utc).isoformat()
    dashboard["costMatchedCount"] = len(costs)
    dashboard["costUnmatched"] = snapshot.get("unmatched", [])
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
print(json.dumps({"months": len(months), "matched": len(costs)}))
