import { cookieHeader } from "./chrome-session.js";
import { CliError } from "./errors.js";

const API_ROOT = "https://api.erp321.com/jst-data-report/getData/transportData";
// The sale-channel report is stricter than the other drawer APIs in practice.
// Keep its requests on one process-wide queue so SPU concurrency cannot burst it.
const SALE_CHANNEL_INTERVAL_MS = Number(process.env.JST_SALE_CHANNEL_INTERVAL_MS ?? 1_500);
const SALES_ANALYSIS_INTERVAL_MS = Number(process.env.JST_SALES_ANALYSIS_INTERVAL_MS ?? 100);
const ACCESS_LIMIT_WAIT_MS = Number(process.env.JST_ACCESS_LIMIT_WAIT_MS ?? 600_000);
let nextApiSlotAt = 0;
let apiQueue = Promise.resolve();
let nextSalesAnalysisSlotAt = 0;
let salesAnalysisQueue = Promise.resolve();
let accessLimitUntil = 0;

export const PURCHASE_WARNING_CONTEXT = Object.freeze({
  bizDomain: "purchaseAlarm",
  pageCode: "PURCHASE_ALARM",
});

export const SHOP_SHORTAGE_CONTEXT = Object.freeze({
  bizDomain: "stockOutAlarm",
  pageCode: "STOCK_OUT_ALARM",
});

export const DEFAULT_PARAMS = Object.freeze({
  hasSkuInfo: 1,
  skuLabelsFilterType: 1,
  avgQtyType: "pay_qty_today",
  noSentQtyType: "no_sent_qty",
  grossMarginType: "gross_margin_7d",
  sentSendRefundItemQtyRatePreType: "pre3to5",
  remarkFlag: 1,
  viewType: "spu",
  excludeNoPayQtyFlag: 1,
  realInventoryItemList: [
    { name: "main_qty", rate: 100 },
    { name: "purchase_qty", rate: 100 },
    { name: "return_onway_item_qty", rate: 100 },
    { name: "return_qty", rate: 100 },
    { name: "in_qty" },
  ],
});

export function requestBody(
  apiCode,
  apiParams,
  extraData = {},
  requestContext = PURCHASE_WARNING_CONTEXT,
) {
  return {
    coid: "",
    uid: "",
    data: {
      apiCode,
      apiParams,
      ...extraData,
      ...requestContext,
      sysEnv: "ERP",
    },
  };
}

function cookieValue(session, name) {
  return session.cookies.find((cookie) => cookie.name === name)?.value ?? "";
}

