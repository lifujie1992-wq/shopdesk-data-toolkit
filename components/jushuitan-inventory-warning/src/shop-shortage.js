import {
  callListApi,
  parseChildren,
  SHOP_SHORTAGE_CONTEXT,
  shopShortageParams,
} from "./api.js";

export const SHOP_SHORTAGE_LIST_API = "stock_out_shop_spu_alarm_list";

const STOCKOUT_COMPONENT_FIELDS = [
  "present_stock_out_qty",
  "insent_no_present_stock_out_qty",
  "presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout",
];

function numericValue(row, name) {
  const number = Number(row?.[name]);
  return Number.isFinite(number) ? number : 0;
}

export function shopStockoutQty(row) {
  const hasComponents = STOCKOUT_COMPONENT_FIELDS.some((name) => row?.[name] != null);
  if (hasComponents) {
    return STOCKOUT_COMPONENT_FIELDS.reduce((total, name) => total + numericValue(row, name), 0);
  }
  if (row?.stockout_qty != null) return numericValue(row, "stockout_qty");
  return Math.max(0, -numericValue(row, "available_qty"));
}

export function shopUrgentStockoutQty(row) {
  return numericValue(row, "timeout_qty") + numericValue(row, "will_timeout_qty_1d");
}

export function enrichShopShortageRow(row) {
  return {
    ...row,
    shop_stockout_qty: shopStockoutQty(row),
    shop_urgent_stockout_qty: shopUrgentStockoutQty(row),
    shop_no_sent_qty: numericValue(row, "no_sent_qty"),
  };
}

export function enrichShopShortageRows(rows) {
  return parseChildren(rows).map((row) => ({
    ...enrichShopShortageRow(row),
    children: Array.isArray(row.children)
      ? row.children.map(enrichShopShortageRow)
      : row.children,
  }));
}

export function addShopShortageRows(shopMap, rows) {
  for (const row of rows) {
    const shopId = String(row.shop_id ?? row.child_shop_id ?? "");
    if (!shopId) continue;
    const current = shopMap.get(shopId) ?? {
      shop_id: shopId,
      shop_name: row.shop_name ?? null,
      platform: row.platform ?? null,
      shop_type: row.shop_type ?? null,
      link_count: 0,
      shop_stockout_qty: 0,
      shop_urgent_stockout_qty: 0,
      shop_no_sent_qty: 0,
      timeout_qty: 0,
      due_within_1d_qty: 0,
    };
    current.link_count += 1;
    current.shop_stockout_qty += shopStockoutQty(row);
    current.shop_urgent_stockout_qty += shopUrgentStockoutQty(row);
    current.shop_no_sent_qty += numericValue(row, "no_sent_qty");
    current.timeout_qty += numericValue(row, "timeout_qty");
    current.due_within_1d_qty += numericValue(row, "will_timeout_qty_1d");
    shopMap.set(shopId, current);
  }
  return shopMap;
}

export function finalizeShopShortageSummary(shopMap) {
  const shops = [...shopMap.values()].sort(
    (left, right) => right.shop_stockout_qty - left.shop_stockout_qty,
  );
  const totals = shops.reduce((result, shop) => {
    result.link_count += shop.link_count;
    result.shop_stockout_qty += shop.shop_stockout_qty;
    result.shop_urgent_stockout_qty += shop.shop_urgent_stockout_qty;
    result.shop_no_sent_qty += shop.shop_no_sent_qty;
    return result;
  }, {
    shop_count: shops.length,
    link_count: 0,
    shop_stockout_qty: 0,
    shop_urgent_stockout_qty: 0,
    shop_no_sent_qty: 0,
  });
  return { totals, shops };
}

export function fetchShopShortagePage(session, page, pageSize) {
  return callListApi(
    session,
    SHOP_SHORTAGE_LIST_API,
    shopShortageParams(page, pageSize),
    {},
    SHOP_SHORTAGE_CONTEXT,
  );
}

export async function getShopShortageSummary({
  session,
  pageSize = 100,
  concurrency = 4,
  fetchPage = (page) => fetchShopShortagePage(session, page, pageSize),
  onPage = () => {},
}) {
  const first = await fetchPage(1);
  const totalLinks = Number(first.total ?? 0);
  const pages = Math.max(1, Math.ceil(totalLinks / pageSize));
  const shopMap = addShopShortageRows(new Map(), first.data ?? []);
  onPage(first.data ?? [], 1, pages);

  for (let firstPage = 2; firstPage <= pages; firstPage += concurrency) {
    const pageNumbers = Array.from(
      { length: Math.min(concurrency, pages - firstPage + 1) },
      (_, index) => firstPage + index,
    );
    const payloads = await Promise.all(pageNumbers.map((page) => fetchPage(page)));
    payloads.forEach((payload, index) => {
      addShopShortageRows(shopMap, payload.data ?? []);
      onPage(payload.data ?? [], pageNumbers[index], pages);
    });
  }

  return {
    total_links: totalLinks,
    pages,
    page_size: pageSize,
    ...finalizeShopShortageSummary(shopMap),
  };
}
