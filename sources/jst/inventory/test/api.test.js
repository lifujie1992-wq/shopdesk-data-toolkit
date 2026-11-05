import assert from "node:assert/strict";
import test from "node:test";

import {
  callListApi,
  detailParams,
  parseChildren,
  requestBody,
  SHOP_SHORTAGE_CONTEXT,
  shopShortageParams,
  spuLiveParams,
  summaryParams,
} from "../src/api.js";
import { listSaleChannel, saleChannelParams } from "../src/api.js";

const SESSION = { cookies: [
  { name: "u_sso_token", value: "test-token" },
  { name: "u_id", value: "1" },
  { name: "u_co_id", value: "2" },
] };

test("builds verified detail pagination parameters", () => {
  const params = detailParams(2, 25);
  assert.equal(params.pageNum, 2);
  assert.equal(params.pageSize, 25);
  assert.deepEqual(params.sortMap, { advice_purchase_qty: "DESC" });
  assert.equal(params.viewType, "spu");
});

test("builds stable SPU live pagination parameters", () => {
  const params = spuLiveParams(3, 100);
  assert.equal(params.pageNum, 3);
  assert.equal(params.pageSize, 100);
  assert.equal(params.viewType, "spu");
  assert.deepEqual(params.sortMap, { spu_id: "ASC" });
});

test("builds today's sales channel popup parameters for both grains", async () => {
  assert.deepEqual(saleChannelParams({ spuId: 61427, countType: "platform", page: 2, pageSize: 20 }), {
    countType: "platform", queryType: "spu", spuId: "61427", pageNum: 2, pageSize: 20,
  });
  const result = await listSaleChannel({
    skuId: "66353-L", countType: "channel", shopIds: [1], disCoIds: [2],
    fetchPage: async params => ({ total: 1, data: [{ shop_name: "店铺", pay_qty_today: 3, pay_qty_30d: 10, params }] }),
  });
  assert.equal(result.dimension, "channel");
  assert.equal(result.query_type, "sku");
  assert.equal(result.rows[0].pay_qty_today, 3);
  assert.deepEqual(result.rows[0].params.disCoIds, [2]);
});

test("builds verified summary thresholds", () => {
  const params = summaryParams();
  assert.equal(params.stockoutHotAvgQty, 50);
  assert.equal(params.lowInventoryAvailableDaysTo, 5);
  assert.equal(params.noPayQtyType, "no_pay_qty_90d");
});

test("parses nested SKU JSON without mutating malformed data", () => {
  const rows = parseChildren([
    { spu_id: "a", children: '[{"sku_id":"b"}]' },
    { spu_id: "c", children: "not-json" },
  ]);
  assert.deepEqual(rows[0].children, [{ sku_id: "b" }]);
  assert.equal(rows[1].children, "not-json");
});

test("builds shop shortage pagination and request context", () => {
  const params = shopShortageParams(3, 50);
  assert.deepEqual(params, {
    cardType: "lackSku",
    sortMap: { no_sent_pay_amt: "DESC" },
    childrenSortMap: { no_sent_pay_amt: "DESC" },
    pageSize: 50,
    pageNum: 3,
  });
  const body = requestBody("stock_out_shop_spu_alarm_list", params, {}, SHOP_SHORTAGE_CONTEXT);
  assert.equal(body.data.bizDomain, "stockOutAlarm");
  assert.equal(body.data.pageCode, "STOCK_OUT_ALARM");
});

test("does not repeat a request when the page payload is invalid", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ code: 0, success: true, data: "busy" }),
    };
  });
  await assert.rejects(callListApi(SESSION, "test_list", {}), /non-array page payload/);
  assert.equal(calls, 1);
});