function assertAllowedTime(now = new Date()) {
  if (process.env.JST_AUTOMATED !== "1") return;
  if (process.env.JST_MANUAL === "1") return;
  const hour = Number(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now));
  if (hour >= 23 || hour < 7) {
    throw new CliError("quiet_hours", "Automated reads are disabled from 23:00 through 06:59 Asia/Shanghai.");
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function acquireApiSlot() {
  const slot = apiQueue.then(async () => {
    const wait = Math.max(0, nextApiSlotAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextApiSlotAt = Date.now() + SALE_CHANNEL_INTERVAL_MS;
  });
  apiQueue = slot.catch(() => {});
  return slot;
}

function acquireSalesAnalysisSlot() {
  const slot = salesAnalysisQueue.then(async () => {
    const wait = Math.max(0, nextSalesAnalysisSlotAt - Date.now());
    if (wait > 0) await sleep(wait);
    nextSalesAnalysisSlotAt = Date.now() + SALES_ANALYSIS_INTERVAL_MS;
  });
  salesAnalysisQueue = slot.catch(() => {});
  return slot;
}

async function waitForAccessLimit() {
  const wait = Math.max(0, accessLimitUntil - Date.now());
  if (wait > 0) await sleep(wait);
}

async function requestApi(
  session,
  apiCode,
  apiParams,
  extraData = {},
  requestContext = PURCHASE_WARNING_CONTEXT,
) {
  assertAllowedTime();
  const diagnostic = (status, payload) => ({
    api_code: apiCode, http_status: status,
    page_num: apiParams?.pageNum, page_size: apiParams?.pageSize,
    request: apiParams,
    ...(payload ? {response: {code: payload.code, success: payload.success, message: payload.msg}} : {}),
  });
  const cookies = cookieHeader(session);
  if (!cookies) {
    throw new CliError("session_expired", "The saved session has expired. Run: jst-inventory auth sync");
  }

  let response;
  try {
    if (apiCode === "purchase_alarm_sale_channel_detail") await acquireApiSlot();
    if ([
      "purchase_goods_analysis_trend_detail",
      "purchase_goods_analysis_trend_curve",
    ].includes(apiCode)) await acquireSalesAnalysisSlot();
    // A request may have been queued before another request observed the
    // account limit. Re-check the shared gate immediately before sending it.
    await waitForAccessLimit();
    response = await fetch(`${API_ROOT}?apiCode=${encodeURIComponent(apiCode)}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json",
        cookie: cookies,
        origin: "https://src.erp321.com",
        referer: "https://src.erp321.com/",
        u_co_id: cookieValue(session, "u_co_id"),
        u_id: cookieValue(session, "u_id"),
      },
      body: JSON.stringify(requestBody(apiCode, apiParams, extraData, requestContext)),
    });
  } catch (error) {
    throw new CliError("network_error", `聚水潭 request failed: ${error.message}`, diagnostic());
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new CliError("invalid_response", `聚水潭 returned a non-JSON response (HTTP ${response.status}).`, diagnostic(response.status));
  }

  if (payload?.code === -1 && payload?.msg === "未登录") {
    throw new CliError("not_logged_in", "The saved 聚水潭 session is no longer valid. Run: jst-inventory auth sync", diagnostic(response.status, payload));
  }
  if (!response.ok || payload?.code !== 0 || payload?.success !== true) {
    throw new CliError(
      "api_error",
      payload?.msg || `聚水潭 request failed (HTTP ${response.status}, code ${String(payload?.code)}).`,
      diagnostic(response.status, payload),
    );
  }
  return payload;
}

async function callApiWithRiskControl(args, validate = () => true) {
  for (;;) {
    await waitForAccessLimit();
    try {
      const payload = await requestApi(...args);
      if (!validate(payload)) {
        throw new CliError("invalid_response", "聚水潭 returned a non-array page payload.");
      }
      return payload;
    } catch (error) {
      const accessLimited = error instanceof CliError
        && error.code === "api_error"
        && error.message.includes("访问超过限制");
      if (!accessLimited) throw error;
      accessLimitUntil = Math.max(accessLimitUntil, Date.now() + ACCESS_LIMIT_WAIT_MS);
    }
  }
}

export function callApi(...args) {
  return callApiWithRiskControl(args);
}

export function callListApi(...args) {
  return callApiWithRiskControl(args, (payload) => Array.isArray(payload?.data));
}

export function summaryParams() {
  return {
    ...structuredClone(DEFAULT_PARAMS),
    stockoutGoodsCreatedDays: 30,
    stockoutHotAvgQtyType: "pay_avg_qty_7d",
    stockoutHotAvgQty: 50,
    adviceGoodsCreatedDays: 30,
    adviceHotAvgQtyType: "pay_avg_qty_7d",
    adviceHotAvgQty: 5,
    lowInventoryAvailableDaysFrom: 0,
    lowInventoryAvailableDaysTo: 5,
    lowSaleAvailableDaysFrom: 30,
    lowSaleAvgQtyType: "pay_avg_qty_7d",
    lowSaleAvgQty: 5,
    stockoutGoodsQtyFrom: 0,
    noPayQtyType: "no_pay_qty_90d",
  };
}

export function detailParams(page, limit) {
  return {
    ...structuredClone(DEFAULT_PARAMS),
    childrenSortMap: { advice_purchase_qty: "DESC" },
    sortMap: { advice_purchase_qty: "DESC" },
    pageSize: limit,
    pageNum: page,
  };
}

// The purchase quantity changes while a full snapshot is being read. Sorting
// the live SPU crawl by that value can move a row across a page boundary and
// produce a duplicate/missing SPU. SPU IDs are unique and stable for the life
// of one crawl, so the lightweight exporter uses them as its pagination key.
export function spuLiveParams(page, limit) {
  return {
    ...detailParams(page, limit),
    sortMap: { spu_id: "ASC" },
  };
}

export function saleChannelParams({ spuId, skuId, countType = "platform", page = 1, pageSize = 100, shopIds, platforms, disCoIds, sortMap } = {}) {
  if (!["platform", "channel"].includes(countType)) {
    throw new CliError("invalid_count_type", "countType must be platform or channel.");
  }
  if (spuId == null && skuId == null) throw new CliError("missing_product", "spuId or skuId is required.");
  const params = {
    countType,
    queryType: skuId != null ? "sku" : "spu",
    ...(skuId != null ? { skuId: String(skuId) } : { spuId: String(spuId) }),
    pageNum: page,
    pageSize,
    ...(Array.isArray(shopIds) && shopIds.length ? { shopIds } : {}),
    ...(Array.isArray(platforms) && platforms.length ? { platforms } : {}),
    ...(countType === "channel" && Array.isArray(disCoIds) && disCoIds.length ? { disCoIds } : {}),
    ...(sortMap ? { sortMap } : {}),
  };
  return params;
}

export async function listSaleChannel({ session, spuId, skuId, countType = "platform", page = 1, pageSize = 100, shopIds, platforms, disCoIds, sortMap, fetchPage }) {
  const params = saleChannelParams({ spuId, skuId, countType, page, pageSize, shopIds, platforms, disCoIds, sortMap });
  const payload = fetchPage
    ? await fetchPage(params)
    : await callListApi(session, "purchase_alarm_sale_channel_detail", params, {}, PURCHASE_WARNING_CONTEXT);
  return {
    dimension: countType,
    query_type: params.queryType,
    ...(params.spuId ? { spu_id: params.spuId } : { sku_id: params.skuId }),
    page, page_size: pageSize, total: Number(payload.total ?? 0),
    rows: payload.data ?? [],
  };
}

export async function getAllSaleChannel({ session, spuId, countType = "platform", pageSize = 100, fetchPage }) {
  const request = (page) => listSaleChannel({ session, spuId, countType, page, pageSize, ...(fetchPage ? { fetchPage } : {}) });
  const first = await request(1);
  const pages = Math.max(1, Math.ceil(first.total / pageSize));
  const rows = [...first.rows];
  for (let page = 2; page <= pages; page += 1) rows.push(...(await request(page)).rows);
  return { ...first, pages, rows };
}

export function shopShortageParams(page, limit) {
  return {
    cardType: "lackSku",
    sortMap: { no_sent_pay_amt: "DESC" },
    childrenSortMap: { no_sent_pay_amt: "DESC" },
    pageSize: limit,
    pageNum: page,
  };
}

export function parseChildren(rows) {
  return rows.map((row) => {
    if (typeof row.children !== "string") return row;
    try {
      return { ...row, children: JSON.parse(row.children) };
    } catch {
      return row;
    }
  });
}
