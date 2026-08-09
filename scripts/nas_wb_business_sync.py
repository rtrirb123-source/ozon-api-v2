#!/usr/bin/env python3
import importlib.util
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


BASE_SCRIPT = "/opt/ozon-api-v2/scripts/nas_unallocated_cloud_sync.py"
spec = importlib.util.spec_from_file_location("nas_common", BASE_SCRIPT)
common = importlib.util.module_from_spec(spec)
spec.loader.exec_module(common)

TARGET = Path("/var/www/ozon-dashboard/wb-business-latest.json")
ARCHIVE_DIR = Path("/var/www/ozon-dashboard/data/wb-business")
INDEX = ARCHIVE_DIR / "index.json"


def previous_month(now):
    year = now.year
    month = now.month - 1
    if month == 0:
        year -= 1
        month = 12
    return f"{year:04d}-{month:02d}"


def list_json(client, folder):
    response = client.call({
        "api": "SYNO.FileStation.List",
        "version": "2",
        "method": "list",
        "folder_path": folder,
        "offset": 0,
        "limit": 1000,
        "filetype": "file",
        "additional": json.dumps(["size", "time"]),
    })
    payload = response.json()
    if not payload.get("success"):
        raise RuntimeError(f"NAS目录读取失败，错误码：{payload.get('error', {}).get('code')}")
    return [
        item for item in payload.get("data", {}).get("files", [])
        if item.get("name", "").lower().endswith(".json")
    ]


def list_shares(client):
    response = client.call({
        "api": "SYNO.FileStation.List",
        "version": "2",
        "method": "list_share",
        "offset": 0,
        "limit": 1000,
    })
    payload = response.json()
    if not payload.get("success"):
        raise RuntimeError(f"NAS共享目录读取失败，错误码：{payload.get('error', {}).get('code')}")
    return payload.get("data", {}).get("shares", [])


def list_directories(client, folder):
    response = client.call({
        "api": "SYNO.FileStation.List",
        "version": "2",
        "method": "list",
        "folder_path": folder,
        "offset": 0,
        "limit": 1000,
        "filetype": "dir",
    })
    payload = response.json()
    if not payload.get("success"):
        return []
    return payload.get("data", {}).get("files", [])


def resolve_folder(client, configured):
    try:
        list_json(client, configured)
        return configured
    except RuntimeError:
        pass
    target_name = Path(configured).name
    for share in list_shares(client):
        share_path = share.get("path") or f"/{share.get('name', '')}"
        queue = [(share_path, 0)]
        visited = set()
        while queue:
            current, depth = queue.pop(0)
            if current in visited or depth > 3:
                continue
            visited.add(current)
            if Path(current).name == target_name:
                return current
            for child in list_directories(client, current):
                child_path = child.get("path") or f"{current}/{child.get('name', '')}"
                if child.get("name") == target_name:
                    return child_path
                queue.append((child_path, depth + 1))
    raise RuntimeError(f"NAS中未找到目录：{target_name}")


def validate_report(report, month):
    if not isinstance(report, dict) or not isinstance(report.get("rows"), list):
        raise RuntimeError("经营看板JSON缺少 rows")
    period_start = str(report.get("period", {}).get("start", ""))
    if not period_start.startswith(month):
        raise RuntimeError(f"经营期间不匹配：期望 {month}，实际 {period_start or '空'}")
    totals = report.get("totals", {})
    if "retailRevenue" not in totals:
        raise RuntimeError("经营看板JSON缺少 totals.retailRevenue")
    report["nasSync"] = {
        "syncedAt": datetime.now(timezone.utc).isoformat(),
        "targetMonth": month,
    }
    return report


def download_json(client, nas_path, local_path):
    response = client.call({
        "api": "SYNO.FileStation.Download",
        "version": "2",
        "method": "download",
        "path": nas_path,
        "mode": "download",
    }, stream=True)
    with open(local_path, "wb") as output:
        for chunk in response.iter_content(1024 * 1024):
            if chunk:
                output.write(chunk)
    if not local_path.read_bytes().lstrip().startswith((b"{", b"\xef\xbb\xbf{")):
        raise RuntimeError(f"NAS下载内容不是JSON：{nas_path}")


def atomic_write(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary = Path(handle.name)
    temporary.replace(path)


def rebuild_index():
    months = []
    for path in sorted(ARCHIVE_DIR.glob("wb-business-????-??.json")):
        match = re.search(r"(\d{4}-\d{2})", path.name)
        if not match:
            continue
        try:
            report = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        months.append({
            "month": match.group(1),
            "label": report.get("period", {}).get("label") or match.group(1),
            "period": report.get("period", {}),
            "rows": len(report.get("rows", [])),
            "retailRevenue": report.get("totals", {}).get("retailRevenue"),
            "syncedAt": report.get("nasSync", {}).get("syncedAt") or report.get("generatedAt"),
        })
    atomic_write(INDEX, {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "latest": months[-1]["month"] if months else None,
        "months": months,
    })


def main():
    month = os.environ.get("WB_BUSINESS_MONTH") or previous_month(datetime.now())
    folder = os.environ.get(
        "WB_BUSINESS_NAS_FOLDER",
        "/公司资料（内部）/WB本土店定期财务数据导出",
    )
    common.verify_certificate(os.environ["NAS_BASE_URL"], os.environ["NAS_CERT_SHA256"])
    client = common.Synology(
        os.environ["NAS_BASE_URL"],
        os.environ["NAS_USERNAME"],
        os.environ["NAS_PASSWORD"],
    )
    client.login()
    try:
        folder = resolve_folder(client, folder)
        candidates = [
            item for item in list_json(client, folder)
            if month in item.get("name", "")
            and re.search(r"(business|经营|retail)", item.get("name", ""), re.IGNORECASE)
        ]
        if not candidates:
            raise RuntimeError(f"NAS目录没有 {month} 的WB经营JSON：{folder}")
        source = max(
            candidates,
            key=lambda item: item.get("additional", {}).get("time", {}).get("mtime", 0),
        )
        with tempfile.TemporaryDirectory(prefix="wb-business-nas-") as temp_dir:
            local_path = Path(temp_dir) / source["name"]
            download_json(client, source.get("path") or f"{folder}/{source['name']}", local_path)
            report = validate_report(json.loads(local_path.read_text(encoding="utf-8-sig")), month)
    finally:
        client.logout()

    report["nasSync"]["sourceFile"] = source["name"]
    atomic_write(ARCHIVE_DIR / f"wb-business-{month}.json", report)
    atomic_write(TARGET, report)
    rebuild_index()
    print(json.dumps({
        "ok": True,
        "month": month,
        "source": source["name"],
        "rows": len(report["rows"]),
        "retailRevenue": report["totals"]["retailRevenue"],
        "target": str(TARGET),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
