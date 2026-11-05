import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { callListApi } from "./api.js";
import { cookieHeader } from "./chrome-session.js";
import { CliError } from "./errors.js";

const EXPORT_ROOT = "https://api.erp321.com/jst-data-export/export";
export const PROFIT_ANALYSIS_API = "profit_analysis_sku_list";
export const PROFIT_ANALYSIS_CONTEXT = Object.freeze({
  bizDomain: "profitAnalysis",
  pageCode: "PROFIT_ANALYSIS",
  sysEnv: "ERP",
});

export const PROFIT_ANALYSIS_COLUMNS = Object.freeze([
  "sku_name", "properties_value", "sku_id", "i_id",
  "order_sku_gross_profit", "order_sku_gross_profit_rate",
  "order_item_gross_profit", "order_item_gross_profit_rate",
  "net_order_sku_cost", "net_order_sku_cost_pct", "order_sku_profit",
  "order_sku_profit_chain", "order_sku_profit_desc", "order_sku_profit_rate",
  "order_sku_profit_rate_change", "per_order_sku_profit", "net_order_item_amt",
  "net_order_item_qty", "total_income_amt", "order_item_amt", "order_item_freight",
  "net_sku_cost", "net_sku_cost_pct", "order_sku_cost",
  "afs_refund_order_item_cost", "afs_before_send_sku_cost",
  "afs_after_send_refund_sku_cost", "cancel_exp_afs_order_sku_cost",
  "order_sku_f_freight", "order_sku_f_freight_pct", "order_sku_commission",
  "order_sku_commission_pct", "order_sku_commission_settled",
  "order_sku_commission_esi", "common_commission", "common_commission_pct",
  "order_sku_anchor_common_commission", "order_sku_head_common_commission",
  "order_sku_partner_common_commission", "order_sku_other_common_commission",
  "marketing_fee_return", "other_fee", "other_fee_pct", "order_sku_packing_fee",
  "order_sku_packing_fee_pct", "order_sku_freight_insurance",
  "order_sku_freight_insurance_pct", "order_sku_taxes", "order_sku_taxes_pct",
  "order_item_freight_gross_profit", "per_order_sku_gross_profit",
  "special_order_total_fee", "self_define_fee", "goods_create_date",
]);

function cookieValue(session, name) {
  return session.cookies.find((cookie) => cookie.name === name)?.value ?? "";
}

function parseDay(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) {
    throw new CliError("invalid_arguments", `${name} must use YYYY-MM-DD.`);
  }
  const day = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(day.valueOf()) || day.toISOString().slice(0, 10) !== value) {
    throw new CliError("invalid_arguments", `${name} is not a valid date.`);
  }
  return day;
}

function dayText(day) { return day.toISOString().slice(0, 10); }
function addDays(day, count) { return new Date(day.valueOf() + count * 86_400_000); }

export function defaultProfitDateRange(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const today = parseDay(`${value.year}-${value.month}-${value.day}`, "date");
  const end = addDays(today, -1);
  return { startDate: dayText(addDays(end, -6)), endDate: dayText(end) };
}

export function profitAnalysisParams(startDate, endDate) {
  const start = parseDay(startDate, "--start-date");
  const end = parseDay(endDate, "--end-date");
  if (start > end) throw new CliError("invalid_arguments", "--start-date must not be after --end-date.");
  const periodDays = Math.round((end - start) / 86_400_000) + 1;
  if (periodDays > 366) throw new CliError("invalid_arguments", "The export range must not exceed 366 days.");
  return {
    startDate, endDate,
    preDate: dayText(addDays(start, -periodDays)),
    preStartDate: dayText(addDays(start, -periodDays)),
    preEndDate: dayText(addDays(start, -1)),
    periodDays,
    dataLastUpdateDate: endDate,
    lossGrossProfitAmt: 50, alwaysLossGrossProfitAmt: 50,
    incrTurnLossGrossAmt: 50, lossTurnIncrGrossAmt: 50, alwaysIncrGrossProfitAmt: 50,
    high_gross_profit_config_qty: 0, high_gross_profit_config_rate: 20,
    alwaysLossProfitAmt: 50, incrTurnLossAmt: 50, lossTurnIncrAmt: 50,
    alwaysIncrProfitAmt: 50, orderItemFreight: 0,
    core_revenue_config_qty: 0, core_revenue_config_profit_rate: 20,
    listType: "SIMPLE", sortMap: { total_income_amt: "DESC" }, pageSize: 10, pageNum: 1,
  };
}

function requestBody(data) { return { coid: "", uid: "", data }; }

