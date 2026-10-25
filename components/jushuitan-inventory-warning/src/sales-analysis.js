import { callListApi, PURCHASE_WARNING_CONTEXT } from "./api.js";

export const SALES_ANALYSIS_DETAIL_API = "purchase_goods_analysis_trend_detail";
export const SALES_ANALYSIS_TREND_API = "purchase_goods_analysis_trend_curve";
export const SALES_ANALYSIS_DIMENSIONS = Object.freeze(["platform", "channel", "link"]);
export const LINK_PAY_QUANTITY_WINDOWS = Object.freeze([
  [1, "pay_qty_today"],
  [3, "pay_qty_3d"],
  [7, "pay_qty_7d"],
  [15, "pay_qty_15d"],
  [30, "pay_qty_30d"],
]);

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("endDate must be YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || formatDate(date) !== value) {
    throw new Error("endDate must be a valid date");
  }
  return date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function yesterdayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return formatDate(addDays(parseDate(`${value.year}-${value.month}-${value.day}`), -1));
}

export function todayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function salesAnalysisDateRange({ days = 30, endDate = yesterdayShanghai() } = {}) {
  const end = parseDate(endDate);
  const start = addDays(end, 1 - days);
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, 1 - days);
  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
    preDate: formatDate(previousStart),
    preStartDate: formatDate(previousStart),
    preEndDate: formatDate(previousEnd),
  };
}

export function salesAnalysisParams({
  spuId,
  days = 30,
  endDate,
  page = 1,
  pageSize = 100,
  countType = "channel",
}) {
  if (!SALES_ANALYSIS_DIMENSIONS.includes(countType)) {
    throw new Error(`countType must be one of: ${SALES_ANALYSIS_DIMENSIONS.join(", ")}`);
  }
  return {
    countType,
    ...salesAnalysisDateRange({ days, ...(endDate ? { endDate } : {}) }),
    pageNum: page,
    pageSize,
    queryType: "spu",
    sortMap: { order_item_qty: "DESC" },
    spuId: String(spuId),
  };
}

