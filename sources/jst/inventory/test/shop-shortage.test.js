import assert from "node:assert/strict";
import test from "node:test";

import {
  addShopShortageRows,
  enrichShopShortageRows,
  finalizeShopShortageSummary,
  getShopShortageSummary,
  shopStockoutQty,
  shopUrgentStockoutQty,
} from "../src/shop-shortage.js";

const rowA = {
  shop_id: 10,
  shop_name: "店铺 A",
  platform: "抖音",
  shop_spu_id: "link-a",
  no_sent_qty: 12,
  timeout_qty: 2,
  will_timeout_qty_1d: 3,
  present_stock_out_qty: 1,
  insent_no_present_stock_out_qty: 2,
  presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout: 4,
};

test("derives shop shortage and urgent quantities from verified fields", () => {
  assert.equal(shopStockoutQty(rowA), 7);
  assert.equal(shopUrgentStockoutQty(rowA), 5);
  assert.equal(shopStockoutQty({ stockout_qty: 9 }), 9);
  assert.equal(shopStockoutQty({ available_qty: -8 }), 8);
});

test("enriches JSON children and aggregates links by shop", () => {
  const rows = enrichShopShortageRows([{
    ...rowA,
    children: JSON.stringify([{ stockout_qty: 5, timeout_qty: 1, will_timeout_qty_1d: 2 }]),
  }]);
  assert.equal(rows[0].shop_stockout_qty, 7);
  assert.equal(rows[0].children[0].shop_urgent_stockout_qty, 3);

  const map = addShopShortageRows(new Map(), [
    rowA,
    { ...rowA, shop_spu_id: "link-b", no_sent_qty: 8, timeout_qty: 1 },
    { ...rowA, shop_id: 20, shop_name: "店铺 B", no_sent_qty: 4 },
  ]);
  const result = finalizeShopShortageSummary(map);
  assert.equal(result.totals.shop_count, 2);
  assert.equal(result.totals.link_count, 3);
  assert.equal(result.totals.shop_no_sent_qty, 24);
  assert.equal(result.shops.find((shop) => shop.shop_id === "10").shop_urgent_stockout_qty, 9);
});

test("fetches all pages before returning shop summary", async () => {
  const pages = new Map([
    [1, { total: 3, data: [rowA, { ...rowA, shop_spu_id: "link-b" }] }],
    [2, { total: 3, data: [{ ...rowA, shop_id: 20, shop_spu_id: "link-c" }] }],
  ]);
  const result = await getShopShortageSummary({
    session: {},
    pageSize: 2,
    concurrency: 2,
    fetchPage: async (page) => pages.get(page),
  });
  assert.equal(result.pages, 2);
  assert.equal(result.total_links, 3);
  assert.equal(result.totals.shop_count, 2);
});
