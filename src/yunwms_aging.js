// Read-only inventory-age estimate for the yunwms warehouses.
// On-hand is still sellable + reserved. Shelf records from getAsnList remain the
// FIFO estimate for ordinary receipts. Current WMS batches (getProductInventory
// batch_info) and reshelved special orders (getSpecialOrdersList) are additional
// evidence. A lot whose receiving code is not on an ASN shelf is authoritative
// for that SKU: leftover units are left unknown instead of inheriting an older
// ASN date. Never writes anything.
const DAY_MS = 86400000;
const STALE_MS = 26 * 3600000;
const CANCELLED_SPECIAL = new Set(["X", "0", "void", "VOID", "cancelled", "CANCELED"]);

function chinaDate(ms = Date.now()) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 10); }
function validTime(v) { const t = String(v || ""); return t && !t.startsWith("0000-00-00") && /^\d{4}-\d{2}-\d{2}/.test(t) ? t : ""; }
function int(v) { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : 0; }
function daysBetween(fromDate, toDate) { return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / DAY_MS); }
function stockKey(w, c, s) { return `${w}\u0000${c}\u0000${s}`; }
function onHandOf(row) { return int(row.sellable) + int(row.reserved); }
function nullableInt(v) { return v === undefined || v === null || v === "" ? null : int(v); }
function byNewest(a, b) { return b.shelf_time.localeCompare(a.shelf_time) || b.receiving_code.localeCompare(a.receiving_code); }
function byOldest(a, b) { return a.shelf_time.localeCompare(b.shelf_time) || a.receiving_code.localeCompare(b.receiving_code); }

function normalizeAsn(warehouseKey, asn) {
  return {
    warehouse_key: warehouseKey, receiving_code: String(asn.receiving_code || ""), reference_no: String(asn.reference_no || ""),
    warehouse_code: String(asn.warehouse_code || ""), status: String(asn.receiving_status || ""), shelf_time: validTime(asn.warehouse_shelf_time),
    shelf: (Array.isArray(asn.shelf_inventory_records) ? asn.shelf_inventory_records : []).map((r) => ({
      sku: String(r.product_sku || ""), qty: int(r.sku_quantity), time: validTime(r.warehouse_shelf_time),
    })),
    item_count: Array.isArray(asn.items) ? asn.items.length : 0,
  };
}

function batchQty(raw) {
  if (raw.qty !== undefined && raw.qty !== null && raw.qty !== "") return int(raw.qty);
  const hasSellable = raw.sellable_quantity !== undefined && raw.sellable_quantity !== null && raw.sellable_quantity !== "";
  return hasSellable ? int(raw.sellable_quantity) : int(raw.ib_quantity);
}

function normalizeBatch(raw) {
  const receiving_code = String(raw.receiving_code || "");
  const qty = batchQty(raw);
  if (!receiving_code || qty <= 0) return null;
  const stock_age = nullableInt(raw.stock_age);
  return {
    receiving_code,
    qty,
    time: validTime(raw.ib_fifo_time || raw.warehouse_shelf_time || raw.time || raw.shelf_time),
    stock_age: stock_age != null && stock_age >= 0 ? stock_age : null,
    lc_code: String(raw.lc_code || ""),
  };
}

function sameBatch(a, b) {
  return a.receiving_code === b.receiving_code && a.lc_code === b.lc_code && a.time === b.time && a.stock_age === b.stock_age && a.qty === b.qty;
}

function normalizeWmsInventory(warehouseKey, row) {
  if (!row || typeof row !== "object") return null;
  const product_sku = String(row.product_sku || "");
  const warehouse_key = String(warehouseKey || row.warehouse_key || "");
  if (!product_sku || !warehouse_key) return null;
  const batches = [];
  const source = Array.isArray(row.batches) ? row.batches : (Array.isArray(row.batch_info) ? row.batch_info : []);
  for (const raw of source) {
    const batch = normalizeBatch(raw);
    if (!batch || batches.some((item) => sameBatch(item, batch))) continue;
    const sameLocation = batch.lc_code && batches.find((item) => item.receiving_code === batch.receiving_code && item.lc_code === batch.lc_code);
    if (sameLocation) {
      sameLocation.qty = Math.max(sameLocation.qty, batch.qty);
      if (batch.stock_age != null && (sameLocation.stock_age == null || batch.stock_age < sameLocation.stock_age)) sameLocation.stock_age = batch.stock_age;
      if (!sameLocation.time && batch.time) sameLocation.time = batch.time;
      continue;
    }
    batches.push(batch);
  }
  return {
    warehouse_key,
    warehouse_code: String(row.warehouse_code || ""),
    product_sku,
    shipped: nullableInt(row.shipped),
    batches,
  };
}

