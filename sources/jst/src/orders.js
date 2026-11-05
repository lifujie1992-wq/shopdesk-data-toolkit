/**
 * jst orders —— 聚水潭订单明细。
 *
 * 迁移自 jushuitan-order-details（986 行）。字段、过滤条件、分页、
 * 并发、落库结构全部原样保留，只把基础设施换成 @shopdesk/core。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CliError,
  atomicBuild,
  assertDate,
  createJstTransport,
  dateRange,
  loadSession,
  openDatabase,
  prepareReplace,
  resolveDataPath,
  yesterdayShanghai,
} from "@shopdesk/core";

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

/** 迁移期默认路径：新位置存在就用新的，否则沿用家目录旧文件（行为零变化）。 */
export function defaultOutputPath(dimension = "order") {
  const file = dimension === "item" ? "order-item-details.sqlite" : "order-details.sqlite";
  const next = resolveDataPath("jst/orders", file);
  const legacy = join(homedir(), `jst-${file}`);
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
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

const PROFILE = Object.freeze({
  origin: "https://src.erp321.com",
  referer: "https://src.erp321.com/erp-data/salesThemeAnalysis/order/home",
  pageParam: { bizDomain: "salesTheme", pageCode: "SALES_THEME_ORDER", dataRole: 1 },
});

function transport(session) {
  return createJstTransport({ session, profile: PROFILE });
}

function requestBody(apiCode, apiParams, tableCode) {
  return {
    extraData: { customColumnTableCode: tableCode },
    context: { bizDomain: "salesTheme", pageCode: "SALES_THEME_ORDER" },
  };
}

export async function fetchOrderPage(session, range, page, pageSize = DEFAULT_PAGE_SIZE, dimension = "order") {
  const selected = orderDimension(dimension);
  const { extraData, context } = requestBody(selected.detailApi, null, selected.tableCode);
  return transport(session).request(selected.detailApi, {
    ...baseParams(range),
    sortMap: { o_id: "DESC" },
    pageSize,
    pageNum: page,
  }, { extraData, context });
}

export async function fetchOrderSummary(session, range, dimension = "order") {
  const selected = orderDimension(dimension);
  const { extraData, context } = requestBody(selected.summaryApi, null, selected.tableCode);
  return transport(session).request(selected.summaryApi, {
    ...baseParams(range),
  }, { extraData, context });
}

/**
 * 53 个接口字段。顺序即建表顺序，不要改 —— parity 测试按列名+顺序比对。
 */
export const COLUMN_DEFS = Object.freeze({
  o_id: "TEXT PRIMARY KEY",
  sku_id: "TEXT",
  so_id: "TEXT",
  mainCoid: "TEXT",
  drp_co_from_name: "TEXT",
  platform: "TEXT",
  shop_name: "TEXT",
  drp_co_to_name: "TEXT",
  wms_co_name: "TEXT",
  order_date: "TEXT",
  send_date: "TEXT",
  pay_date: "TEXT",
  oi_item_end_time: "TEXT",
  sku_cost: "REAL",
  r_sent_cost: "REAL",
  gross_margin: "REAL",
  freight_cost: "REAL",
  free_amount: "REAL",
  freight_revenue: "REAL",
  gift_cost: "REAL",
  gift_qty: "REAL",
  no_price_qty: "REAL",
  dw_pay_amount: "REAL",
  base_amount: "REAL",
  skus: "TEXT",
  order_qty: "REAL",
  order_amt: "REAL",
  r_sent_qty: "REAL",
  r_sent_amt: "REAL",
  gross_margin_rate: "REAL",
  refund_cost: "REAL",
  r_refund_cost: "REAL",
  refund_qty: "REAL",
  r_refund_qty: "REAL",
  refund_amt: "REAL",
  r_refund_amt: "REAL",
  outer_so_id: "TEXT",
  io_ids: "TEXT",
  labels: "TEXT",
  order_type: "TEXT",
  status: "TEXT",
  creator_name: "TEXT",
  receiver_state: "TEXT",
  receiver_name: "TEXT",
  receiver_city: "TEXT",
  receiver_district: "TEXT",
  logistics_company: "TEXT",
  packagemartial_cost: "REAL",
  l_id: "TEXT",
  node: "TEXT",
  buyer_message: "TEXT",
  seller_flag: "TEXT",
  remark: "TEXT",
});

export const COLUMNS = Object.keys(COLUMN_DEFS);
const TEXT_IDS = new Set(["o_id", "sku_id", "so_id", "mainCoid", "outer_so_id", "l_id"]);

function sqliteValue(name, value) {
  if (value === null || value === undefined) return null;
  if (TEXT_IDS.has(name)) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return Number(value);
  return value;
}

const SYNC_INFO_DEFS = Object.freeze({
  id: "INTEGER PRIMARY KEY CHECK (id = 1)",
  started_at: "TEXT NOT NULL",
  completed_at: "TEXT NOT NULL",
  duration_ms: "INTEGER NOT NULL",
  start_date: "TEXT NOT NULL",
  end_date: "TEXT NOT NULL",
  source_total: "INTEGER NOT NULL",
  fetched_rows: "INTEGER NOT NULL",
  saved_rows: "INTEGER NOT NULL",
  pages: "INTEGER NOT NULL",
  page_size: "INTEGER NOT NULL",
  concurrency: "INTEGER NOT NULL",
  summary_json: "TEXT NOT NULL",
});

function createSchema(db) {
  const cols = (defs) => Object.entries(defs).map(([n, t]) => `"${n}" ${t}`).join(",\n      ");
  db.exec(`
    CREATE TABLE order_details (
      ${cols(COLUMN_DEFS)}
    );
    CREATE TABLE sync_info (
      ${cols(SYNC_INFO_DEFS)}
    );
  `);
}

const CREATE_INDEXES = `
  CREATE INDEX order_details_send_date_idx ON order_details(send_date);
  CREATE INDEX order_details_shop_idx ON order_details(shop_name);
  CREATE INDEX order_details_so_id_idx ON order_details(so_id);
  CREATE INDEX order_details_outer_so_id_idx ON order_details(outer_so_id);
`;

export async function exportOrdersToSqlite({
  session,
  range,
  outputPath,
  pageSize = DEFAULT_PAGE_SIZE,
  concurrency = 3,
  mergeFromPath = null,
  dimension = "order",
  onProgress = () => {},
}) {
  const startedAt = new Date();
  const started = performance.now();

  return atomicBuild(outputPath, async (db) => {
    createSchema(db);

    let preservedRows = 0;
    if (mergeFromPath) {
      const mergeSource = mergeFromPath;
      if (!existsSync(mergeSource)) throw new Error("merge source is missing");
      db.prepare("ATTACH DATABASE ? AS previous").run(mergeSource);
      const previousColumns = db.prepare("PRAGMA previous.table_info(order_details)").all()
        .map((row) => row.name);
      if (previousColumns.join("\0") !== COLUMNS.join("\0")) {
        throw new Error("merge source schema mismatch");
      }
      const columns = COLUMNS.map((name) => `"${name}"`).join(",");
      db.prepare(`
        INSERT INTO order_details (${columns})
        SELECT ${columns} FROM previous.order_details
        WHERE send_date IS NULL OR substr(send_date, 1, 10) < ? OR substr(send_date, 1, 10) > ?
      `).run(range.start_date, range.end_date);
      preservedRows = Number(db.prepare("SELECT count(*) AS count FROM order_details").get().count);
    }

    const insert = prepareReplace(db, "order_details", COLUMNS);
    const insertPage = (rows) => {
      for (const row of rows ?? []) {
        if (row.o_id === null || row.o_id === undefined || row.o_id === "") continue;
        insert.run(...COLUMNS.map((name) => sqliteValue(name, row[name])));
      }
    };

    const [first, summary] = await Promise.all([
      fetchOrderPage(session, range, 1, pageSize, dimension),
      fetchOrderSummary(session, range, dimension),
    ]);
    const total = Number(first.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let fetchedRows = first.data?.length ?? 0;

    db.exec("BEGIN;");
    insertPage(first.data ?? []);

    for (let firstPage = 2; firstPage <= pages; firstPage += concurrency) {
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, pages - firstPage + 1) },
        (_, index) => firstPage + index,
      );
      const payloads = await Promise.all(
        pageNumbers.map((page) => fetchOrderPage(session, range, page, pageSize, dimension)),
      );
      for (const payload of payloads) {
        const rows = payload.data ?? [];
        fetchedRows += rows.length;
        insertPage(rows);
      }
      onProgress({ completedPages: pageNumbers.at(-1), pages, fetchedRows });
    }

    const savedRows = Number(db.prepare("SELECT COUNT(*) AS count FROM order_details").get().count);
    const completedAt = new Date();
    const durationMs = Math.round(performance.now() - started);

    db.prepare(`
      INSERT INTO sync_info (
        id, started_at, completed_at, duration_ms, start_date, end_date,
        source_total, fetched_rows, saved_rows, pages, page_size,
        concurrency, summary_json
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      startedAt.toISOString(), completedAt.toISOString(), durationMs,
      range.start_date, range.end_date, total, fetchedRows, savedRows,
      pages, pageSize, concurrency, JSON.stringify(summary.data ?? []),
    );
    db.exec("COMMIT;");
    db.exec(CREATE_INDEXES);

    return {
      start_date: range.start_date,
      end_date: range.end_date,
      total,
      fetched_rows: fetchedRows,
      saved_rows: savedRows,
      pages,
      duration_ms: durationMs,
      preserved_rows: preservedRows,
      incremental: Boolean(mergeFromPath),
    };
  });
}

export function readOrderSummary(outputPath) {
  const db = openDatabase(outputPath, { readOnly: true });
  try {
    const info = db.prepare("SELECT * FROM sync_info WHERE id = 1").get();
    if (!info) throw new CliError("empty_database", `No sync_info in ${outputPath}`);
    return { ...info, summary: JSON.parse(info.summary_json), summary_json: undefined };
  } finally {
    db.close();
  }
}

export function readOrders(outputPath, limit) {
  const db = openDatabase(outputPath, { readOnly: true });
  try {
    return db.prepare(`
      SELECT o_id, so_id, outer_so_id, platform, shop_name, order_type,
        status, order_date, send_date, pay_date, order_qty, order_amt,
        r_sent_qty, r_sent_amt, sku_cost, gross_margin, gross_margin_rate,
        refund_qty, refund_amt, logistics_company, skus
      FROM order_details
      ORDER BY o_id DESC
      LIMIT ?
    `).all(limit);
  } finally {
    db.close();
  }
}

/** 参数与旧 CLI 完全一致的区间解析。 */
export function inputRange({ days, endDate }) {
  return dateRange(days ?? 30, endDate ?? yesterdayShanghai());
}

export { assertDate };
