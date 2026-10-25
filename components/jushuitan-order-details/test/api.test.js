import assert from "node:assert/strict";
import test from "node:test";

import { dateRange, orderDimension, yesterdayShanghai } from "../src/api.js";

test("describes both order report tabs", () => {
  assert.deepEqual(orderDimension("order"), {
    name: "order",
    detailApi: "sales_theme_order_list",
    summaryApi: "sales_theme_order_list_sum",
    tableCode: "sales_theme_analysis_order_by_order_table",
  });
  assert.deepEqual(orderDimension("item"), {
    name: "item",
    detailApi: "sales_theme_order_item_list",
    summaryApi: "sales_theme_order_item_list_sum",
    tableCode: "sales_theme_analysis_order_by_shop_table",
  });
  assert.throws(() => orderDimension("unknown"), /order or item/);
});

test("builds an inclusive 30-day range", () => {
  assert.deepEqual(dateRange(30, "2026-09-05"), {
    days: 30,
    start_date: "2026-08-07",
    end_date: "2026-09-05",
    startDateTime: "2026-08-07 00:00:00",
    endDateTime: "2026-09-05 23:59:59",
  });
});

test("uses yesterday in Asia/Shanghai", () => {
  assert.equal(yesterdayShanghai(new Date("2026-09-06T02:00:00Z")), "2026-09-05");
});
