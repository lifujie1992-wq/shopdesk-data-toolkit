import { cookieHeader, cookieValue } from "./session.js";
import { CliError } from "./errors.js";

const API_URL = "https://api.erp321.com/jst-data-report/getData/transportData?apiCode=sales_performance_channel_list";

export function assertDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CliError("invalid_date", "Date must use YYYY-MM-DD format.");
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new CliError("invalid_date", "Date is not a valid calendar date.");
  }
  return value;
}

export function previousDate(value) {
  assertDate(value);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
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

function requestBody(date, page, pageSize) {
  const previous = previousDate(date);
  return {
    coid: "",
    uid: "",
    data: {
      apiCode: "sales_performance_channel_list",
      apiParams: {
        pageNum: page,
        pageSize,
        dateSelectValue: {
          quickKey: "Days",
          quickSubKey: "1d",
          startDate: date,
          endDate: date,
          preDate: "",
          preStartDate: previous,
          preEndDate: previous,
        },
        startDate: date,
        endDate: date,
        preDate: "",
        preStartDate: previous,
        preEndDate: previous,
        timePeriod: "day",
        timePeriodFullFlag: 1,
        selectSaleType: "",
        sortMap: { net_order_amt: "DESC" },
      },
      debounce: true,
      customColumnTableCode: "sales_performance_report_overview_shop_v_2_table",
      bizDomain: "merchantBusinessAnalysis",
      pageCode: "SALES_PERFORMANCE",
      sysEnv: "ERP",
    },
  };
}

async function fetchPage(session, date, page, pageSize) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      cookie: cookieHeader(session),
      origin: "https://www.erp321.com",
      referer: "https://www.erp321.com/",
      pageparam: JSON.stringify({
        bizDomain: "merchantBusinessAnalysis",
        pageCode: "SALES_PERFORMANCE",
        dataRole: 1,
      }),
      u_co_id: cookieValue(session, "u_co_id"),
      u_id: cookieValue(session, "u_id"),
    },
    body: JSON.stringify(requestBody(date, page, pageSize)),
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

export async function fetchSalesPerformance(session, date, pageSize = 500) {
  assertDate(date);
  const first = await fetchPage(session, date, 1, pageSize);
  const total = Number(first.total ?? first.data?.length ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const payload = await fetchPage(session, date, page, pageSize);
    rows.push(...(payload.data ?? []));
  }
  return {
    date,
    total,
    pages,
    rows: rows.filter((row) => row.channel_name),
  };
}
