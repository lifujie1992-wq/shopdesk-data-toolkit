import { cookieHeader, cookieValue } from "./session.js";
import { CliError } from "./errors.js";

const API_ROOT = "https://api.erp321.com/jst-data-report/getData/transportData";
export const DEFAULT_PAGE_SIZE = 5000;

export const ORDER_DIMENSIONS = Object.freeze({
  order: Object.freeze({
    detailApi: "sales_theme_order_list",
    summaryApi: "sales_theme_order_list_sum",
    tableCode: "sales_theme_analysis_order_by_order_table",
  }),
  item: Object.freeze({
    detailApi: "sales_theme_order_item_list",
    summaryApi: "sales_theme_order_item_list_sum",
    tableCode: "sales_theme_analysis_order_by_shop_table",
  }),
});

export function orderDimension(value = "order") {
  const dimension = ORDER_DIMENSIONS[value];
  if (!dimension) throw new CliError("invalid_dimension", "dimension must be order or item.");
  return { name: value, ...dimension };
}

export function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CliError("invalid_date", "Date must use YYYY-MM-DD format.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.toISOString().slice(0, 10) !== value) {
    throw new CliError("invalid_date", "Date is not a valid calendar date.");
  }
  return value;
}

export function yesterdayShanghai(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now.getTime() - 86_400_000));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dateRange(days = 30, endDate = yesterdayShanghai()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new CliError("invalid_days", "--days must be 1-366.");
  }
  assertDate(endDate);
  const [year, month, day] = endDate.split("-").map(Number);
  const startDate = new Date(Date.UTC(year, month - 1, day - days + 1)).toISOString().slice(0, 10);
  return {
    days,
    start_date: startDate,
    end_date: endDate,
    startDateTime: `${startDate} 00:00:00`,
    endDateTime: `${endDate} 23:59:59`,
  };
}

function baseParams(range) {
  return {
    dateType: "send_date",
    skuType: 0,
    iIdType: 0,
    skuLabelsFilterType: 1,
    isSplit: 1,
    isEntity: 0,
    costType: 0,
    isExcludeUnfinishedOrders: 1,
    orderStatus: ["SENT"],
    orderLabelsType: 1,
    orderLabels: ["特殊单", "统计排除标"],
    sellerFlagType: 0,
    orderType: 1,
    orderTypes: ["换货订单"],
    nodeType: null,
    buyerMessageType: null,
    remarkType: null,
    startDate: range.startDateTime,
    endDate: range.endDateTime,
    oIds: [],
    states: [],
    cities: [],
    districts: [],
    addressFlag: 0,
  };
}

function requestBody(apiCode, apiParams, tableCode) {
  return {
    coid: "",
    uid: "",
    data: {
      apiCode,
      apiParams,
      customColumnTableCode: tableCode,
      bizDomain: "salesTheme",
      pageCode: "SALES_THEME_ORDER",
      sysEnv: "ERP",
    },
  };
}

async function request(session, apiCode, params, tableCode) {
  const response = await fetch(`${API_ROOT}?apiCode=${apiCode}`, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      cookie: cookieHeader(session),
      origin: "https://src.erp321.com",
      referer: "https://src.erp321.com/erp-data/salesThemeAnalysis/order/home",
      pageparam: JSON.stringify({
        bizDomain: "salesTheme",
        pageCode: "SALES_THEME_ORDER",
        dataRole: 1,
      }),
      u_co_id: cookieValue(session, "u_co_id"),
      u_id: cookieValue(session, "u_id"),
    },
    body: JSON.stringify(requestBody(apiCode, params, tableCode)),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CliError("invalid_response", `聚水潭 returned non-JSON (HTTP ${response.status}).`);
  }
  if (payload?.code === -1 && payload?.msg === "未登录") {
    throw new CliError("not_logged_in", "The saved session expired. Run: jst-inventory auth import");
  }
  if (!response.ok || payload?.code !== 0 || payload?.success !== true) {
    throw new CliError("api_error", payload?.msg || `Request failed (HTTP ${response.status}).`);
  }
  return payload;
}

export function fetchOrderPage(session, range, page, pageSize = DEFAULT_PAGE_SIZE, dimension = "order") {
  const selected = orderDimension(dimension);
  return request(session, selected.detailApi, {
    ...baseParams(range),
    sortMap: { o_id: "DESC" },
    pageSize,
    pageNum: page,
  }, selected.tableCode);
}

export function fetchOrderSummary(session, range, dimension = "order") {
  const selected = orderDimension(dimension);
  return request(session, selected.summaryApi, {
    ...baseParams(range),
  }, selected.tableCode);
}