function normalizeSpecialOrders(warehouseKey, order) {
  if (!order || typeof order !== "object") return [];
  if (!order.spo_code && !order.detail && order.receiving_code && order.product_sku) {
    const time = validTime(order.time || order.shelf_time);
    const qty = int(order.qty);
    if (!time || qty <= 0) return [];
    return [{
      warehouse_key: String(order.warehouse_key || warehouseKey || ""), warehouse_code: String(order.warehouse_code || ""),
      product_sku: String(order.product_sku), receiving_code: String(order.receiving_code), reference_no: String(order.reference_no || ""), qty, time,
    }];
  }
  const receiving_code = String(order.spo_code || "");
  const status = String(order.spo_status ?? "");
  if (!receiving_code || CANCELLED_SPECIAL.has(status)) return [];
  const time = validTime(order.spo_complete_time) || validTime(order.spo_confirm_time) || validTime(order.spo_add_time);
  if (!time) return [];
  const qtyBySku = new Map();
  for (const line of Array.isArray(order.detail) ? order.detail : []) {
    const sku = String(line.product_sku || "");
    const qty = int(line.sop_putaway_qty);
    if (!sku || qty <= 0) continue;
    qtyBySku.set(sku, (qtyBySku.get(sku) || 0) + qty);
  }
  const warehouse_key = String(warehouseKey || order.warehouse_key || "");
  const lines = [];
  for (const [product_sku, qty] of qtyBySku) {
    lines.push({
      warehouse_key, warehouse_code: String(order.warehouse_code || ""), product_sku, receiving_code, qty, time,
      reference_no: String(order.order_reference_no || order.reference_no || ""),
    });
  }
  return lines;
}

function buildAsnBatches(asns, gaps) {
  const batches = new Map();
  for (const a of asns) {
    if (a.status === "X") continue; // cancelled
    if (!a.shelf.length) { if (a.item_count && a.status === "E") gaps.push({ type: "asn_without_shelf_records", warehouse_key: a.warehouse_key, warehouse_code: a.warehouse_code, receiving_code: a.receiving_code }); continue; }
    const perSku = new Map();
    for (const r of a.shelf) {
      const time = r.time || a.shelf_time;
      if (!r.sku || r.qty <= 0 || !time) { gaps.push({ type: "shelf_record_invalid", warehouse_key: a.warehouse_key, warehouse_code: a.warehouse_code, receiving_code: a.receiving_code, product_sku: r.sku }); continue; }
      const prev = perSku.get(r.sku);
      perSku.set(r.sku, { qty: (prev ? prev.qty : 0) + r.qty, time: prev && prev.time < time ? prev.time : time });
    }
    for (const [sku, v] of perSku) {
      const k = stockKey(a.warehouse_key, a.warehouse_code, sku);
      if (!batches.has(k)) batches.set(k, []);
      batches.get(k).push({ receiving_code: a.receiving_code, reference_no: a.reference_no, shelf_time: v.time, shelf_qty: v.qty });
    }
  }
  return batches;
}

function resolveAge(shelfTime, stockAge, asOf) {
  const shelfDate = validTime(shelfTime).slice(0, 10);
  const calendar = shelfDate ? daysBetween(shelfDate, asOf) : null;
  const safeCalendar = calendar == null || !Number.isFinite(calendar) ? null : Math.max(0, calendar);
  const hasStockAge = stockAge != null && stockAge >= 0;
  // stock_age can stay 0 on the next China calendar day. Never report an age
  // older than the shelf/fifo date, and never invent one when both are missing.
  if (hasStockAge && safeCalendar != null) return { shelf_date: shelfDate, age_days: Math.min(stockAge, safeCalendar), known: true };
  if (hasStockAge) return { shelf_date: shelfDate, age_days: stockAge, known: true };
  if (safeCalendar != null) return { shelf_date: shelfDate, age_days: safeCalendar, known: true };
  return { shelf_date: "", age_days: null, known: false };
}

