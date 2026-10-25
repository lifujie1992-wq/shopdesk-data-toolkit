import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  appendSalesAnalysisToSqlite,
  copySalesAnalysisFromSqlite,
} from "../src/sales-analysis-sqlite.js";

test("appends direct all-SPU sales-analysis rows without replacing inventory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-sales-analysis-test-"));
  const outputPath = join(directory, "inventory.sqlite");
  const db = new DatabaseSync(outputPath);
  db.exec("CREATE TABLE export_info(id INTEGER PRIMARY KEY); CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO export_info VALUES(1)").run();
  db.prepare("INSERT INTO spu_inventory VALUES('a'),('b')").run();
  db.close();
  const requested = [];

  try {
    const result = await appendSalesAnalysisToSqlite({
      session: {},
      outputPath,
      days: 30,
      endDate: "2026-09-06",
      concurrency: 2,
      fetchAnalysis: async (spuId) => {
        requested.push(spuId);
        return {
          spu_id: spuId,
          start_date: "2026-08-08",
          end_date: "2026-09-06",
          previous_start_date: "2026-07-09",
          previous_end_date: "2026-08-07",
          shops: [{
            shop_id: "shop-1",
            shop_name: "Store",
            platform: "Platform",
            order_item_qty_increase: 2,
            sales_qty: 10,
            previous_sales_qty: 8,
            sales_chain_ratio: 0.25,
            sales_chain_percent: 25,
            sales_amount: 299.5,
            previous_sales_amount: 200,
            sales_amount_increase: 99.5,
            sales_amount_chain_ratio: 0.4975,
            sales_amount_chain_percent: 49.75,
            order_count: 8,
            previous_order_count: 5,
            order_count_increase: 3,
            order_count_chain_ratio: 0.6,
            order_count_chain_percent: 60,
            paid_return_qty: 3,
            paid_return_qty_180d: 30,
            return_item_qty_180d: 28,
            shipped_qty_180d: 40,
            paid_return_chain_ratio: 0.5,
            paid_return_chain_percent: 50,
            gross_margin_7d: 0.25,
            gross_margin_30d: 0.2,
            sent_send_refund_afs_item_qty_rate_pre3to5: 0.1,
            sent_send_refund_afs_item_qty_rate_pre5to7: 0.2,
            sent_send_refund_afs_item_qty_rate_pre7to15: 0.3,
            sent_send_refund_afs_item_qty_rate_pre15to30: 0.4,
            sent_send_refund_afs_item_qty_rate_pre7to180: spuId === "a" ? 0.5 : undefined,
          }],
        };
      },
      fetchPlatform: async (spuId) => ({
        spu_id: spuId,
        start_date: "2026-08-08",
        end_date: "2026-09-06",
        previous_start_date: "2026-07-09",
        previous_end_date: "2026-08-07",
        rows: [{
          platform: "Platform",
          order_item_qty_increase: 2,
          sales_qty: 10,
          previous_sales_qty: 8,
          sales_chain_ratio: 0.25,
          sales_chain_percent: 25,
          sales_amount: 299.5,
          previous_sales_amount: 200,
          sales_amount_increase: 99.5,
          sales_amount_chain_ratio: 0.4975,
          sales_amount_chain_percent: 49.75,
          order_count: 8,
          previous_order_count: 5,
          order_count_increase: 3,
          order_count_chain_ratio: 0.6,
          order_count_chain_percent: 60,
          paid_return_qty: 3,
          paid_return_qty_180d: 30,
          return_item_qty_180d: 28,
          shipped_qty_180d: 40,
          paid_return_chain_ratio: 0.5,
          paid_return_chain_percent: 50,
        }],
      }),
      fetchLink: async (spuId) => ({
        spu_id: spuId,
        start_date: "2026-08-08",
        end_date: "2026-09-06",
        previous_start_date: "2026-07-09",
        previous_end_date: "2026-08-07",
        rows: [{
          shop_id: "shop-1",
          shop_name: "Store",
          platform: "Platform",
          shop_spu_id: `link-${spuId}`,
          shop_i_id: 123,
          shop_spu_name: "Hot item",
          shop_spu_pic: "https://example.test/pic.jpg",
          shop_spu_created: "2026-01-02 03:04:05",
          shop_spu_created_day: 248,
          shop_sku_id: 456,
          shop_sku_url: "https://example.test/item/123",
          order_item_qty_increase: 2,
          sales_qty: 10,
          previous_sales_qty: 8,
          sales_chain_ratio: 0.25,
          sales_chain_percent: 25,
          sales_amount: 299.5,
          previous_sales_amount: 200,
          sales_amount_increase: 99.5,
          sales_amount_chain_ratio: 0.4975,
          sales_amount_chain_percent: 49.75,
          order_count: 8,
          previous_order_count: 5,
          order_count_increase: 3,
          order_count_chain_ratio: 0.6,
          order_count_chain_percent: 60,
          paid_return_qty: 3,
          paid_return_qty_180d: 30,
          return_item_qty_180d: 28,
          shipped_qty_180d: 40,
          paid_return_chain_ratio: 0.5,
          paid_return_chain_percent: 50,
        }],
      }),
      fetchChannelQty: async (spuId) => ({
        spu_id: spuId,
        rows: [{
          shop_id: "shop-1",
          pay_qty_today: 1,
          pay_qty_3d: 3,
          pay_qty_7d: 7,
          pay_qty_15d: 15,
          pay_qty_30d: 30,
        }],
      }),
      fetchPlatformQty: async (spuId) => ({
        spu_id: spuId,
        rows: [{
          platform: "Platform",
          pay_qty_today: 1,
          pay_qty_3d: 3,
          pay_qty_7d: 7,
          pay_qty_15d: 15,
          pay_qty_30d: 30,
        }],
      }),
      fetchLinkQty: async (spuId) => ({
        spu_id: spuId,
        rows: [{
          shop_id: "shop-1",
          shop_spu_id: `link-${spuId}`,
          pay_qty_today: 1,
          pay_qty_3d: 3,
          pay_qty_7d: 7,
          pay_qty_15d: 15,
          pay_qty_30d: 30,
        }],
      }),
    });
    assert.deepEqual(requested.sort(), ["a", "b"]);
    assert.equal(result.fetched_spus, 2);
    assert.equal(result.fetched_rows, 2);
    assert.equal(result.fetched_shop_rows, 2);
    assert.equal(result.fetched_platform_rows, 2);
    assert.equal(result.fetched_link_rows, 2);
    assert.equal(result.fetched_daily_rows, 0);
    assert.equal(result.fetched_shop_daily_rows, 0);
    const output = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(output.prepare("SELECT COUNT(*) count FROM export_info").get().count, 1);
      assert.equal(output.prepare("SELECT COUNT(*) count FROM shop_product_sales_analysis").get().count, 2);
      assert.equal(output.prepare("SELECT COUNT(*) count FROM platform_product_sales_analysis").get().count, 2);
      assert.equal(output.prepare("SELECT COUNT(*) count FROM link_product_sales_analysis").get().count, 2);
      assert.equal(output.prepare("SELECT COUNT(*) count FROM sales_analysis_export_info").get().count, 1);
      assert.equal(output.prepare("SELECT COUNT(*) count FROM product_daily_sales_analysis").get().count, 0);
      assert.equal(output.prepare("SELECT COUNT(*) count FROM shop_daily_sales_analysis").get().count, 0);
      assert.equal(output.prepare("SELECT sales_chain_percent FROM shop_product_sales_analysis WHERE spu_id = 'a'").get().sales_chain_percent, null);
      const shop = output.prepare(
        "SELECT sales_amount, previous_sales_amount, order_count, gross_margin_7d, "
        + "return_item_qty_180d, "
        + "sent_send_refund_afs_item_qty_rate_pre15to30 "
        + "FROM shop_product_sales_analysis WHERE spu_id = 'a'",
      ).get();
      assert.equal(shop.sales_amount, 299.5);
      assert.equal(shop.previous_sales_amount, null);
      assert.equal(shop.order_count, 8);
      assert.equal(shop.gross_margin_7d, 0.25);
      assert.equal(shop.return_item_qty_180d, 28);
      assert.equal(shop.sent_send_refund_afs_item_qty_rate_pre15to30, 0.4);
      assert.equal(output.prepare(
        "SELECT sent_send_refund_afs_item_qty_rate_pre7to180 value "
        + "FROM shop_product_sales_analysis WHERE spu_id = 'b'",
      ).get().value, null);
      assert.equal(output.prepare("SELECT fetched_daily_rows FROM sales_analysis_export_info").get().fetched_daily_rows, 0);
      assert.deepEqual({ ...output.prepare(
        "SELECT schema_version, fetched_platform_rows, fetched_link_rows FROM sales_analysis_export_info",
      ).get() }, { schema_version: 10, fetched_platform_rows: 2, fetched_link_rows: 2 });
      assert.deepEqual({ ...output.prepare(
        "SELECT shop_i_id, shop_spu_name, shop_spu_created_day, shop_sku_url, "
        + "pay_qty_today, pay_qty_3d, pay_qty_7d, pay_qty_15d, pay_qty_30d "
        + "FROM link_product_sales_analysis WHERE spu_id = 'a'",
      ).get() }, {
        shop_i_id: "123",
        shop_spu_name: "Hot item",
        shop_spu_created_day: 248,
        shop_sku_url: "https://example.test/item/123",
        pay_qty_today: 1,
        pay_qty_3d: 3,
        pay_qty_7d: 7,
        pay_qty_15d: 15,
        pay_qty_30d: 30,
      });
    } finally {
      output.close();
    }

    const reusedPath = join(directory, "reused.sqlite");
    const reused = new DatabaseSync(reusedPath);
    reused.exec("CREATE TABLE export_info(id INTEGER PRIMARY KEY); CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY)");
    reused.close();
    const copied = copySalesAnalysisFromSqlite({ sourcePath: outputPath, outputPath: reusedPath });
    assert.equal(copied.tables.shop_product_sales_analysis, 2);
    assert.equal(copied.tables.platform_product_sales_analysis, 2);
    assert.equal(copied.tables.link_product_sales_analysis, 2);
    assert.equal(copied.tables.product_daily_sales_analysis, 0);
    assert.equal(copied.tables.shop_daily_sales_analysis, 0);
    const copiedDb = new DatabaseSync(reusedPath, { readOnly: true });
    try {
      assert.equal(copiedDb.prepare(
        "SELECT sales_amount FROM shop_product_sales_analysis WHERE spu_id = 'a'",
      ).get().sales_amount, 299.5);
    } finally {
      copiedDb.close();
    }

    const legacyPath = join(directory, "legacy.sqlite");
    copyFileSync(outputPath, legacyPath);
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec("ALTER TABLE shop_product_sales_analysis DROP COLUMN return_item_qty_180d");
    legacy.exec("ALTER TABLE shop_product_sales_analysis DROP COLUMN pay_qty_today");
    legacy.exec("ALTER TABLE shop_product_sales_analysis DROP COLUMN pay_qty_3d");
    legacy.exec("ALTER TABLE shop_product_sales_analysis DROP COLUMN pay_qty_7d");
    legacy.exec("ALTER TABLE shop_product_sales_analysis DROP COLUMN pay_qty_15d");
    legacy.exec("ALTER TABLE shop_product_sales_analysis DROP COLUMN pay_qty_30d");
    legacy.exec("ALTER TABLE sales_analysis_export_info DROP COLUMN fetched_shop_daily_rows");
    legacy.exec("ALTER TABLE sales_analysis_export_info DROP COLUMN fetched_platform_rows");
    legacy.exec("ALTER TABLE sales_analysis_export_info DROP COLUMN fetched_link_rows");
    legacy.exec("DROP TABLE platform_product_sales_analysis");
    legacy.exec("DROP TABLE link_product_sales_analysis");
    legacy.exec("DROP TABLE shop_daily_sales_analysis");
    legacy.close();
    const migratedPath = join(directory, "migrated.sqlite");
    const migrated = new DatabaseSync(migratedPath);
    migrated.exec("CREATE TABLE export_info(id INTEGER PRIMARY KEY); CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY)");
    migrated.close();
    copySalesAnalysisFromSqlite({ sourcePath: legacyPath, outputPath: migratedPath });
    const migratedDb = new DatabaseSync(migratedPath, { readOnly: true });
    try {
      assert.equal(migratedDb.prepare(
        "SELECT return_item_qty_180d FROM shop_product_sales_analysis LIMIT 1",
      ).get().return_item_qty_180d, null);
      assert.deepEqual({ ...migratedDb.prepare(
        "SELECT pay_qty_today, pay_qty_3d, pay_qty_7d, pay_qty_15d, pay_qty_30d "
        + "FROM shop_product_sales_analysis LIMIT 1",
      ).get() }, {
        pay_qty_today: null,
        pay_qty_3d: null,
        pay_qty_7d: null,
        pay_qty_15d: null,
        pay_qty_30d: null,
      });
      assert.equal(migratedDb.prepare(
        "SELECT fetched_shop_daily_rows FROM sales_analysis_export_info",
      ).get().fetched_shop_daily_rows, 0);
      assert.deepEqual({ ...migratedDb.prepare(
        "SELECT fetched_platform_rows, fetched_link_rows FROM sales_analysis_export_info",
      ).get() }, { fetched_platform_rows: 0, fetched_link_rows: 0 });
      assert.equal(migratedDb.prepare(
        "SELECT COUNT(*) count FROM platform_product_sales_analysis",
      ).get().count, 0);
      assert.equal(migratedDb.prepare(
        "SELECT COUNT(*) count FROM link_product_sales_analysis",
      ).get().count, 0);
      assert.equal(migratedDb.prepare(
        "SELECT COUNT(*) count FROM shop_daily_sales_analysis",
      ).get().count, 0);
    } finally {
      migratedDb.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoints committed SPU batches and resumes only unfinished SPUs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-sales-analysis-checkpoint-test-"));
  const outputPath = join(directory, "inventory.sqlite");
  const db = new DatabaseSync(outputPath);
  db.exec("CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY)");
  db.prepare("INSERT INTO spu_inventory VALUES('a'),('b'),('c'),('d')").run();
  db.close();

  let failC = true;
  let requested = [];
  const emptyAnalysis = (spuId) => ({
    spu_id: spuId,
    start_date: "2026-08-08",
    end_date: "2026-09-06",
    previous_start_date: "2026-07-09",
    previous_end_date: "2026-08-07",
    shops: [],
  });
  const options = {
    session: {},
    outputPath,
    endDate: "2026-09-06",
    concurrency: 2,
    fetchAnalysis: async (spuId) => {
      requested.push(spuId);
      if (failC && spuId === "c") throw new Error("simulated_api_failure");
      return emptyAnalysis(spuId);
    },
    fetchPlatform: async (spuId) => ({ ...emptyAnalysis(spuId), rows: [] }),
    fetchLink: async (spuId) => ({ ...emptyAnalysis(spuId), rows: [] }),
  };

  try {
    await assert.rejects(appendSalesAnalysisToSqlite(options), /simulated_api_failure/);
    const interrupted = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(interrupted.prepare(
        "SELECT count(*) count FROM sales_analysis_checkpoint_spu",
      ).get().count, 2);
      assert.equal(interrupted.prepare(
        "SELECT count(*) count FROM sales_analysis_export_info",
      ).get().count, 0);
    } finally {
      interrupted.close();
    }

    failC = false;
    requested = [];
    const resumed = await appendSalesAnalysisToSqlite(options);
    assert.equal(resumed.resumed, true);
    assert.deepEqual(requested.sort(), ["c", "d"]);
    const completed = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(completed.prepare(
        "SELECT count(*) count FROM sales_analysis_export_info",
      ).get().count, 1);
      assert.equal(completed.prepare(
        "SELECT count(*) count FROM sqlite_master WHERE name = 'sales_analysis_checkpoint'",
      ).get().count, 0);
    } finally {
      completed.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("does not request rolling detail for an empty page dimension", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-sales-analysis-empty-test-"));
  const outputPath = join(directory, "inventory.sqlite");
  const db = new DatabaseSync(outputPath);
  db.exec("CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY); INSERT INTO spu_inventory VALUES('a')");
  db.close();
  const empty = {
    spu_id: "a",
    start_date: "2026-08-08",
    end_date: "2026-09-06",
    previous_start_date: "2026-07-09",
    previous_end_date: "2026-08-07",
  };
  try {
    await appendSalesAnalysisToSqlite({
      session: {},
      outputPath,
      endDate: "2026-09-06",
      fetchAnalysis: async () => ({ ...empty, shops: [] }),
      fetchPlatform: async () => ({ ...empty, rows: [] }),
      fetchLink: async () => ({ ...empty, rows: [] }),
      fetchChannelQty: async () => { throw new Error("unexpected channel request"); },
      fetchPlatformQty: async () => { throw new Error("unexpected platform request"); },
      fetchLinkQty: async () => { throw new Error("unexpected link request"); },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("sales-analysis refresh does not request or alter daily history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-shop-daily-history-test-"));
  const outputPath = join(directory, "inventory.sqlite");
  const db = new DatabaseSync(outputPath);
  db.exec(`
    CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY);
    INSERT INTO spu_inventory VALUES('a');
    CREATE TABLE shop_daily_sales_analysis (
      spu_id TEXT NOT NULL, shop_id TEXT NOT NULL, biz_date TEXT NOT NULL,
      sales_qty REAL NOT NULL, sales_amount REAL NOT NULL, order_count REAL NOT NULL,
      return_item_qty REAL, raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, shop_id, biz_date)
    );
    INSERT INTO shop_daily_sales_analysis VALUES
      ('a', 'old-shop', '2026-09-05', 1, 2, 1, 0, '{}'),
      ('a', 'stale-shop', '2026-09-06', 1, 2, 1, 0, '{}');
  `);
  db.close();

  try {
    await appendSalesAnalysisToSqlite({
      session: {},
      outputPath,
      endDate: "2026-09-06",
      fetchAnalysis: async (spuId) => ({
        spu_id: spuId,
        start_date: "2026-08-08",
        end_date: "2026-09-06",
        previous_start_date: "2026-07-09",
        previous_end_date: "2026-08-07",
        shops: [],
      }),
      fetchPlatform: async (spuId) => ({ spu_id: spuId, rows: [] }),
      fetchLink: async (spuId) => ({ spu_id: spuId, rows: [] }),
    });
    const output = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.deepEqual(output.prepare(
        "SELECT shop_id, biz_date FROM shop_daily_sales_analysis ORDER BY biz_date",
      ).all().map((row) => ({ ...row })), [
        { shop_id: "old-shop", biz_date: "2026-09-05" },
        { shop_id: "stale-shop", biz_date: "2026-09-06" },
      ]);
    } finally {
      output.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