export function dailySalesAnalysisParams({ spuId, days = 30, endDate }) {
  return {
    ...salesAnalysisDateRange({ days, ...(endDate ? { endDate } : {}) }),
    queryType: "spu",
    spuId: String(spuId),
  };
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function enrichShopSalesAnalysis(row) {
  return {
    ...row,
    sales_qty: numberOrNull(row.order_item_qty),
    sales_increase: numberOrNull(row.order_item_qty_increase),
    sales_chain_ratio: numberOrNull(row.order_item_qty_chain),
    sales_amount: numberOrNull(row.order_amt),
    sales_amount_increase: numberOrNull(row.order_amt_increase),
    sales_amount_chain_ratio: numberOrNull(row.order_amt_chain),
    order_count: numberOrNull(row.order_cnt),
    order_count_increase: numberOrNull(row.order_cnt_increase),
    order_count_chain_ratio: numberOrNull(row.order_cnt_chain),
    paid_return_qty: numberOrNull(row.afs_return_refund_qty),
    paid_return_qty_180d: numberOrNull(row.afs_return_refund_qty_180d),
    // The popup labels this shop-row field as "近180天退货件数".
    return_item_qty_180d: numberOrNull(row.afs_return_refund_qty_180d),
    shipped_qty_180d: numberOrNull(row.inout_sent_item_qty_180d),
    paid_return_chain_ratio: numberOrNull(row.afs_return_refund_qty_chain),
  };
}

export function enrichDailySalesAnalysis(row) {
  return {
    ...row,
    biz_date: String(row.biz_date ?? ""),
    sales_qty: number(row.order_item_qty),
    sales_amount: number(row.order_amt),
    order_count: number(row.order_cnt),
    net_sales_amount: number(row.net_order_amt),
  };
}

export function enrichShopDailySalesAnalysis(row, bizDate) {
  return {
    ...row,
    shop_id: String(row.shop_id ?? ""),
    biz_date: bizDate,
    sales_qty: number(row.order_item_qty),
    sales_amount: number(row.order_amt),
    order_count: number(row.order_cnt),
    // This is the paid-return quantity returned on the same shop-grain row.
    return_item_qty: numberOrNull(row.afs_return_refund_qty),
  };
}

export async function listDailySalesAnalysis({
  session,
  spuId,
  days = 30,
  endDate,
  fetchTrend,
}) {
  const params = dailySalesAnalysisParams({ spuId, days, endDate });
  const payload = fetchTrend
    ? await fetchTrend(params)
    : await callListApi(
      session,
      SALES_ANALYSIS_TREND_API,
      params,
      {},
      PURCHASE_WARNING_CONTEXT,
    );
  return {
    spu_id: String(spuId),
    days,
    start_date: params.startDate,
    end_date: params.endDate,
    daily: (payload.data ?? []).map(enrichDailySalesAnalysis).filter((row) => row.biz_date),
  };
}

export async function listShopSalesAnalysis({
  session,
  spuId,
  days = 30,
  endDate,
  page = 1,
  pageSize = 100,
  fetchPage,
}) {
  return listSalesAnalysisDimension({
    session,
    spuId,
    days,
    endDate,
    page,
    pageSize,
    countType: "channel",
    fetchPage,
  });
}

export async function listSalesAnalysisDimension({
  session,
  spuId,
  days = 30,
  endDate,
  page = 1,
  pageSize = 100,
  countType = "channel",
  fetchPage,
}) {
  const params = salesAnalysisParams({ spuId, days, endDate, page, pageSize, countType });
  const payload = fetchPage
    ? await fetchPage(params)
    : await callListApi(
      session,
      SALES_ANALYSIS_DETAIL_API,
      params,
      { customColumnTableCode: `procurement_rt_warning_table_${countType}` },
      PURCHASE_WARNING_CONTEXT,
    );
  return {
    spu_id: String(spuId),
    dimension: countType,
    days,
    start_date: params.startDate,
    end_date: params.endDate,
    previous_start_date: params.preStartDate,
    previous_end_date: params.preEndDate,
    page,
    page_size: pageSize,
    total: Number(payload.total ?? 0),
    rows: (payload.data ?? []).map(enrichShopSalesAnalysis),
    // Preserve the established channel result contract for existing consumers.
    ...(countType === "channel"
      ? { shops: (payload.data ?? []).map(enrichShopSalesAnalysis) }
      : {}),
  };
}

export async function getAllShopSalesAnalysis({
  session,
  spuId,
  days = 30,
  endDate,
  pageSize = 100,
  fetchPage,
}) {
  const result = await getAllSalesAnalysisDimension({
    session,
    spuId,
    days,
    endDate,
    pageSize,
    countType: "channel",
    ...(fetchPage ? { fetchPage } : {}),
  });
  const { rows, ...metadata } = result;
  return { ...metadata, shops: rows };
}

export async function getAllSalesAnalysisDimension({
  session,
  spuId,
  days = 30,
  endDate,
  pageSize = 100,
  countType = "channel",
  fetchPage,
}) {
  const request = (page) => listSalesAnalysisDimension({
    session,
    spuId,
    days,
    endDate,
    page,
    pageSize,
    countType,
    ...(fetchPage ? { fetchPage } : {}),
  });
  const first = await request(1);
  const pages = Math.max(1, Math.ceil(first.total / pageSize));
  const rows = [...first.rows];
  for (let page = 2; page <= pages; page += 1) {
    rows.push(...(await request(page)).rows);
  }
  const { page: _page, shops: _shops, rows: _rows, ...metadata } = first;
  return { ...metadata, page_size: pageSize, pages, rows };
}

async function getAllLinkWindowPayQuantities({
  session,
  spuId,
  endDate = todayShanghai(),
  pageSize = 100,
  fetchDimension = getAllSalesAnalysisDimension,
}) {
  const rows = new Map();
  // The link tab exposes one selected date range at a time. Query the same five
  // ranges a user can select, sequentially, and copy the returned quantity.
  // No quantities are summed, averaged, or inferred locally.
  for (const [days, column] of LINK_PAY_QUANTITY_WINDOWS) {
    const result = await fetchDimension({
      session,
      spuId,
      days,
      endDate,
      pageSize,
      countType: "link",
    });
    for (const row of result.rows) {
      const identity = {
        shop_id: String(row.shop_id ?? ""),
        shop_spu_id: String(row.shop_spu_id ?? ""),
      };
      if (Object.values(identity).some((value) => !value)) continue;
      const key = `${identity.shop_id}\u0000${identity.shop_spu_id}`;
      rows.set(key, {
        ...(rows.get(key) ?? identity),
        [column]: row.sales_qty,
      });
    }
  }
  return { spu_id: String(spuId), end_date: endDate, rows: [...rows.values()] };
}

export function getAllLinkPayQuantities(options) {
  return getAllLinkWindowPayQuantities(options);
}

export async function listShopDailySalesAnalysis({
  session,
  spuId,
  bizDate = yesterdayShanghai(),
  pageSize = 100,
  fetchPage,
}) {
  const result = await getAllShopSalesAnalysis({
    session,
    spuId,
    days: 1,
    endDate: bizDate,
    pageSize,
    ...(fetchPage ? { fetchPage } : {}),
  });
  return {
    spu_id: String(spuId),
    biz_date: bizDate,
    page_size: result.page_size,
    pages: result.pages,
    total: result.total,
    shops: result.shops
      .map((row) => enrichShopDailySalesAnalysis(row, bizDate))
      .filter((row) => row.shop_id),
  };
}