function pushBatch(out, row, names, lot, keep, age) {
  out.push({
    warehouse_key: row.warehouse_key, warehouse_name: names[row.warehouse_key] || row.warehouse_key, warehouse_code: row.warehouse_code,
    product_sku: row.product_sku, receiving_code: lot.receiving_code, reference_no: lot.reference_no || "", shelf_date: age.shelf_date,
    shelf_qty: lot.shelf_qty, remaining_qty: keep, age_days: age.age_days, sku_on_hand: onHandOf(row),
  });
}

function pushUnknown(gaps, row, qty) {
  if (qty > 0) gaps.push({ type: "stock_unmatched_unknown", warehouse_key: row.warehouse_key, warehouse_code: row.warehouse_code, product_sku: row.product_sku, qty });
}

function emitFifo(out, gaps, row, list, names, asOf, units, exclude) {
  let left = units;
  const sorted = list.filter((batch) => !exclude || !exclude.has(batch.receiving_code)).slice().sort(byNewest);
  if (!sorted.length) {
    if (left > 0) gaps.push({ type: "stock_without_batches", warehouse_key: row.warehouse_key, warehouse_code: row.warehouse_code, product_sku: row.product_sku, qty: left });
    return;
  }
  for (const batch of sorted) {
    const keep = Math.min(left, batch.shelf_qty);
    left -= keep;
    if (keep <= 0) break;
    const shelfDate = batch.shelf_time.slice(0, 10);
    pushBatch(out, row, names, { receiving_code: batch.receiving_code, reference_no: batch.reference_no, shelf_qty: batch.shelf_qty }, keep, { shelf_date: shelfDate, age_days: daysBetween(shelfDate, asOf) });
  }
  if (left > 0) gaps.push({ type: "stock_exceeds_batches", warehouse_key: row.warehouse_key, warehouse_code: row.warehouse_code, product_sku: row.product_sku, qty: left });
}

function referenceFor(code, asnList, returns) {
  const asn = asnList.find((batch) => batch.receiving_code === code);
  if (asn && asn.reference_no) return asn.reference_no;
  const found = returns.find((line) => line.receiving_code === code);
  return found ? found.reference_no || "" : "";
}

function emitAuthoritativeBatches(out, gaps, row, names, asOf, batches, asnList, returns) {
  const lots = batches.map((batch) => {
    const linked = returns.find((line) => line.receiving_code === batch.receiving_code);
    return {
      receiving_code: batch.receiving_code,
      reference_no: referenceFor(batch.receiving_code, asnList, returns),
      shelf_time: batch.time || (linked ? linked.time : ""),
      shelf_qty: batch.qty,
      stock_age: batch.stock_age,
    };
  }).sort(byOldest);
  let left = onHandOf(row);
  for (const lot of lots) {
    if (left <= 0) break;
    const keep = Math.min(left, lot.shelf_qty);
    left -= keep;
    const age = resolveAge(lot.shelf_time, lot.stock_age, asOf);
    if (!age.known) { pushUnknown(gaps, row, keep); continue; }
    pushBatch(out, row, names, lot, keep, age);
  }
  pushUnknown(gaps, row, left);
}

