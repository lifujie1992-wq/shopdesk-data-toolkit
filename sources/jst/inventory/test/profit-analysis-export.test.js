import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  defaultProfitDateRange,
  crawlProfitFocusOrders,
  exportProfitAnalysisXlsx,
  PROFIT_ANALYSIS_COLUMNS,
  profitAnalysisParams,
  profitStateLabel,
} from "../src/profit-analysis-export.js";

const session = { cookies: [
  { name: "u_sso_token", value: "secret" }, { name: "u_id", value: "1" },
  { name: "u_co_id", value: "2" },
] };

test("profit range includes the matching prior period", () => {
  assert.deepEqual(defaultProfitDateRange(new Date("2026-09-10T04:00:00Z")), {
    startDate: "2026-09-03", endDate: "2026-09-09",
  });
  const params = profitAnalysisParams("2026-09-03", "2026-09-09");
  assert.equal(params.periodDays, 7);
  assert.equal(params.preStartDate, "2026-08-27");
  assert.equal(params.preEndDate, "2026-09-02");
  assert.equal(PROFIT_ANALYSIS_COLUMNS.length, 54);
});

test("maps page change descriptions to their visible state labels", () => {
  assert.equal(profitStateLabel("盈利增长"), "持续盈利");
  assert.equal(profitStateLabel("盈利缩小"), "持续盈利");
  assert.equal(profitStateLabel("亏损扩大"), "持续亏损");
  assert.equal(profitStateLabel("亏损缩小"), "持续亏损");
  assert.equal(profitStateLabel("亏转盈"), "亏转盈");
  assert.equal(profitStateLabel(""), null);
});

test("focus-order crawl covers every SKU and zero-fills omitted zero rows", async () => {
  const root = mkdtempSync(join(tmpdir(), "jst-profit-focus-"));
  const output = join(root, "focus.json");
  const skuRows = Array.from({ length: 3 }, (_, index) => ({ sku_id: `sku-${index + 1}` }));
  const fetchPage = async (code) => code === "profit_analysis_sku_list"
    ? { total: 3, data: skuRows }
    : { data: [
      { sku_id: "sku-1", high_profit_cnt: 8, high_gross_profit_cnt: 9,
        loss_profit_cnt: 3, loss_gross_profit_cnt: 4, loss_sku_amt_cnt: 2, loss_freight_amt_cnt: 7 },
      { sku_id: "sku-3", loss_sku_amt_cnt: 1, loss_freight_amt_cnt: 4 },
    ] };
  const result = await crawlProfitFocusOrders({
    session, startDate: "2026-09-03", endDate: "2026-09-09", outputPath: output,
    batchSize: 3, fetchPage, requestIntervalMs: 0,
  });
  assert.equal(result.row_count, 3);
  const payload = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(payload.format_version, 2);
  assert.deepEqual(payload.rows, [
    { sku_id: "sku-1", high_profit_order_count: 8, high_gross_profit_order_count: 9,
      negative_profit_order_count: 3, negative_gross_profit_order_count: 4,
      product_loss_order_count: 2, freight_loss_order_count: 7,
      profit_status_label: null, profit_change_label: null,
      gross_profit_status_label: null, gross_profit_change_label: null, raw: skuRows[0] },
    { sku_id: "sku-2", high_profit_order_count: 0, high_gross_profit_order_count: 0,
      negative_profit_order_count: 0, negative_gross_profit_order_count: 0,
      product_loss_order_count: 0, freight_loss_order_count: 0,
      profit_status_label: null, profit_change_label: null,
      gross_profit_status_label: null, gross_profit_change_label: null, raw: skuRows[1] },
    { sku_id: "sku-3", high_profit_order_count: 0, high_gross_profit_order_count: 0,
      negative_profit_order_count: 0, negative_gross_profit_order_count: 0,
      product_loss_order_count: 1, freight_loss_order_count: 4,
      profit_status_label: null, profit_change_label: null,
      gross_profit_status_label: null, gross_profit_change_label: null, raw: skuRows[2] },
  ]);
});

test("async export is polled and downloaded atomically", async () => {
  const root = mkdtempSync(join(tmpdir(), "jst-profit-"));
  const output = join(root, "profit.xlsx");
  const calls = [];
  const response = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, success: true, data }) });
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/exportExcel")) return response({ id: 99, status: 0 });
    if (url.endsWith("/queryExportResult")) return response([{ id: 99, status: 1, url: "https://download.test/file", total: 2, fileName: "利润.xlsx" }]);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from("PK-test") };
  };
  const result = await exportProfitAnalysisXlsx({ session, outputPath: output,
    startDate: "2026-09-03", endDate: "2026-09-09", fetchImpl, pollIntervalMs: 1 });
  assert.equal(result.row_count, 2);
  assert.equal(readFileSync(output).toString(), "PK-test");
  const submitted = JSON.parse(calls[0].options.body).data;
  assert.equal(submitted.apiCode, "profit_analysis_sku_list");
  assert.equal(submitted.orderColumns.length, 54);
});
