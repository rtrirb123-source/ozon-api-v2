# Overseas warehouse aging: return lots must not inherit a shipped ASN date

This change is not a production deploy. Production stays on the dirty worktree at `49faac8bc38d27ca05cdb939d40522d72d677f06` until that work is explicitly approved. Do not merge this branch into that worktree, and do not copy the sanitized `yunwms.js` from the handoff zip onto the server.

## What was wrong

On 2026-11-06 China time, 世晟 warehouse `001` / SKU `QCPQG1M0125` was reported as 2 units of `RVACS0109-260220-0001` shelved 2026-02-21, age 258 days.

That receipt was a transit ASN (`receiving_type=3`). It put away 193 units and `shipped` is 193. The 2 units on hand are special order `RMAACS0109-261104-0002`, reshelved 2026-11-05 19:30:35 China time, WMS `stock_age=0`. Returns come from `getSpecialOrdersList` and are not in `getAsnList`. The old estimate only had ASN shelves, so newest-first FIFO treated the 2 units as the remainder of the February receipt.

Feeding only that ASN and the stock row still produces age 258. That regression is locked in `test/yunwms_aging.test.js`.

## What the new estimate does

On-hand is still `sellable + reserved`. Batch rows keep the same fields as before. `method` stays `fifo_estimate`. The stock query, sync schedule, schema, alert threshold, dedupe, and warehouse list are unchanged. `src/yunwms.js` and `src/server.js` are not modified.

For each stock row:

1. If `getProductInventory.batch_info` contains a receiving code that is not on an ASN shelf, those WMS batches are the lots. Their quantities are capped at on-hand. A shortfall is `stock_unmatched_unknown` and is not given the old ASN date. `stock_age` is used, but it is never allowed to exceed the age of `ib_fifo_time`. For this return, `stock_age=0` and the fifo date is 2026-11-05, so `age_days` is 0, `shelf_date` is `2026-11-05`, and `receiving_code` is `RMAACS0109-261104-0002`.
2. If there is no such batch, but SKU-level `shipped` shows the ASN shelves cannot hold on-hand, reshelved special orders (`sop_putaway_qty > 0`, not cancelled) fill only that excess, newest first. The same return without `batch_info` is age 1 (calendar days from 2026-11-05 to 2026-11-06), not 258.
3. Otherwise the original ASN FIFO is unchanged. Ordinary 林挺-style receipts, including ones whose `batch_info` only repeats ASN codes, keep the same receiving codes, shelf quantities, and ages. An empty evidence fetch does too.

The same return code is counted once if it appears in both `batch_info` and the special-order list. Exact duplicate batch rows are ignored. `sellable_quantity: 0` does not fall back to historical `ib_quantity`.

`createAgingService` still reads stock with:

```sql
SELECT warehouse_key,warehouse_code,product_sku,sellable,reserved,pending,synced_at FROM inventory_yunwms_stock
```

Once per China day it also reads `getProductInventory` (page size 500) and `getSpecialOrdersList` (page size 50), with the same 100-page cap as `getAsnList`. Those reads are not inventory sync and do not write. A bad ASN or inventory response still fails closed. A special-order failure is a `warnings` entry and does not by itself hide WMS batches. The new `warnings` array is separate from `gaps`.

## Tests

`node --test test/yunwms_aging.test.js` — 22 passed, 0 failed (Node 22), re-run after the source patch was regenerated. `src/yunwms_aging.js` was not edited; its SHA-256 is still `20ebb386c82813b7c6949a0d1d5bd83a77935ebf2248096c379e0b923a21239b`.

Covered cases include the supplied repro (ASN-only age 258; with the supplied batch, age 0), shipped-ASN plus special order without `batch_info` (age 1), mixed 10 old + 2 return, no double count, unknown shortfall, on-hand cap, `stock_age` 400 capped by the fifo date, cancelled and zero-putaway returns, location splits, warehouse isolation, ordinary FIFO with and without evidence, service cache, SQL text, special-order failure, and inventory fail-closed.

`origin/main` (`416b8ee`) has no other test files. The later production commit `49faac8` is not the parent of this branch; its unrelated files were not edited. The production apply path below replaces one untracked file and does not merge those commits.

## Files

| Path | Role |
|---|---|
| `src/yunwms_aging.js` | Fixed estimate. SHA-256 `20ebb386c82813b7c6949a0d1d5bd83a77935ebf2248096c379e0b923a21239b` |
| `test/yunwms_aging.test.js` | Snapshot tests plus regressions |
| `test/fixtures/yunwms_aging/*.json` | Supplied fixtures, unchanged. Minimal fixture SHA-256 `eb7a893b3ba44621ce0e4fe3d548ea5ea1aa90e8653d7e2cdca9ebfc35e80b4e` |
| `patches/yunwms_aging.return-lots.patch` | Source diff against the raw live file, not the handoff comment copy. SHA-256 `bb13e68ab178c9996fd491d38d3085f6862e75443192703f3eafe3550663ebe7` |
| `patches/yunwms_aging.tests.patch` | Test diff against the handoff test file only. Not the production apply artifact |

The handoff copy of `src/yunwms_aging.js` is SHA-256 `95091c2ddf4a4698e56a811eae79e77e7cdfe4db86bbabb090a26e2dc0421615`. Its first line is a packaging comment, `// DESENSITIZED handoff copy...`, that is not in the live file. Deleting only that line produces SHA-256 `48029c6008dd52ed64ad9f38bd69a760405d811261e02ad793358cf1fff9db24`, the raw live baseline. The fixed `src/yunwms_aging.js` never contained that comment, so its hash stays `20ebb386c82813b7c6949a0d1d5bd83a77935ebf2248096c379e0b923a21239b`. There is no comment-only change to the result.

