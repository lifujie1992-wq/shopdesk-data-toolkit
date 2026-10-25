import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  appendDailyMetricsToSqlite,
  readDailyMetricsFromSqlite,
} from "../src/daily-metrics.js";

function fixture(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE export_info (id INTEGER PRIMARY KEY, completed_at TEXT NOT NULL);
    INSERT INTO export_info VALUES (1, '2026-09-08T12:30:00.000Z');
    CREATE TABLE spu_inventory (
      available_qty REAL, onway_qty REAL, pay_qty_7d REAL,
      stockout_qty REAL, advice_purchase_qty REAL
    );
    INSERT INTO spu_inventory VALUES
      (100, 30, 12, 0, 4),
      (-5, NULL, 0, 8, 0);
    CREATE TABLE shop_stockout_warning (
      shop_stockout_qty REAL, shop_urgent_stockout_qty REAL,
      timeout_qty REAL, due_within_1d_qty REAL, shop_no_sent_qty REAL,
      raw_json TEXT NOT NULL
    );
    INSERT INTO shop_stockout_warning VALUES
      (10, 4, 3, 1, 12, '{"presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout":7}'),
      (6, 2, 2, 0, 8, '{"presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout":2}');
  `);
  db.close();
}

test("calculates the requested daily metrics from a complete inventory export", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jst-daily-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "inventory.sqlite");
  fixture(path);

  assert.deepEqual(readDailyMetricsFromSqlite({ inputPath: path }), {
    snapshot_date: "2026-09-08",
    captured_at: "2026-09-08T12:30:00.000Z",
    warning_style_count: 2,
    stockout_qty: 16,
    urgent_stockout_qty: 6,
    overdue_qty: 5,
    due_within_1d_qty: 1,
    presale_stockout_qty: 9,
    unshipped_qty: 20,
    available_qty: 95,
    onway_qty: 30,
    active_style_count_7d: 1,
    product_stockout_style_count: 1,
    purchase_warning_style_count: 1,
  });
});

test("carries prior daily rows forward and replaces the current date", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jst-daily-history-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const history = join(dir, "history.sqlite");
  const output = join(dir, "output.sqlite");
  fixture(history);
  fixture(output);
  appendDailyMetricsToSqlite({ outputPath: history, snapshotDate: "2026-09-07" });
  appendDailyMetricsToSqlite({ outputPath: output, historyPath: history });

  const db = new DatabaseSync(output, { readOnly: true });
  const dates = db.prepare(
    "SELECT snapshot_date FROM inventory_daily_metrics ORDER BY snapshot_date",
  ).all().map((row) => row.snapshot_date);
  db.close();
  assert.deepEqual(dates, ["2026-09-07", "2026-09-08"]);
});
