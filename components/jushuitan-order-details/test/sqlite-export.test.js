import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { dateRange } from "../src/api.js";
import { exportOrdersToSqlite, readOrderSummary, readOrders } from "../src/sqlite-export.js";

test("exports pages, deduplicates order IDs, and restricts the database file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-orders-test-"));
  const outputPath = join(directory, "orders.sqlite");
  const pages = new Map([
    [1, { total: 3, data: [{ o_id: 3, shop_name: "A", order_amt: 30 }] }],
    [2, { total: 3, data: [{ o_id: 2, shop_name: "B", order_amt: 20 }] }],
    [3, { total: 3, data: [{ o_id: 2, shop_name: "B2", order_amt: 21 }] }],
  ]);
  try {
    const result = await exportOrdersToSqlite({
      session: {},
      range: dateRange(1, "2026-09-05"),
      outputPath,
      pageSize: 1,
      concurrency: 2,
      fetchPage: async (page) => pages.get(page),
      fetchSummary: async () => ({ data: [{ order_amt: 51 }] }),
    });
    assert.equal(result.fetched_rows, 3);
    assert.equal(result.saved_rows, 2);
    assert.equal(statSync(outputPath).mode & 0o777, 0o600);
    assert.equal(readOrders(outputPath, 10).length, 2);
    assert.deepEqual(readOrderSummary(outputPath).summary, [{ order_amt: 51 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("incremental export replaces the requested date and preserves older orders", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-orders-merge-test-"));
  const outputPath = join(directory, "orders.sqlite");
  try {
    await exportOrdersToSqlite({
      session: {},
      range: dateRange(2, "2026-09-05"),
      outputPath,
      fetchPage: async () => ({ total: 3, data: [
        { o_id: "old", send_date: "2026-09-04 12:00:00", order_amt: 10 },
        { o_id: "update", send_date: "2026-09-05 12:00:00", order_amt: 20 },
        { o_id: "removed", send_date: "2026-09-05 13:00:00", order_amt: 30 },
      ] }),
      fetchSummary: async () => ({ data: [] }),
    });
    const result = await exportOrdersToSqlite({
      session: {},
      range: dateRange(1, "2026-09-05"),
      outputPath,
      mergeFromPath: outputPath,
      fetchPage: async () => ({ total: 2, data: [
        { o_id: "update", send_date: "2026-09-05 12:00:00", order_amt: 25 },
        { o_id: "new", send_date: "2026-09-05 14:00:00", order_amt: 40 },
      ] }),
      fetchSummary: async () => ({ data: [] }),
    });
    assert.equal(result.incremental, true);
    assert.equal(result.preserved_rows, 1);
    assert.equal(result.saved_rows, 3);
    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT o_id, order_amt FROM order_details ORDER BY o_id").all()
        .map((row) => ({ ...row }));
      assert.deepEqual(rows, [
        { o_id: "new", order_amt: 40 },
        { o_id: "old", order_amt: 10 },
        { o_id: "update", order_amt: 25 },
      ]);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
