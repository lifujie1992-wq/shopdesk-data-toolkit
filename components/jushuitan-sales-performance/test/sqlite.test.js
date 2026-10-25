import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizeSalesRow } from "../src/report.js";
import { readSalesSummary, writeSalesSnapshot } from "../src/sqlite.js";

test("replaces the same report date and exposes Chinese headers", () => {
  const directory = mkdtempSync(join(tmpdir(), "jst-sales-test-"));
  const outputPath = join(directory, "sales.sqlite");
  try {
    const makeRow = (amount) => normalizeSalesRow("2026-09-05", {
      channel_id: 1,
      channel_name: "测试店",
      net_order_amt: amount,
    }, new Date().toISOString());
    writeSalesSnapshot({
      outputPath,
      reportDate: "2026-09-05",
      rows: [makeRow(10)],
      sourceTotal: 1,
      startedAt: new Date(),
    });
    writeSalesSnapshot({
      outputPath,
      reportDate: "2026-09-05",
      rows: [makeRow(20)],
      sourceTotal: 1,
      startedAt: new Date(),
    });
    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sales_performance").get().count, 1);
      assert.equal(db.prepare("SELECT `净销售收入(元)` AS amount FROM `销售业绩报告`").get().amount, 20);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sync_runs").get().count, 2);
    } finally {
      db.close();
    }
    assert.equal(readSalesSummary(outputPath, "2026-09-05").net_sales_income, 20);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
