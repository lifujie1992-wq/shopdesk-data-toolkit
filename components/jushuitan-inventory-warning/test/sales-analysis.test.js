import assert from "node:assert/strict";
import test from "node:test";

import {
  dailySalesAnalysisParams,
  enrichDailySalesAnalysis,
  enrichShopSalesAnalysis,
  enrichShopDailySalesAnalysis,
  getAllLinkPayQuantities,
  getAllSalesAnalysisDimension,
  getAllShopSalesAnalysis,
  listDailySalesAnalysis,
  listSalesAnalysisDimension,
  listShopSalesAnalysis,
  listShopDailySalesAnalysis,
  salesAnalysisDateRange,
  salesAnalysisParams,
  todayShanghai,
  yesterdayShanghai,
} from "../src/sales-analysis.js";

test("builds current and immediately preceding analysis periods", () => {
  assert.deepEqual(salesAnalysisDateRange({ days: 30, endDate: "2026-09-06" }), {
    startDate: "2026-08-08",
    endDate: "2026-09-06",
    preDate: "2026-07-09",
    preStartDate: "2026-07-09",
    preEndDate: "2026-08-07",
  });
  assert.equal(yesterdayShanghai(new Date("2026-09-07T00:30:00Z")), "2026-09-06");
  assert.equal(todayShanghai(new Date("2026-09-06T16:30:00Z")), "2026-09-07");
});

test("collects real link-grain quantities for every fixed window", async () => {
  const requested = [];
  const result = await getAllLinkPayQuantities({
    session: {},
    spuId: "61427",
    endDate: "2026-09-07",
    fetchDimension: async ({ days, endDate, countType }) => {
      requested.push({ days, endDate, countType });
      return {
        rows: [{ shop_id: 9, shop_spu_id: "link-1", sales_qty: days * 2 }],
      };
    },
  });
  assert.deepEqual(requested.map((item) => item.days), [1, 3, 7, 15, 30]);
  assert.ok(requested.every((item) => (
    item.endDate === "2026-09-07" && item.countType === "link"
  )));
  assert.deepEqual(result.rows, [{
    shop_id: "9",
    shop_spu_id: "link-1",
    pay_qty_today: 2,
    pay_qty_3d: 6,
    pay_qty_7d: 14,
    pay_qty_15d: 30,
    pay_qty_30d: 60,
  }]);
});