function emitShippedRemainder(out, gaps, row, names, asOf, asnList, returns, shipped) {
  const onHand = onHandOf(row);
  const asnShelfTotal = asnList.reduce((sum, batch) => sum + batch.shelf_qty, 0);
  const asnStill = shipped == null ? 0 : Math.max(0, asnShelfTotal - shipped);
  let budget = Math.max(0, onHand - asnStill);
  let left = onHand;
  const used = new Set();
  const sortedReturns = returns.slice().sort((a, b) => b.time.localeCompare(a.time) || b.receiving_code.localeCompare(a.receiving_code));
  for (const line of sortedReturns) {
    if (budget <= 0 || left <= 0) break;
    if (used.has(line.receiving_code)) continue;
    const keep = Math.min(budget, left, line.qty);
    if (keep <= 0) continue;
    used.add(line.receiving_code);
    budget -= keep;
    left -= keep;
    const age = resolveAge(line.time, null, asOf);
    if (!age.known) { pushUnknown(gaps, row, keep); continue; }
    pushBatch(out, row, names, { receiving_code: line.receiving_code, reference_no: line.reference_no, shelf_qty: line.qty }, keep, age);
  }
  if (budget > 0) {
    const unknown = Math.min(budget, left);
    left -= unknown;
    pushUnknown(gaps, row, unknown);
  }
  if (left <= 0) return;
  if (shipped != null && asnStill <= 0) { pushUnknown(gaps, row, left); return; }
  emitFifo(out, gaps, row, asnList, names, asOf, left, used);
}

function indexEvidence(wmsInventory, specialOrders) {
  const inventory = new Map();
  for (const row of wmsInventory || []) {
    const normalized = normalizeWmsInventory(row && row.warehouse_key, row);
    if (!normalized) continue;
    const k = stockKey(normalized.warehouse_key, normalized.warehouse_code, normalized.product_sku);
    const prev = inventory.get(k);
    if (!prev) { inventory.set(k, normalized); continue; }
    if (normalized.shipped != null) prev.shipped = prev.shipped == null ? normalized.shipped : Math.max(prev.shipped, normalized.shipped);
    for (const batch of normalized.batches) {
      if (prev.batches.some((item) => sameBatch(item, batch))) continue;
      prev.batches.push(batch);
    }
  }
  const returns = new Map();
  for (const order of specialOrders || []) {
    for (const line of normalizeSpecialOrders(order && order.warehouse_key, order)) {
      if (!line.warehouse_key) continue;
      const k = stockKey(line.warehouse_key, line.warehouse_code, line.product_sku);
      if (!returns.has(k)) returns.set(k, []);
      const list = returns.get(k);
      const existing = list.find((item) => item.receiving_code === line.receiving_code);
      if (!existing) list.push(line);
      else if (line.qty > existing.qty) existing.qty = line.qty;
    }
  }
  return { inventory, returns };
}

// Pure: asns (normalized), stock rows, names {key: name}, asOf (YYYY-MM-DD).
// wmsInventory / specialOrders are optional. Omitting both keeps ASN-only FIFO.
function computeAging({ asns, stock, names = {}, asOf, wmsInventory, specialOrders }) {
  const gaps = [];
  const asnBatches = buildAsnBatches(asns, gaps);
  const out = [];
  const evidence = wmsInventory !== undefined || specialOrders !== undefined;
  const indexed = evidence ? indexEvidence(wmsInventory, specialOrders) : null;
  for (const row of stock) {
    const onHand = onHandOf(row);
    if (onHand <= 0) continue;
    const k = stockKey(row.warehouse_key, row.warehouse_code, row.product_sku);
    const asnList = asnBatches.get(k) || [];
    if (!evidence) { emitFifo(out, gaps, row, asnList, names, asOf, onHand); continue; }
    const inv = indexed.inventory.get(k);
    const returns = indexed.returns.get(k) || [];
    const batches = inv ? inv.batches : [];
    const asnCodes = new Set(asnList.map((batch) => batch.receiving_code));
    const hasForeignBatch = batches.some((batch) => !asnCodes.has(batch.receiving_code));
    // No shelf and no return evidence: same gap as ASN-only FIFO.
    if (!hasForeignBatch && !asnList.length && !returns.length) { emitFifo(out, gaps, row, asnList, names, asOf, onHand); continue; }
    if (hasForeignBatch) { emitAuthoritativeBatches(out, gaps, row, names, asOf, batches, asnList, returns); continue; }
    const shipped = inv ? inv.shipped : null;
    // Historical special orders are not current stock. Use them only when shipped
    // shows the ASN shelves cannot hold on-hand, or when there is no ASN at all.
    if (shipped != null || !asnList.length) { emitShippedRemainder(out, gaps, row, names, asOf, asnList, returns, shipped); continue; }
    emitFifo(out, gaps, row, asnList, names, asOf, onHand);
  }
  out.sort((a, b) => b.age_days - a.age_days || a.warehouse_key.localeCompare(b.warehouse_key) || a.product_sku.localeCompare(b.product_sku));
  return { batches: out, gaps };
}

