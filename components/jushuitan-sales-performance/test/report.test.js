import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSalesRow } from "../src/report.js";

test("normalizes original Feishu report fields", () => {
  const row = normalizeSalesRow("2026-09-05", {
    channel_id: 12,
    channel_name: "测试旗舰店（小赵）",
    platform: "测试平台",
    order_amt: "200.50",
    net_order_amt: "180",
    order_cnt: 2,
    order_sku_cost: 100,
    order_sku_profit: 50,
    net_order_amt_chain: 0.125,
    send_ratio_48hours: 0.9,
    afs_refund_amt: 10,
    pay_order_refund_amt: 5,
  }, "2026-09-06T00:00:00.000Z");
  assert.equal(row.shopId, "12");
  assert.equal(row.ownerName, "小赵");
  assert.equal(row.customerUnitPrice, 90);
  assert.equal(row.salesChainPercent, 12.5);
  assert.equal(row.sendRatio48h, 90);
  assert.equal(row.refundAmount, 15);
  assert.equal(row.markupMultiple, 2.01);
});