The previous source patch was against `95091c2d…`. On the raw baseline it fails hunk 1 of 3; hunks 2 and 3 apply at a one-line offset. `patches/yunwms_aging.return-lots.patch` is regenerated from `48029c60…` to the fixed file. `patch -p1 --dry-run` is clean, the applied result `cmp` matches `src/yunwms_aging.js`, and that result hashes to `20ebb386…`.

The test file in the handoff zip is SHA-256 `5dd9668be6e86bcb4617f5fc587d63a77b1808bbcb8ca50402c418eaf80fe0bd` and also starts with the packaging comment. `patches/yunwms_aging.tests.patch` is unchanged and is not part of the production file replace.

## Production apply (approval required)

Do not run this until it is approved. Do not deploy, merge, restart, migrate, or edit the live process as part of preparing this branch.

The live aging files are untracked. `src/server.js` already has a local modification that loads them. Leave that modification, `src/yunwms.js`, `.env`, credentials, cron, Xray, rustdesk, sshd, and the database alone. The handoff copy of `yunwms.js` uses placeholder env names (`YUNWMS_<WAREHOUSE>_APP_KEY` / `YUNWMS_<WAREHOUSE>_APP_TOKEN`). Copying it over production would replace the real credential lookup. It is intentionally not in this branch.

On the host, in the worktree that is actually serving (`/opt/ozon-api-v2-current`, HEAD `49faac8`, dirty), without `git checkout`, `git reset`, `git clean`, or `git pull`:

```sh
sha256sum src/yunwms_aging.js src/yunwms.js
# Live source must be 48029c6008dd52ed64ad9f38bd69a760405d811261e02ad793358cf1fff9db24
# before the patch. 95091c2d… is the handoff copy with one extra comment; do not patch that.
# If the live hash is anything else, stop. Do not overwrite yunwms.js.
cp -a src/yunwms_aging.js src/yunwms_aging.js.bak-20261106
patch -p1 --dry-run < yunwms_aging.return-lots.patch
patch -p1 < yunwms_aging.return-lots.patch
sha256sum src/yunwms_aging.js
# Expect 20ebb386c82813b7c6949a0d1d5bd83a77935ebf2248096c379e0b923a21239b
node --check src/yunwms_aging.js
```

Use only `patches/yunwms_aging.return-lots.patch` (SHA-256 `bb13e68ab178c9996fd491d38d3085f6862e75443192703f3eafe3550663ebe7`). Do not apply `patches/yunwms_aging.tests.patch` on the server, and do not merge this PR into the dirty worktree. The tests in this branch do not need live credentials: `node --test test/yunwms_aging.test.js`.

Restart only with the supervisor already used for this worktree, after approval. Do not run `build:watch`, `debug:watch`, migrations, or old deploy scripts.

After restart, a read-only `GET /api/inventory/yunwms/aging` for 世晟 `001` / `QCPQG1M0125` should show one lot: `RMAACS0109-261104-0002`, `shelf_date` `2026-11-05`, `remaining_qty` 2, `age_days` 0, and no 258-day `RVACS0109-260220-0001` row. A 林挺 SKU whose batches are only original ASN receipts should keep its previous FIFO receiving codes and ages. Compare one known 林挺 row from a saved pre-change response before trusting the run.

## Rollback

```sh
cp -a src/yunwms_aging.js.bak-20261106 src/yunwms_aging.js
sha256sum src/yunwms_aging.js
# Expect the raw live baseline 48029c6008dd52ed64ad9f38bd69a760405d811261e02ad793358cf1fff9db24
```

Restart the same way. There is no schema change to undo. Do not restore by copying the handoff `yunwms.js` or by resetting the dirty worktree.

## Limits

- No live WMS call was made. The batch and special-order shapes are the supplied fixtures. If `getProductInventory` omits both `batch_info` and `shipped`, and the special-order read fails or returns nothing, the old ASN FIFO remains and this false alarm can return.
- `batch_info` that only contains ASN receiving codes does not override FIFO. That keeps ordinary 林挺 ages stable. A return booked under the original ASN code, with no extra shipped excess, is still estimated as that ASN.
- SKU-level `shipped` is not lot-level. Without `batch_info`, a mixed original-plus-return balance can be split incorrectly. With the supplied `batch_info`, the mixed case stays 10 units at 258 days and 2 units at 0 days.
- `sellable_quantity` is the batch quantity when it is present, including 0. `ib_quantity` is used only when sellable is absent. On-hand still comes from the synced stock row, which can lag the live batch. Remaining units are capped at that on-hand; they are not written back by sync.
- Evidence is cached until the China date changes, same as the ASN cache. A restart clears it. A special-order failure is cached for that China day; inventory failure is not cached and fails the request.
- Special orders are capped at 100 pages. Past that, the warehouse's special orders are ignored for the day and a warning is returned. Status `X`, `0`, `void`, and `cancelled` are skipped. Putaway quantity is the reshelf signal. There is no published status enum in the snapshot, so some non-cancelled statuses could be skipped or kept incorrectly.
- `stock_age` 0 against fifo date 2026-11-05 is reported as 0 days on 2026-11-06. Calendar age for that date is 1. The alert code that applies the 180-day rule was not in the snapshot or in git, so this patch does not change that rule. Age 0 or 1 should both miss a 180-day alert; that still has to be confirmed against the real notifier.
- Replacing this module does not change 林挺 alert schedule, threshold, dedupe, or warehouse filters, because those settings are not in this file. It also does not change inventory sync times or the stock formula.