async function postJson(session, path, data, fetchImpl) {
  const cookies = cookieHeader(session);
  if (!cookies) throw new CliError("session_expired", "The saved session has expired. Run: jst-inventory auth sync");
  let response;
  try {
    response = await fetchImpl(`${EXPORT_ROOT}/${path}`, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*", "content-type": "application/json",
        cookie: cookies, origin: "https://src.erp321.com", referer: "https://src.erp321.com/",
        u_co_id: cookieValue(session, "u_co_id"), u_id: cookieValue(session, "u_id"),
      },
      body: JSON.stringify(requestBody(data)),
    });
  } catch (error) {
    throw new CliError("network_error", `聚水潭 export request failed: ${error.message}`);
  }
  let payload;
  try { payload = await response.json(); }
  catch { throw new CliError("invalid_response", `聚水潭 returned non-JSON export data (HTTP ${response.status}).`); }
  if (payload?.code === -1 && payload?.msg === "未登录") {
    throw new CliError("not_logged_in", "The saved 聚水潭 session is no longer valid. Run: jst-inventory auth sync");
  }
  if (!response.ok || payload?.code !== 0 || payload?.success !== true) {
    throw new CliError("api_error", payload?.msg || `聚水潭 export request failed (HTTP ${response.status}).`);
  }
  return payload.data;
}

function normalizeTasks(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.data)) return data.data;
  return data ? [data] : [];
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function atomicJson(path, value) {
  const target = resolve(path);
  const temporary = `${target}.partial`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
  return target;
}

function focusCount(value, field, skuId) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new CliError("invalid_response", `Invalid ${field} for SKU ${skuId}.`);
  }
  return number;
}

export function profitStateLabel(description) {
  const value = String(description ?? "").trim();
  if (!value) return null;
  if (["盈利增长", "盈利缩小"].includes(value)) return "持续盈利";
  if (["亏损扩大", "亏损缩小"].includes(value)) return "持续亏损";
  return value;
}

export async function crawlProfitFocusOrders({
  session, startDate, endDate, outputPath, batchSize = 500, fetchPage,
  onProgress, requestIntervalMs = 250,
}) {
  if (!outputPath) throw new CliError("invalid_arguments", "A focus-order output path is required.");
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new CliError("invalid_arguments", "Focus-order batch size must be 1-500.");
  }
  const base = profitAnalysisParams(startDate, endDate);
  const request = fetchPage ?? ((apiCode, apiParams) => callListApi(
    session, apiCode, apiParams, {}, PROFIT_ANALYSIS_CONTEXT,
  ));
  const readList = (page) => request(PROFIT_ANALYSIS_API, {
    ...base, sortMap: { sku_id: "ASC" }, pageSize: batchSize, pageNum: page,
  });
  const first = await readList(1);
  const total = Number(first.total);
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new CliError("invalid_response", "聚水潭 returned an invalid profit-analysis total.");
  }
  const pages = Math.ceil(total / batchSize);
  const rows = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page += 1) {
    const list = page === 1 ? first : await readList(page);
    if (Number(list.total) !== total || !Array.isArray(list.data)) {
      throw new CliError("incomplete_export", "Profit-analysis SKU total changed during focus-order crawl.");
    }
    const expected = page === pages ? total - batchSize * (pages - 1) : batchSize;
    if (list.data.length !== expected) {
      throw new CliError("incomplete_export", `Profit-analysis page ${page} was incomplete.`);
    }
    const skuIds = list.data.map((row) => String(row.sku_id ?? "").trim());
    if (skuIds.some((skuId) => !skuId || seen.has(skuId)) || new Set(skuIds).size !== skuIds.length) {
      throw new CliError("incomplete_export", `Profit-analysis page ${page} contained a missing or duplicate SKU.`);
    }
    const focus = await request("profit_analysis_sku_order_high_profit_cnt", {
      ...base, skuIds, orderQueryType: "sku",
    });
    const focusBySku = new Map();
    for (const item of focus.data ?? []) {
      const skuId = String(item.sku_id ?? "").trim();
      if (!skuIds.includes(skuId) || focusBySku.has(skuId)) {
        throw new CliError("incomplete_export", `Focus-order response contained an unknown or duplicate SKU ${skuId}.`);
      }
      focusBySku.set(skuId, item);
    }
    for (let index = 0; index < skuIds.length; index += 1) {
      const skuId = skuIds[index];
      const source = list.data[index];
      const item = focusBySku.get(skuId) ?? {};
      const profitDescription = String(source.order_sku_profit_desc ?? "").trim();
      const grossProfitDescription = String(source.order_sku_gross_profit_desc ?? "").trim();
      rows.push({
        sku_id: skuId,
        high_profit_order_count: focusCount(item.high_profit_cnt, "high_profit_cnt", skuId),
        high_gross_profit_order_count: focusCount(item.high_gross_profit_cnt, "high_gross_profit_cnt", skuId),
        negative_profit_order_count: focusCount(item.loss_profit_cnt, "loss_profit_cnt", skuId),
        negative_gross_profit_order_count: focusCount(item.loss_gross_profit_cnt, "loss_gross_profit_cnt", skuId),
        product_loss_order_count: focusCount(item.loss_sku_amt_cnt, "loss_sku_amt_cnt", skuId),
        freight_loss_order_count: focusCount(item.loss_freight_amt_cnt, "loss_freight_amt_cnt", skuId),
        profit_status_label: profitStateLabel(profitDescription),
        profit_change_label: profitDescription || null,
        gross_profit_status_label: profitStateLabel(grossProfitDescription),
        gross_profit_change_label: grossProfitDescription || null,
        raw: source,
      });
      seen.add(skuId);
    }
    onProgress?.({ phase: "focus_orders", page, pages, completed: rows.length, total });
    if (page < pages && requestIntervalMs > 0) await sleep(requestIntervalMs);
  }
  if (rows.length !== total || seen.size !== total) {
    throw new CliError("incomplete_export", "Focus-order crawl did not cover every SKU.");
  }
  const payload = {
    format_version: 2, source: "profit_analysis_sku_list",
    start_date: startDate, end_date: endDate,
    row_count: rows.length, captured_at: new Date().toISOString(), rows,
  };
  const target = atomicJson(outputPath, payload);
  return {
    output: target, start_date: startDate, end_date: endDate,
    row_count: rows.length, pages, batch_size: batchSize,
  };
}