function createAgingService({ yunwms, query, now = () => Date.now() }) {
  const cache = { day: "", asns: null, inventory: null, specials: null, warnings: null, fetchedAt: null, pending: null };
  async function eachPage(warehouse, service, pageSize, label, onRow) {
    let done = false;
    for (let page = 1; page <= 100 && !done; page += 1) {
      const r = await yunwms.callService(warehouse, service, { page, pageSize });
      if (!r || String(r.ask) !== "Success" || !Array.isArray(r.data)) throw new Error(`${label}查询失败`);
      for (const row of r.data) onRow(row);
      done = String(r.nextPage).toLowerCase() !== "true";
    }
    if (!done) throw new Error(`${label}超过 100 页，结果不完整`);
  }
  async function loadAsns() {
    const day = chinaDate(now());
    if (cache.day === day && cache.asns && cache.inventory && cache.specials) return cache;
    if (cache.pending) return cache.pending;
    cache.pending = (async () => {
      const asns = [];
      const inventory = [];
      const specials = [];
      const warnings = [];
      for (const w of yunwms.WAREHOUSES) {
        await eachPage(w, "getAsnList", 50, `${w.name}入库单`, (row) => asns.push(normalizeAsn(w.key, row)));
        await eachPage(w, "getProductInventory", 500, `${w.name}库存批次`, (row) => {
          const normalized = normalizeWmsInventory(w.key, row);
          if (normalized) inventory.push(normalized);
        });
        const warehouseSpecials = [];
        try {
          await eachPage(w, "getSpecialOrdersList", 50, `${w.name}退件特殊单`, (row) => {
            for (const line of normalizeSpecialOrders(w.key, row)) warehouseSpecials.push(line);
          });
          specials.push(...warehouseSpecials);
        } catch (error) {
          warnings.push({ type: "special_orders_unavailable", warehouse_key: w.key, message: String(error.message || "").slice(0, 200) });
        }
      }
      Object.assign(cache, { day, asns, inventory, specials, warnings, fetchedAt: new Date(now()).toISOString() });
      return cache;
    })().finally(() => { cache.pending = null; });
    return cache.pending;
  }
  async function aging() {
    const loaded = await loadAsns();
    const stock = (await query(`SELECT warehouse_key,warehouse_code,product_sku,sellable,reserved,pending,synced_at FROM inventory_yunwms_stock`)).rows;
    const names = Object.fromEntries(yunwms.WAREHOUSES.map((w) => [w.key, w.name]));
    const asOf = chinaDate(now());
    const result = computeAging({ asns: loaded.asns, stock, names, asOf, wmsInventory: loaded.inventory, specialOrders: loaded.specials });
    const warehouses = yunwms.WAREHOUSES.map((w) => {
      const rows = stock.filter((s) => s.warehouse_key === w.key);
      const synced = rows.map((s) => Date.parse(s.synced_at)).filter(Number.isFinite);
      const last = synced.length ? Math.max(...synced) : null;
      return { key: w.key, name: w.name, stock_rows: rows.length, asn_count: loaded.asns.filter((a) => a.warehouse_key === w.key).length,
        stock_synced_at: last ? new Date(last).toISOString() : null, stock_fresh: Boolean(last && now() - last <= STALE_MS) };
    });
    const complete = warehouses.every((w) => w.stock_rows > 0 && w.asn_count > 0 && w.stock_fresh);
    return { as_of: asOf, timezone: "Asia/Shanghai", method: "fifo_estimate", stock_basis: "sellable+reserved",
      asn_fetched_at: loaded.fetchedAt, complete, warehouses, batches: result.batches, gaps: result.gaps, warnings: loaded.warnings };
  }
  return { aging, loadAsns };
}

module.exports = { computeAging, normalizeAsn, normalizeWmsInventory, normalizeSpecialOrders, createAgingService, chinaDate };
