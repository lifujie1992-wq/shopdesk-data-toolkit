import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { dateRange } from "../src/api.js";
import { exportOrderItemsToSqlite, ITEM_FIELDS } from "../src/item-sqlite-export.js";

test("exports distinct item rows from the same order", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-order-items-test-"));
  const outputPath = join(directory, "items.sqlite");
  try {
    const result = await exportOrderItemsToSqlite({
      session: {},
      range: dateRange(1, "2026-09-07"),
      outputPath,
      fetchPage: async () => ({ total: 2, data: [
        { o_id: 10, sku_id: "sku-a", oi_shop_sku_id: "shop-a", oi_outer_oi_id: "line-a", order_qty: "1" },
        { o_id: 10, sku_id: "sku-b", oi_shop_sku_id: "shop-b", oi_outer_oi_id: "line-b", order_qty: "2" },
      ] }),
      fetchSummary: async () => ({ data: [{ order_qty: 3 }] }),
    });
    assert.equal(result.saved_rows, 2);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT count(*) count FROM order_item_details").get().count, 2);
      assert.equal(db.prepare("SELECT sum(order_qty) qty FROM order_item_details").get().qty, 3);
      assert.equal(db.prepare("SELECT schema_version FROM item_sync_info").get().schema_version, 1);
      const columns = db.prepare("PRAGMA table_info(order_item_details)").all().map((row) => row.name);
      assert.deepEqual(columns, ["row_key", ...ITEM_FIELDS, "raw_json"]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("appends item tables without replacing existing order tables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-order-items-append-test-"));
  const outputPath = join(directory, "orders.sqlite");
  const db = new DatabaseSync(outputPath);
  db.exec("CREATE TABLE order_details(o_id TEXT PRIMARY KEY); INSERT INTO order_details VALUES('keep')");
  db.close();
  try {
    const result = await exportOrderItemsToSqlite({
      session: {}, range: dateRange(1, "2026-09-07"), outputPath, append: true,
      fetchPage: async () => ({ total: 1, data: [
        { o_id: 10, sku_id: "sku-a", oi_outer_oi_id: "line-a" },
      ] }),
      fetchSummary: async () => ({ data: [] }),
    });
    assert.equal(result.appended, true);
    const output = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(output.prepare("SELECT count(*) count FROM order_details").get().count, 1);
      assert.equal(output.prepare("SELECT count(*) count FROM order_item_details").get().count, 1);
    } finally {
      output.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