export const crawlProfitAnalysisJson = crawlProfitFocusOrders;

export async function exportProfitAnalysisXlsx({
  session, outputPath, startDate, endDate, pollIntervalMs = 5_000,
  timeoutMs = 20 * 60_000, fetchImpl = fetch, now = () => new Date(), onProgress,
  focusOutputPath,
}) {
  if (!outputPath) throw new CliError("invalid_arguments", "--output is required.");
  const defaults = defaultProfitDateRange(now());
  const range = { startDate: startDate ?? defaults.startDate, endDate: endDate ?? defaults.endDate };
  const apiParams = profitAnalysisParams(range.startDate, range.endDate);
  const started = await postJson(session, "exportExcel", {
    apiCode: PROFIT_ANALYSIS_API, apiParams, orderColumns: [...PROFIT_ANALYSIS_COLUMNS],
    ...PROFIT_ANALYSIS_CONTEXT,
  }, fetchImpl);
  const taskId = started?.id ?? started?.taskId ?? started;
  if (taskId == null || typeof taskId === "object") {
    throw new CliError("invalid_response", "聚水潭 did not return an export task id.");
  }
  onProgress?.({ phase: "submitted", taskId });
  const deadline = Date.now() + timeoutMs;
  let task;
  while (Date.now() < deadline) {
    const history = await postJson(session, "queryExportResult", { apiCode: PROFIT_ANALYSIS_API }, fetchImpl);
    task = normalizeTasks(history).find((item) => String(item.id ?? item.taskId) === String(taskId));
    const status = Number(task?.status);
    if (status === 1 && task?.url) break;
    if ([2, 3, -1].includes(status)) {
      throw new CliError("export_failed", task?.msg || task?.errorMsg || `聚水潭 export task ${taskId} failed.`);
    }
    onProgress?.({ phase: "waiting", taskId, status: Number.isFinite(status) ? status : null });
    await sleep(pollIntervalMs);
  }
  if (!task?.url) throw new CliError("export_timeout", `聚水潭 export task ${taskId} did not finish in time.`);
  let download;
  try { download = await fetchImpl(task.url); }
  catch (error) { throw new CliError("network_error", `Excel download failed: ${error.message}`); }
  if (!download.ok) throw new CliError("download_failed", `Excel download failed (HTTP ${download.status}).`);
  const bytes = Buffer.from(await download.arrayBuffer());
  if (bytes.length < 4 || bytes.subarray(0, 2).toString("ascii") !== "PK") {
    throw new CliError("invalid_excel", "聚水潭 export download was not an XLSX file.");
  }
  const target = resolve(outputPath);
  const temporary = `${target}.partial`;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, target);
  const focusOrders = focusOutputPath ? await crawlProfitFocusOrders({
    session, startDate: range.startDate, endDate: range.endDate,
    outputPath: focusOutputPath, onProgress,
  }) : null;
  return {
    task_id: String(taskId), start_date: range.startDate, end_date: range.endDate,
    row_count: Number(task.total ?? task.rowCount ?? 0), source_name: task.fileName ?? null,
    output: target, bytes: bytes.length, completed_at: new Date().toISOString(),
    ...(focusOrders ? { focus_orders: focusOrders } : {}),
  };
}
