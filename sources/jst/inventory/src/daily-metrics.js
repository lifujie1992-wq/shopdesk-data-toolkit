import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DAILY_METRICS_SCHEMA_VERSION = 1;

export const DAILY_METRICS_COLUMNS = [
  "snapshot_date",
  "captured_at",
  "warning_style_count",
  "stockout_qty",
  "urgent_stockout_qty",
  "overdue_qty",
  "due_within_1d_qty",
  "presale_stockout_qty",
  "unshipped_qty",
  "available_qty",
  "onway_qty",
  "active_style_count_7d",
  "product_stockout_style_count",
  "purchase_warning_style_count",
];

function tableExists(db, table, schema = "main") {
  return Boolean(db.prepare(
    `SELECT 1 AS yes FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table));
}

function shanghaiDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid snapshot timestamp: ${value}`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date).map(({ type, value: part }) => [type, part]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function sourceCompletedAt(db) {
  const stamps = [];
  for (const table of ["export_info", "shop_shortage_export_info"]) {
    if (!tableExists(db, table)) continue;
    const stamp = db.prepare(`SELECT completed_at FROM ${table} ORDER BY id DESC LIMIT 1`).get()?.completed_at;
    if (stamp) stamps.push(stamp);
  }
  return stamps.sort().at(-1) ?? null;
}

function requireSourceTables(db) {
  for (const table of ["spu_inventory", "shop_stockout_warning"]) {
    if (!tableExists(db, table)) throw new Error(`daily metrics require table: ${table}`);
  }
}

function createMetricsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory_daily_metrics (
      snapshot_date TEXT PRIMARY KEY,
      captured_at TEXT NOT NULL,
      warning_style_count INTEGER NOT NULL,
      stockout_qty REAL NOT NULL,
      urgent_stockout_qty REAL NOT NULL,
      overdue_qty REAL NOT NULL,
      due_within_1d_qty REAL NOT NULL,
      presale_stockout_qty REAL NOT NULL,
      unshipped_qty REAL NOT NULL,
      available_qty REAL NOT NULL,
      onway_qty REAL NOT NULL,
      active_style_count_7d INTEGER NOT NULL,
      product_stockout_style_count INTEGER NOT NULL,
      purchase_warning_style_count INTEGER NOT NULL
    );
  `);
}

export function deriveDailyMetrics(db, { snapshotDate, capturedAt } = {}) {
  requireSourceTables(db);
  const captured = capturedAt ?? sourceCompletedAt(db) ?? new Date().toISOString();
  const inventory = db.prepare(`
    SELECT
      COALESCE(SUM(available_qty), 0) AS available_qty,
      COALESCE(SUM(onway_qty), 0) AS onway_qty,
      COUNT(CASE WHEN COALESCE(pay_qty_7d, 0) > 0 THEN 1 END) AS active_style_count_7d,
      COUNT(CASE WHEN COALESCE(stockout_qty, 0) > 0 THEN 1 END) AS product_stockout_style_count,
      COUNT(CASE WHEN COALESCE(advice_purchase_qty, 0) > 0 THEN 1 END) AS purchase_warning_style_count
    FROM spu_inventory
  `).get();
  const shortage = db.prepare(`
    SELECT
      COUNT(*) AS warning_style_count,
      COALESCE(SUM(shop_stockout_qty), 0) AS stockout_qty,
      COALESCE(SUM(shop_urgent_stockout_qty), 0) AS urgent_stockout_qty,
      COALESCE(SUM(timeout_qty), 0) AS overdue_qty,
      COALESCE(SUM(due_within_1d_qty), 0) AS due_within_1d_qty,
      COALESCE(SUM(CAST(json_extract(
        raw_json,
        '$.presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout'
      ) AS REAL)), 0) AS presale_stockout_qty,
      COALESCE(SUM(shop_no_sent_qty), 0) AS unshipped_qty
    FROM shop_stockout_warning
  `).get();
  return {
    snapshot_date: snapshotDate ?? shanghaiDate(captured),
    captured_at: captured,
    warning_style_count: Number(shortage.warning_style_count),
    stockout_qty: Number(shortage.stockout_qty),
    urgent_stockout_qty: Number(shortage.urgent_stockout_qty),
    overdue_qty: Number(shortage.overdue_qty),
    due_within_1d_qty: Number(shortage.due_within_1d_qty),
    presale_stockout_qty: Number(shortage.presale_stockout_qty),
    unshipped_qty: Number(shortage.unshipped_qty),
    available_qty: Number(inventory.available_qty),
    onway_qty: Number(inventory.onway_qty),
    active_style_count_7d: Number(inventory.active_style_count_7d),
    product_stockout_style_count: Number(inventory.product_stockout_style_count),
    purchase_warning_style_count: Number(inventory.purchase_warning_style_count),
  };
}

export function readDailyMetricsFromSqlite({ inputPath, snapshotDate }) {
  const db = new DatabaseSync(resolve(inputPath), { readOnly: true });
  try {
    return deriveDailyMetrics(db, { ...(snapshotDate ? { snapshotDate } : {}) });
  } finally {
    db.close();
  }
}

export function appendDailyMetricsToSqlite({
  outputPath,
  historyPath,
  snapshotDate,
  capturedAt,
}) {
  const resolvedOutput = resolve(outputPath);
  const resolvedHistory = historyPath ? resolve(historyPath) : null;
  const db = new DatabaseSync(resolvedOutput);
  let historyAttached = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    createMetricsTable(db);
    if (resolvedHistory && resolvedHistory !== resolvedOutput && existsSync(resolvedHistory)) {
      db.prepare("ATTACH DATABASE ? AS history").run(resolvedHistory);
      historyAttached = true;
      if (tableExists(db, "inventory_daily_metrics", "history")) {
        const columns = DAILY_METRICS_COLUMNS.join(", ");
        db.exec(`INSERT OR REPLACE INTO inventory_daily_metrics (${columns}) SELECT ${columns} FROM history.inventory_daily_metrics`);
      }
    }
    const metrics = deriveDailyMetrics(db, {
      ...(snapshotDate ? { snapshotDate } : {}),
      ...(capturedAt ? { capturedAt } : {}),
    });
    const values = DAILY_METRICS_COLUMNS.map((column) => metrics[column]);
    db.prepare(`
      INSERT OR REPLACE INTO inventory_daily_metrics (${DAILY_METRICS_COLUMNS.join(", ")})
      VALUES (${DAILY_METRICS_COLUMNS.map(() => "?").join(", ")})
    `).run(...values);
    db.exec("COMMIT");
    if (historyAttached) db.exec("DETACH DATABASE history");
    return metrics;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}