test("reads every shop page for one SPU", async () => {
  const pages = [];
  const result = await getAllShopSalesAnalysis({
    session: {},
    spuId: "4241",
    endDate: "2026-09-06",
    pageSize: 100,
    fetchPage: async (params) => {
      pages.push(params.pageNum);
      return {
        total: 101,
        data: [{ shop_id: `shop-${params.pageNum}`, order_item_qty: params.pageNum }],
      };
    },
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.pages, 2);
  assert.equal(result.shops.length, 2);
});

test("reads every page for each drawer dimension", async () => {
  const pages = [];
  const result = await getAllSalesAnalysisDimension({
    session: {},
    spuId: "61427",
    endDate: "2026-09-07",
    pageSize: 2,
    countType: "link",
    fetchPage: async (params) => {
      pages.push(params.pageNum);
      return {
        total: 3,
        data: [{ shop_spu_id: `link-${params.pageNum}`, order_item_qty: params.pageNum }],
      };
    },
  });
  assert.deepEqual(pages, [1, 2]);
  assert.equal(result.dimension, "link");
  assert.equal(result.pages, 2);
  assert.deepEqual(result.rows.map((row) => row.shop_spu_id), ["link-1", "link-2"]);
});

test("builds the verified shop-dimension request", () => {
  assert.deepEqual(salesAnalysisParams({
    spuId: "4241",
    days: 7,
    endDate: "2026-09-06",
    page: 2,
    pageSize: 50,
  }), {
    countType: "channel",
    startDate: "2026-08-31",
    endDate: "2026-09-06",
    preDate: "2026-08-24",
    preStartDate: "2026-08-24",
    preEndDate: "2026-08-30",
    pageNum: 2,
    pageSize: 50,
    queryType: "spu",
    sortMap: { order_item_qty: "DESC" },
    spuId: "4241",
  });
});

test("builds each sales-analysis drawer dimension request", async () => {
  for (const countType of ["platform", "channel", "link"]) {
    let request;
    const result = await listSalesAnalysisDimension({
      session: {},
      spuId: "61427",
      days: 7,
      endDate: "2026-09-07",
      countType,
      fetchPage: async (params) => {
        request = params;
        return { total: 1, data: [{ order_item_qty: 2 }] };
      },
    });
    assert.equal(request.countType, countType);
    assert.equal(request.queryType, "spu");
    assert.equal(request.spuId, "61427");
    assert.deepEqual(request.sortMap, { order_item_qty: "DESC" });
    assert.equal(result.dimension, countType);
    assert.equal(result.rows[0].sales_qty, 2);
    assert.equal(Object.hasOwn(result, "shops"), countType === "channel");
  }
});

test("rejects an unknown sales-analysis drawer dimension", () => {
  assert.throws(
    () => salesAnalysisParams({ spuId: "1", countType: "unknown" }),
    /countType must be one of/,
  );
});

test("builds the verified daily trend request", () => {
  assert.deepEqual(dailySalesAnalysisParams({
    spuId: "4241",
    days: 7,
    endDate: "2026-09-06",
  }), {
    startDate: "2026-08-31",
    endDate: "2026-09-06",
    preDate: "2026-08-24",
    preStartDate: "2026-08-24",
    preEndDate: "2026-08-30",
    queryType: "spu",
    spuId: "4241",
  });
});

test("copies sales and comparison fields without deriving values", () => {
  const row = enrichShopSalesAnalysis({
    shop_id: 1,
    order_item_qty: 2259,
    order_item_qty_increase: 1267,
    order_item_qty_chain: 1.2772,
    order_amt: 1500,
    order_amt_increase: 300,
    order_amt_chain: 0.25,
    order_cnt: 100,
    order_cnt_increase: 20,
    order_cnt_chain: 0.25,
    afs_return_refund_qty: 1344,
    afs_return_refund_qty_180d: 1600,
    inout_sent_item_qty_180d: 2000,
    afs_return_refund_qty_chain: 3.1869,
  });
  assert.equal(row.sales_qty, 2259);
  assert.equal(row.sales_increase, 1267);
  assert.equal(row.previous_sales_qty, undefined);
  assert.equal(row.sales_chain_ratio, 1.2772);
  assert.equal(row.sales_chain_percent, undefined);
  assert.equal(row.previous_sales_amount, undefined);
  assert.equal(row.sales_amount_chain_ratio, 0.25);
  assert.equal(row.previous_order_count, undefined);
  assert.equal(row.order_count_chain_ratio, 0.25);
  assert.equal(row.paid_return_qty, 1344);
  assert.equal(row.paid_return_qty_180d, 1600);
  assert.equal(row.return_item_qty_180d, 1600);
  assert.equal(row.shipped_qty_180d, 2000);
  assert.equal(row.paid_return_chain_ratio, 3.1869);
  assert.equal(row.paid_return_chain_percent, undefined);
  assert.equal(enrichShopSalesAnalysis({
    order_item_qty: 10,
    order_item_qty_increase: 10,
  }).sales_chain_ratio, null);
  assert.equal(enrichShopSalesAnalysis({
    order_item_qty: 10,
    order_item_qty_increase: 2,
  }).sales_chain_ratio, null);
  assert.equal(enrichShopSalesAnalysis({
    afs_return_refund_qty_180d: 12,
  }).return_item_qty_180d, 12);
});

test("maps one-day shop rows without product-level allocation", async () => {
  assert.deepEqual(enrichShopDailySalesAnalysis({
    shop_id: 9,
    order_item_qty: "12",
    order_amt: "345.67",
    order_cnt: "8",
    afs_return_refund_qty: "3",
  }, "2026-09-06"), {
    shop_id: "9",
    biz_date: "2026-09-06",
    order_item_qty: "12",
    order_amt: "345.67",
    order_cnt: "8",
    afs_return_refund_qty: "3",
    sales_qty: 12,
    sales_amount: 345.67,
    order_count: 8,
    return_item_qty: 3,
  });

  let request;
  const result = await listShopDailySalesAnalysis({
    session: {},
    spuId: "4241",
    bizDate: "2026-09-06",
    fetchPage: async (params) => {
      request = params;
      return { total: 1, data: [{ shop_id: 9, afs_return_refund_qty: 3 }] };
    },
  });
  assert.equal(request.startDate, "2026-09-06");
  assert.equal(request.endDate, "2026-09-06");
  assert.equal(request.countType, "channel");
  assert.equal(result.shops[0].return_item_qty, 3);
});

test("lists enriched shop rows", async () => {
  const result = await listShopSalesAnalysis({
    session: {},
    spuId: "4241",
    endDate: "2026-09-06",
    fetchPage: async () => ({
      total: 1,
      data: [{ shop_id: 1, order_item_qty: 10, order_item_qty_increase: 2 }],
    }),
  });
  assert.equal(result.total, 1);
  assert.equal(result.shops[0].sales_qty, 10);
  assert.equal(result.shops[0].sales_increase, 2);
  assert.equal(result.shops[0].previous_sales_qty, undefined);
  assert.equal(result.shops[0].sales_chain_percent, undefined);
});

test("maps and lists daily sales metrics returned by the trend API", async () => {
  assert.deepEqual(enrichDailySalesAnalysis({
    biz_date: "2026-09-06",
    order_item_qty: "12",
    order_amt: "345.67",
    order_cnt: "8",
    net_order_amt: "300.12",
  }), {
    biz_date: "2026-09-06",
    order_item_qty: "12",
    order_amt: "345.67",
    order_cnt: "8",
    net_order_amt: "300.12",
    sales_qty: 12,
    sales_amount: 345.67,
    order_count: 8,
    net_sales_amount: 300.12,
  });

  let request;
  const result = await listDailySalesAnalysis({
    session: {},
    spuId: "4241",
    days: 7,
    endDate: "2026-09-06",
    fetchTrend: async (params) => {
      request = params;
      return { data: [{ biz_date: "2026-09-06", order_item_qty: 12 }] };
    },
  });
  assert.equal(request.queryType, "spu");
  assert.equal(result.daily[0].sales_qty, 12);
  assert.equal(result.start_date, "2026-08-31");
});
