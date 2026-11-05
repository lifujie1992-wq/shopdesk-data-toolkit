import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  appendShopShortageToSqlite,
  exportShopShortageToSqlite,
} from "../src/shop-shortage-sqlite.js";

test("exports shop-link details and shop aggregates to SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-shop-shortage-test-"));
  const outputPath = join(directory, "shop-shortage.sqlite");
  const pages = new Map([
    [1, { total: 2, data: [{
      shop_id: 10,
      shop_name: "店铺 A",
      platform: "抖音",
      shop_type: "TouTiaoFXG",
      shop_spu_id: "link-a",
      shop_spu_name: "商品 A",
      no_sent_qty: 12,
      timeout_qty: 2,
      will_timeout_qty_1d: 3,
      present_stock_out_qty: 1,
      insent_no_present_stock_out_qty: 2,
      presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout: 4,
      children: JSON.stringify([{ sku_id: "sku-a" }]),
    }] }],
    [2, { total: 2, data: [{
      shop_id: 10,
      shop_name: "店铺 A",
      platform: "抖音",
      shop_type: "TouTiaoFXG",
      shop_spu_id: "link-b",
      no_sent_qty: 8,
      timeout_qty: 1,
      will_timeout_qty_1d: 1,
      stockout_qty: 6,
    }] }],
  ]);

  try {
    const result = await exportShopShortageToSqlite({
      session: {},
      outputPath,
      pageSize: 1,
      concurrency: 2,
      fetchPage: async (page) => pages.get(page),
    });
    assert.equal(result.fetched_links, 2);
    assert.equal(result.fetched_shops, 1);

    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) count FROM shop_stockout_warning").get().count, 2);
      assert.deepEqual(
        { ...db.prepare(`SELECT shop_stockout_qty, shop_urgent_stockout_qty,
          shop_no_sent_qty FROM shop_shortage_summary WHERE shop_id = '10'`).get() },
        {
          shop_stockout_qty: 13,
          shop_urgent_stockout_qty: 7,
          shop_no_sent_qty: 20,
        },
      );
      assert.equal(
        db.prepare("SELECT urgent_definition FROM shop_shortage_export_info").get().urgent_definition,
        "timeout_qty + will_timeout_qty_1d",
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("appends shop shortage tables without replacing inventory tables", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-shop-shortage-append-test-"));
  const outputPath = join(directory, "inventory.sqlite");
  const db = new DatabaseSync(outputPath);
  db.exec("CREATE TABLE export_info(id INTEGER PRIMARY KEY, schema_version INTEGER); CREATE TABLE sku_inventory(id TEXT PRIMARY KEY);");
  db.prepare("INSERT INTO export_info VALUES(1, 2)").run();
  db.prepare("INSERT INTO sku_inventory VALUES('sku-1')").run();
  db.close();

  try {
    await appendShopShortageToSqlite({
      session: {},
      outputPath,
      fetchPage: async () => ({ total: 1, data: [{
        shop_id: "shop-1",
        shop_spu_id: "link-1",
        timeout_qty: 2,
        will_timeout_qty_1d: 1,
      }] }),
    });
    const result = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(result.prepare("SELECT schema_version FROM export_info").get().schema_version, 2);
      assert.equal(result.prepare("SELECT COUNT(*) count FROM sku_inventory").get().count, 1);
      assert.equal(result.prepare("SELECT COUNT(*) count FROM shop_stockout_warning").get().count, 1);
      assert.equal(result.prepare("SELECT COUNT(*) count FROM shop_shortage_export_info").get().count, 1);
    } finally {
      result.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
