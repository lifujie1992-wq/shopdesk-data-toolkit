import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { exportInventoryToSqlite } from "../src/sqlite-export.js";

test("exports paginated SPU and SKU rows to SQLite", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-inventory-test-"));
  const outputPath = join(directory, "inventory.sqlite");
  const pages = new Map([
    [1, { total: 2, data: [{
      spu_id: "spu-1",
      return_onway_item_qty: 5,
      inout_sent_item_qty_today: 6,
      inout_sent_item_qty_1d: 7,
      inout_sent_item_qty_3d: 8,
      inout_sent_item_qty_7d: 9,
      gross_margin_7d: 0.42,
      supplier_name: "supplier-a",
      spu_remark: "spu-note",
      remark_time: "2026-09-01 10:00:00",
      children: [{
        spu_id: "spu-1",
        sku_id: "sku-1",
        return_onway_item_qty: 10,
        inout_sent_item_qty_today: 11,
        inout_sent_item_qty_1d: 12,
        inout_sent_item_qty_3d: 13,
        inout_sent_item_qty_7d: 14,
        pay_qty_7d: 70,
        pay_avg_qty_1d: 12,
        cost_price: 23.5,
        last_purchase_price: 21.5,
        sku_labels: ["new", "priority"],
        sent_send_refund_afs_item_qty_rate_pre3to5: 0.08,
        sent_send_refund_afs_item_qty_rate_pre7to15: 0.18,
        sent_send_refund_afs_item_qty_rate_pre15to30: 0.28,
        sent_send_refund_afs_item_qty_rate_pre7to180: 0.38,
      }],
    }] }],
    [2, { total: 2, data: [{ spu_id: "spu-2", children: JSON.stringify([{ spu_id: "spu-2", sku_id: "sku-2" }]) }] }],
  ]);

  try {
    const result = await exportInventoryToSqlite({
      session: {},
      outputPath,
      pageSize: 1,
      concurrency: 2,
      fetchPage: async (page) => pages.get(page),
      fetchShops: async () => ({ code: 0, success: true, data: [{
        shopSite: "拼多多",
        shopList: [{ shop_id: 101, shop_name: "多多一店" }],
      }, {
        shopSite: "抖音",
        shopList: [{ shop_id: 202, shop_name: "抖音一店" }],
      }] }),
      fetchShopGroups: async () => ({ code: 0, success: true, data: [{
        group_id: 93486,
        group_name: "第一事业部（家宜）",
        shop_cnt: 2,
        shop_list: "[101,202]",
      }] }),
    });
    assert.equal(result.fetched_spu, 2);
    assert.equal(result.fetched_sku, 2);

    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM spu_inventory").get().count, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sku_inventory").get().count, 2);
      assert.equal(db.prepare("SELECT fetched_sku FROM export_info").get().fetched_sku, 2);
      assert.equal(db.prepare("SELECT schema_version FROM export_info").get().schema_version, 6);
      assert.equal(result.fetched_shops, 2);
      assert.equal(result.fetched_shop_groups, 1);
      assert.equal(result.fetched_shop_group_members, 2);
      assert.deepEqual(
        db.prepare("SELECT shop_id,shop_name,platform FROM shop_directory ORDER BY shop_id").all().map(row => ({ ...row })),
        [
          { shop_id: "101", shop_name: "多多一店", platform: "拼多多" },
          { shop_id: "202", shop_name: "抖音一店", platform: "抖音" },
        ],
      );
      assert.deepEqual(
        db.prepare("SELECT group_id,group_name,shop_count FROM shop_groups").all().map(row => ({ ...row })),
        [{ group_id: "93486", group_name: "第一事业部（家宜）", shop_count: 2 }],
      );
      assert.deepEqual(
        db.prepare("SELECT group_id,shop_id FROM shop_group_members ORDER BY shop_id").all().map(row => ({ ...row })),
        [{ group_id: "93486", shop_id: "101" }, { group_id: "93486", shop_id: "202" }],
      );
      assert.deepEqual(
        { ...db.prepare(`SELECT return_onway_item_qty, inout_sent_item_qty_today,
          inout_sent_item_qty_1d, inout_sent_item_qty_3d,
          inout_sent_item_qty_7d FROM spu_inventory WHERE spu_id = 'spu-1'`).get() },
        {
          return_onway_item_qty: 5,
          inout_sent_item_qty_today: 6,
          inout_sent_item_qty_1d: 7,
          inout_sent_item_qty_3d: 8,
          inout_sent_item_qty_7d: 9,
        },
      );
      assert.deepEqual(
        { ...db.prepare(`SELECT pay_qty_1d,
          cost_price, last_purchase_price, labels,
          sent_send_refund_afs_item_qty_rate_pre3to5,
          sent_send_refund_afs_item_qty_rate_pre7to15,
          sent_send_refund_afs_item_qty_rate_pre15to30,
          sent_send_refund_afs_item_qty_rate_pre7to180
          FROM sku_inventory WHERE sku_id = 'sku-1'`).get() },
        {
          pay_qty_1d: null,
          cost_price: 23.5,
          last_purchase_price: 21.5,
          labels: '["new","priority"]',
          sent_send_refund_afs_item_qty_rate_pre3to5: 0.08,
          sent_send_refund_afs_item_qty_rate_pre7to15: 0.18,
          sent_send_refund_afs_item_qty_rate_pre15to30: 0.28,
          sent_send_refund_afs_item_qty_rate_pre7to180: 0.38,
        },
      );
      assert.deepEqual(
        { ...db.prepare(`SELECT supplier_name, spu_remark, remark_time,
          gross_margin_7d FROM spu_inventory WHERE spu_id = 'spu-1'`).get() },
        {
          supplier_name: "supplier-a",
          spu_remark: "spu-note",
          remark_time: "2026-09-01 10:00:00",
          gross_margin_7d: 0.42,
        },
      );
      assert.deepEqual(
        { ...db.prepare(`SELECT return_onway_item_qty, inout_sent_item_qty_today,
          inout_sent_item_qty_1d, inout_sent_item_qty_3d,
          inout_sent_item_qty_7d FROM sku_inventory WHERE sku_id = 'sku-1'`).get() },
        {
          return_onway_item_qty: 10,
          inout_sent_item_qty_today: 11,
          inout_sent_item_qty_1d: 12,
          inout_sent_item_qty_3d: 13,
          inout_sent_item_qty_7d: 14,
        },
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
