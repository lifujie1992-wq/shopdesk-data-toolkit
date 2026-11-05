import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getAllSaleChannel } from "./api.js";
import { SALE_CHANNEL_SCHEMA } from "./sale-channel-sqlite.js";
import { SHOP_SKU_BATCH_SCHEMA } from "./shop-sku-batch.js";
import {
  getAllLinkPayQuantities,
  getAllSalesAnalysisDimension,
  getAllShopSalesAnalysis,
  salesAnalysisDateRange,
  yesterdayShanghai,
} from "./sales-analysis.js";

const SALES_ANALYSIS_SCHEMA_VERSION = 10;

const SALES_ANALYSIS_TABLES = [
  "sale_channel_snapshots",
  "sale_channel_batch_snapshots",
  "sales_analysis_export_info",
  "platform_product_sales_analysis",
  "shop_product_sales_analysis",
  "link_product_sales_analysis",
  "product_daily_sales_analysis",
  "shop_daily_sales_analysis",
];

const PAY_QUANTITY_COLUMNS = [
  "pay_qty_today",
  "pay_qty_3d",
  "pay_qty_7d",
  "pay_qty_15d",
  "pay_qty_30d",
];

const COMPATIBLE_MISSING_COLUMNS = {
  sales_analysis_export_info: new Set([
    "fetched_shop_daily_rows",
    "fetched_platform_rows",
    "fetched_link_rows",
  ]),
  shop_product_sales_analysis: new Set(["return_item_qty_180d", ...PAY_QUANTITY_COLUMNS]),
  platform_product_sales_analysis: new Set(PAY_QUANTITY_COLUMNS),
  link_product_sales_analysis: new Set(PAY_QUANTITY_COLUMNS),
};
const COMPATIBLE_MISSING_VALUES = {
  sales_analysis_export_info: {
    fetched_shop_daily_rows: "0",
    fetched_platform_rows: "0",
    fetched_link_rows: "0",
  },
  shop_product_sales_analysis: Object.fromEntries(
    PAY_QUANTITY_COLUMNS.map((column) => [column, "NULL"]),
  ),
  platform_product_sales_analysis: Object.fromEntries(
    PAY_QUANTITY_COLUMNS.map((column) => [column, "NULL"]),
  ),
  link_product_sales_analysis: Object.fromEntries(
    PAY_QUANTITY_COLUMNS.map((column) => [column, "NULL"]),
  ),
};
const COMPATIBLE_MISSING_TABLES = new Set([
  "sale_channel_snapshots",
  "sale_channel_batch_snapshots",
  "platform_product_sales_analysis",
  "link_product_sales_analysis",
  "shop_daily_sales_analysis",
]);

function qi(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function createSchema(db) {
  db.exec(SALE_CHANNEL_SCHEMA);
  db.exec(SHOP_SKU_BATCH_SCHEMA);
  db.exec(`
    DROP TABLE IF EXISTS sales_analysis_export_info;
    DROP TABLE IF EXISTS platform_product_sales_analysis;
    DROP TABLE IF EXISTS shop_product_sales_analysis;
    DROP TABLE IF EXISTS link_product_sales_analysis;
    DROP TABLE IF EXISTS sales_analysis_checkpoint_spu;
    DROP TABLE IF EXISTS sales_analysis_checkpoint;

    CREATE TABLE sales_analysis_export_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      period_days INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      previous_start_date TEXT NOT NULL,
      previous_end_date TEXT NOT NULL,
      total_spus INTEGER NOT NULL,
      fetched_spus INTEGER NOT NULL,
      fetched_rows INTEGER NOT NULL,
      fetched_platform_rows INTEGER NOT NULL,
      fetched_link_rows INTEGER NOT NULL,
      fetched_daily_rows INTEGER NOT NULL,
      fetched_shop_daily_rows INTEGER NOT NULL,
      page_size INTEGER NOT NULL,
      concurrency INTEGER NOT NULL
    );

    CREATE TABLE sales_analysis_checkpoint (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      period_days INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      total_spus INTEGER NOT NULL,
      started_at TEXT NOT NULL
    );

    CREATE TABLE sales_analysis_checkpoint_spu (
      spu_id TEXT PRIMARY KEY,
      completed_at TEXT NOT NULL
    );

    CREATE TABLE platform_product_sales_analysis (
      spu_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      previous_start_date TEXT NOT NULL,
      previous_end_date TEXT NOT NULL,
      pay_qty_today REAL,
      pay_qty_3d REAL,
      pay_qty_7d REAL,
      pay_qty_15d REAL,
      pay_qty_30d REAL,
      sales_qty REAL,
      previous_sales_qty REAL,
      sales_increase REAL,
      sales_chain_ratio REAL,
      sales_chain_percent REAL,
      sales_amount REAL,
      previous_sales_amount REAL,
      sales_amount_increase REAL,
      sales_amount_chain_ratio REAL,
      sales_amount_chain_percent REAL,
      order_count REAL,
      previous_order_count REAL,
      order_count_increase REAL,
      order_count_chain_ratio REAL,
      order_count_chain_percent REAL,
      paid_return_qty REAL,
      paid_return_qty_180d REAL,
      return_item_qty_180d REAL,
      shipped_qty_180d REAL,
      paid_return_chain_ratio REAL,
      paid_return_chain_percent REAL,
      gross_margin_7d REAL,
      gross_margin_30d REAL,
      sent_send_refund_afs_item_qty_rate_pre3to5 REAL,
      sent_send_refund_afs_item_qty_rate_pre5to7 REAL,
      sent_send_refund_afs_item_qty_rate_pre7to15 REAL,
      sent_send_refund_afs_item_qty_rate_pre15to30 REAL,
      sent_send_refund_afs_item_qty_rate_pre7to180 REAL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, platform)
    );

    CREATE TABLE shop_product_sales_analysis (
      spu_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      shop_name TEXT,
      platform TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      previous_start_date TEXT NOT NULL,
      previous_end_date TEXT NOT NULL,
      pay_qty_today REAL,
      pay_qty_3d REAL,
      pay_qty_7d REAL,
      pay_qty_15d REAL,
      pay_qty_30d REAL,
      sales_qty REAL,
      previous_sales_qty REAL,
      sales_increase REAL,
      sales_chain_ratio REAL,
      sales_chain_percent REAL,
      sales_amount REAL,
      previous_sales_amount REAL,
      sales_amount_increase REAL,
      sales_amount_chain_ratio REAL,
      sales_amount_chain_percent REAL,
      order_count REAL,
      previous_order_count REAL,
      order_count_increase REAL,
      order_count_chain_ratio REAL,
      order_count_chain_percent REAL,
      paid_return_qty REAL,
      paid_return_qty_180d REAL,
      return_item_qty_180d REAL,
      shipped_qty_180d REAL,
      paid_return_chain_ratio REAL,
      paid_return_chain_percent REAL,
      gross_margin_7d REAL,
      gross_margin_30d REAL,
      sent_send_refund_afs_item_qty_rate_pre3to5 REAL,
      sent_send_refund_afs_item_qty_rate_pre5to7 REAL,
      sent_send_refund_afs_item_qty_rate_pre7to15 REAL,
      sent_send_refund_afs_item_qty_rate_pre15to30 REAL,
      sent_send_refund_afs_item_qty_rate_pre7to180 REAL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, shop_id)
    );

    CREATE TABLE IF NOT EXISTS product_daily_sales_analysis (
      spu_id TEXT NOT NULL,
      biz_date TEXT NOT NULL,
      sales_qty REAL NOT NULL,
      sales_amount REAL NOT NULL,
      order_count REAL NOT NULL,
      net_sales_amount REAL NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, biz_date)
    );

    CREATE TABLE link_product_sales_analysis (
      spu_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      shop_name TEXT,
      platform TEXT,
      shop_spu_id TEXT NOT NULL,
      shop_i_id TEXT,
      shop_spu_name TEXT,
      shop_spu_pic TEXT,
      shop_spu_created TEXT,
      shop_spu_created_day REAL,
      shop_sku_id TEXT,
      shop_sku_url TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      previous_start_date TEXT NOT NULL,
      previous_end_date TEXT NOT NULL,
      pay_qty_today REAL,
      pay_qty_3d REAL,
      pay_qty_7d REAL,
      pay_qty_15d REAL,
      pay_qty_30d REAL,
      sales_qty REAL,
      previous_sales_qty REAL,
      sales_increase REAL,
      sales_chain_ratio REAL,
      sales_chain_percent REAL,
      sales_amount REAL,
      previous_sales_amount REAL,
      sales_amount_increase REAL,
      sales_amount_chain_ratio REAL,
      sales_amount_chain_percent REAL,
      order_count REAL,
      previous_order_count REAL,
      order_count_increase REAL,
      order_count_chain_ratio REAL,
      order_count_chain_percent REAL,
      paid_return_qty REAL,
      paid_return_qty_180d REAL,
      return_item_qty_180d REAL,
      shipped_qty_180d REAL,
      paid_return_chain_ratio REAL,
      paid_return_chain_percent REAL,
      gross_margin_7d REAL,
      gross_margin_30d REAL,
      sent_send_refund_afs_item_qty_rate_pre3to5 REAL,
      sent_send_refund_afs_item_qty_rate_pre5to7 REAL,
      sent_send_refund_afs_item_qty_rate_pre7to15 REAL,
      sent_send_refund_afs_item_qty_rate_pre15to30 REAL,
      sent_send_refund_afs_item_qty_rate_pre7to180 REAL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, shop_id, shop_spu_id)
    );

    CREATE TABLE IF NOT EXISTS shop_daily_sales_analysis (
      spu_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      biz_date TEXT NOT NULL,
      sales_qty REAL NOT NULL,
      sales_amount REAL NOT NULL,
      order_count REAL NOT NULL,
      return_item_qty REAL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, shop_id, biz_date)
    );

    CREATE INDEX shop_product_sales_analysis_shop_idx
      ON shop_product_sales_analysis(shop_id, sales_qty DESC);
    CREATE INDEX shop_product_sales_analysis_sales_idx
      ON shop_product_sales_analysis(sales_qty DESC);
    CREATE INDEX IF NOT EXISTS product_daily_sales_analysis_date_idx
      ON product_daily_sales_analysis(biz_date, sales_qty DESC);
    CREATE INDEX platform_product_sales_analysis_sales_idx
      ON platform_product_sales_analysis(platform, sales_qty DESC);
    CREATE INDEX link_product_sales_analysis_shop_idx
      ON link_product_sales_analysis(shop_id, sales_qty DESC);
    CREATE INDEX IF NOT EXISTS shop_daily_sales_analysis_date_shop_idx
      ON shop_daily_sales_analysis(biz_date, shop_id, sales_qty DESC);
  `);
}

// A first inventory-only sync must not fan out into every sales drawer merely
// to initialize the upload contract. These empty tables need no upstream calls.
export function initializeEmptySalesAnalysis({ outputPath }) {
  const db = new DatabaseSync(outputPath);
  try { createSchema(db); } finally { db.close(); }
}

function directValues(result, row, includePayQuantities = true) {
  const values = [
    result.start_date,
    result.end_date,
    result.previous_start_date,
    result.previous_end_date,
    row.sales_qty,
    null,
    row.sales_increase ?? row.order_item_qty_increase ?? null,
    row.sales_chain_ratio,
    null,
    row.sales_amount,
    null,
    row.sales_amount_increase,
    row.sales_amount_chain_ratio,
    null,
    row.order_count,
    null,
    row.order_count_increase,
    row.order_count_chain_ratio,
    null,
    row.paid_return_qty,
    row.paid_return_qty_180d,
    row.return_item_qty_180d ?? null,
    row.shipped_qty_180d,
    row.paid_return_chain_ratio,
    null,
    row.gross_margin_7d ?? null,
    row.gross_margin_30d ?? null,
    row.sent_send_refund_afs_item_qty_rate_pre3to5 ?? null,
    row.sent_send_refund_afs_item_qty_rate_pre5to7 ?? null,
    row.sent_send_refund_afs_item_qty_rate_pre7to15 ?? null,
    row.sent_send_refund_afs_item_qty_rate_pre15to30 ?? null,
    row.sent_send_refund_afs_item_qty_rate_pre7to180 ?? null,
    JSON.stringify(row),
  ];
  if (!includePayQuantities) return values;
  values.splice(4, 0,
    row.pay_qty_today ?? null, row.pay_qty_3d ?? null,
    row.pay_qty_7d ?? null, row.pay_qty_15d ?? null, row.pay_qty_30d ?? null);
  return values;
}

function mergePayQuantities(result, quantityResult, key) {
  const columns = Array.isArray(key) ? key : [key];
  const rowKey = (row) => columns.map((column) => String(row[column] ?? "")).join("\u0000");
  const quantities = new Map(quantityResult.rows.map((row) => [rowKey(row), row]));
  const sourceRows = result.rows ?? result.shops ?? [];
  const merged = sourceRows.map((row) => ({ ...row, ...(quantities.get(rowKey(row)) ?? {}) }));
  return {
    ...result,
    ...(result.rows ? { rows: merged } : {}),
    ...(result.shops ? { shops: merged } : {}),
  };
}

function insertRows(statement, result) {
  let inserted = 0;
  for (const row of result.shops) {
    const shopId = String(row.shop_id ?? "");
    if (!shopId) continue;
    statement.run(
      result.spu_id,
      shopId,
      row.shop_name ?? null,
      row.platform ?? null,
      ...directValues(result, row),
    );
    inserted += 1;
  }
  return inserted;
}

function insertPlatformRows(statement, result) {
  let inserted = 0;
  for (const row of result.rows) {
    const platform = String(row.platform ?? "");
    if (!platform) continue;
    statement.run(result.spu_id, platform, ...directValues(result, row));
    inserted += 1;
  }
  return inserted;
}

function insertLinkRows(statement, result) {
  let inserted = 0;
  for (const row of result.rows) {
    const shopId = String(row.shop_id ?? "");
    const shopSpuId = String(row.shop_spu_id ?? "");
    if (!shopId || !shopSpuId) continue;
    statement.run(
      result.spu_id,
      shopId,
      row.shop_name ?? null,
      row.platform ?? null,
      shopSpuId,
      row.shop_i_id == null ? null : String(row.shop_i_id),
      row.shop_spu_name ?? null,
      row.shop_spu_pic ?? null,
      row.shop_spu_created ?? null,
      row.shop_spu_created_day ?? null,
      row.shop_sku_id == null ? null : String(row.shop_sku_id),
      row.shop_sku_url ?? null,
      ...directValues(result, row),
    );
    inserted += 1;
  }
  return inserted;
}

export function copySalesAnalysisFromSqlite({ sourcePath, outputPath }) {
  const source = resolve(sourcePath);
  const output = resolve(outputPath);
  if (source === output) throw new Error("sales analysis source must differ from output");
  if (!existsSync(source)) throw new Error("sales analysis source is missing");
  mkdirSync(dirname(output), { recursive: true });
  const db = new DatabaseSync(output);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; BEGIN IMMEDIATE;");
  try {
    createSchema(db);
    db.prepare("ATTACH DATABASE ? AS sales_source").run(source);
    const counts = {};
    for (const table of SALES_ANALYSIS_TABLES) {
      const sourceColumns = db.prepare(`PRAGMA sales_source.table_info(${qi(table)})`).all()
        .map((row) => row.name);
      const targetColumns = db.prepare(`PRAGMA main.table_info(${qi(table)})`).all()
        .map((row) => row.name);
      const allowedMissing = COMPATIBLE_MISSING_COLUMNS[table] ?? new Set();
      const missing = targetColumns.filter((column) => !sourceColumns.includes(column));
      const extra = sourceColumns.filter((column) => !targetColumns.includes(column));
      if (sourceColumns.length === 0 && COMPATIBLE_MISSING_TABLES.has(table)) {
        db.exec(`DELETE FROM main.${qi(table)}`);
        counts[table] = 0;
        continue;
      }
      if (sourceColumns.length === 0
        || extra.length > 0
        || missing.some((column) => !allowedMissing.has(column))) {
        throw new Error(`sales analysis schema mismatch: ${table}`);
      }
      const columns = targetColumns.map(qi).join(",");
      const selectColumns = targetColumns.map((column) => (
        sourceColumns.includes(column)
          ? qi(column)
          : `${COMPATIBLE_MISSING_VALUES[table]?.[column] ?? "NULL"} AS ${qi(column)}`
      )).join(",");
      db.exec(`DELETE FROM main.${qi(table)}`);
      db.exec(`INSERT INTO main.${qi(table)}(${columns}) SELECT ${selectColumns} FROM sales_source.${qi(table)}`);
      counts[table] = Number(db.prepare(`SELECT count(*) AS count FROM main.${qi(table)}`).get().count);
    }
    db.exec("COMMIT;");
    return { output, source, tables: counts };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare(
    "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name));
}

function hasMatchingCheckpoint(db, { days, endDate, startDate, totalSpus }) {
  if (!hasTable(db, "sales_analysis_checkpoint")
    || !hasTable(db, "sales_analysis_checkpoint_spu")) return false;
  const checkpoint = db.prepare("SELECT * FROM sales_analysis_checkpoint WHERE id = 1").get();
  return checkpoint?.schema_version === SALES_ANALYSIS_SCHEMA_VERSION
    && checkpoint.period_days === days
    && checkpoint.start_date === startDate
    && checkpoint.end_date === endDate
    && checkpoint.total_spus === totalSpus;
}

function initializeCheckpoint(db, { days, endDate, range, totalSpus, startedAt }) {
  db.exec("BEGIN IMMEDIATE;");
  try {
    createSchema(db);
    db.prepare(`
      INSERT INTO sales_analysis_checkpoint (
        id, schema_version, period_days, start_date, end_date, total_spus, started_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
    `).run(
      SALES_ANALYSIS_SCHEMA_VERSION,
      days,
      range.startDate,
      endDate,
      totalSpus,
      startedAt.toISOString(),
    );
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function tableCount(db, table) {
  return Number(db.prepare(`SELECT count(*) AS count FROM ${qi(table)}`).get().count);
}

export async function appendSalesAnalysisToSqlite({
  session,
  outputPath,
  days = 30,
  endDate = yesterdayShanghai(),
  pageSize = 100,
  concurrency = 2,
  onProgress = () => {},
  fetchAnalysis = (spuId) => getAllShopSalesAnalysis({
    session,
    spuId,
    days,
    endDate,
    pageSize,
  }),
  fetchPlatform = (spuId) => getAllSalesAnalysisDimension({
    session,
    spuId,
    days,
    endDate,
    pageSize,
    countType: "platform",
  }),
  fetchLink = (spuId) => getAllSalesAnalysisDimension({
    session,
    spuId,
    days,
    endDate,
    pageSize,
    countType: "link",
  }),
  fetchPlatformQty = (spuId) => Array.isArray(session?.cookies)
    ? getAllSaleChannel({ session, spuId, countType: "platform", pageSize })
    : Promise.resolve({ rows: [] }),
  fetchChannelQty = (spuId) => Array.isArray(session?.cookies)
    ? getAllSaleChannel({ session, spuId, countType: "channel", pageSize })
    : Promise.resolve({ rows: [] }),
  fetchLinkQty = (spuId) => Array.isArray(session?.cookies)
    ? getAllLinkPayQuantities({ session, spuId, pageSize })
    : Promise.resolve({ rows: [] }),
}) {
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const startedAt = new Date();
  const range = salesAnalysisDateRange({ days, endDate });
  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL;");
  try {
    const inventoryTable = db.prepare(
      "SELECT 1 found FROM sqlite_master WHERE type = 'table' AND name = 'spu_inventory'",
    ).get();
    if (!inventoryTable) throw new Error("spu_inventory table is required");
    const spuIds = db.prepare("SELECT spu_id FROM spu_inventory ORDER BY spu_id").all()
      .map((row) => String(row.spu_id));
    const resumed = hasMatchingCheckpoint(db, {
      days,
      endDate,
      startDate: range.startDate,
      totalSpus: spuIds.length,
    });
    if (!resumed) initializeCheckpoint(db, {
      days,
      endDate,
      range,
      totalSpus: spuIds.length,
      startedAt,
    });
    const insert = db.prepare(`
      INSERT OR REPLACE INTO shop_product_sales_analysis (
        spu_id, shop_id, shop_name, platform, start_date, end_date,
        previous_start_date, previous_end_date, pay_qty_today, pay_qty_3d,
        pay_qty_7d, pay_qty_15d, pay_qty_30d, sales_qty, previous_sales_qty,
        sales_increase, sales_chain_ratio, sales_chain_percent, sales_amount,
        previous_sales_amount, sales_amount_increase, sales_amount_chain_ratio,
        sales_amount_chain_percent, order_count, previous_order_count,
        order_count_increase, order_count_chain_ratio, order_count_chain_percent,
        paid_return_qty, paid_return_qty_180d, return_item_qty_180d, shipped_qty_180d,
        paid_return_chain_ratio, paid_return_chain_percent, gross_margin_7d,
        gross_margin_30d, sent_send_refund_afs_item_qty_rate_pre3to5,
        sent_send_refund_afs_item_qty_rate_pre5to7,
        sent_send_refund_afs_item_qty_rate_pre7to15,
        sent_send_refund_afs_item_qty_rate_pre15to30,
        sent_send_refund_afs_item_qty_rate_pre7to180, raw_json
      ) VALUES (${Array.from({ length: 42 }, () => "?").join(", ")})
    `);
    const insertPlatform = db.prepare(`
      INSERT OR REPLACE INTO platform_product_sales_analysis (
        spu_id, platform, start_date, end_date, previous_start_date,
        previous_end_date, pay_qty_today, pay_qty_3d, pay_qty_7d, pay_qty_15d,
        pay_qty_30d, sales_qty, previous_sales_qty, sales_increase,
        sales_chain_ratio, sales_chain_percent, sales_amount,
        previous_sales_amount, sales_amount_increase, sales_amount_chain_ratio,
        sales_amount_chain_percent, order_count, previous_order_count,
        order_count_increase, order_count_chain_ratio, order_count_chain_percent,
        paid_return_qty, paid_return_qty_180d, return_item_qty_180d, shipped_qty_180d,
        paid_return_chain_ratio, paid_return_chain_percent, gross_margin_7d,
        gross_margin_30d, sent_send_refund_afs_item_qty_rate_pre3to5,
        sent_send_refund_afs_item_qty_rate_pre5to7,
        sent_send_refund_afs_item_qty_rate_pre7to15,
        sent_send_refund_afs_item_qty_rate_pre15to30,
        sent_send_refund_afs_item_qty_rate_pre7to180, raw_json
      ) VALUES (${Array.from({ length: 40 }, () => "?").join(", ")})
    `);
    const insertLink = db.prepare(`
      INSERT OR REPLACE INTO link_product_sales_analysis (
        spu_id, shop_id, shop_name, platform, shop_spu_id, shop_i_id,
        shop_spu_name, shop_spu_pic, shop_spu_created, shop_spu_created_day,
        shop_sku_id, shop_sku_url, start_date, end_date, previous_start_date,
        previous_end_date, pay_qty_today, pay_qty_3d, pay_qty_7d, pay_qty_15d,
        pay_qty_30d, sales_qty, previous_sales_qty, sales_increase,
        sales_chain_ratio, sales_chain_percent, sales_amount,
        previous_sales_amount, sales_amount_increase, sales_amount_chain_ratio,
        sales_amount_chain_percent, order_count, previous_order_count,
        order_count_increase, order_count_chain_ratio, order_count_chain_percent,
        paid_return_qty, paid_return_qty_180d, return_item_qty_180d, shipped_qty_180d,
        paid_return_chain_ratio, paid_return_chain_percent, gross_margin_7d,
        gross_margin_30d, sent_send_refund_afs_item_qty_rate_pre3to5,
        sent_send_refund_afs_item_qty_rate_pre5to7,
        sent_send_refund_afs_item_qty_rate_pre7to15,
        sent_send_refund_afs_item_qty_rate_pre15to30,
        sent_send_refund_afs_item_qty_rate_pre7to180, raw_json
      ) VALUES (${Array.from({ length: 50 }, () => "?").join(", ")})
    `);
    const insertCheckpoint = db.prepare(
      "INSERT OR REPLACE INTO sales_analysis_checkpoint_spu (spu_id, completed_at) VALUES (?, ?)",
    );
    const completedSpus = new Set(db.prepare(
      "SELECT spu_id FROM sales_analysis_checkpoint_spu",
    ).all().map((row) => String(row.spu_id)));
    const pendingSpuIds = spuIds.filter((spuId) => !completedSpus.has(spuId));
    let fetchedSpus = completedSpus.size;
    let fetchedShopRows = tableCount(db, "shop_product_sales_analysis");
    let fetchedPlatformRows = tableCount(db, "platform_product_sales_analysis");
    let fetchedLinkRows = tableCount(db, "link_product_sales_analysis");
    let fetchedDailyRows = tableCount(db, "product_daily_sales_analysis");
    let fetchedShopDailyRows = tableCount(db, "shop_daily_sales_analysis");
    for (let offset = 0; offset < pendingSpuIds.length; offset += concurrency) {
      const batch = pendingSpuIds.slice(offset, offset + concurrency);
      const results = await Promise.all(batch.map(async (spuId) => {
        const [shopsBase, platformBase, link] = await Promise.all([
          fetchAnalysis(spuId),
          fetchPlatform(spuId),
          fetchLink(spuId),
        ]);
        const shopRows = shopsBase.shops ?? shopsBase.rows ?? [];
        const platformRows = platformBase.rows ?? [];
        const linkRows = link.rows ?? [];
        const [channelQty, platformQty, linkQty] = await Promise.all([
          shopRows.length > 0 ? fetchChannelQty(spuId) : Promise.resolve({ rows: [] }),
          platformRows.length > 0 ? fetchPlatformQty(spuId) : Promise.resolve({ rows: [] }),
          linkRows.length > 0 ? fetchLinkQty(spuId) : Promise.resolve({ rows: [] }),
        ]);
        return {
          shops: mergePayQuantities(shopsBase, channelQty, "shop_id"),
          platform: mergePayQuantities(platformBase, platformQty, "platform"),
          link: mergePayQuantities(link, linkQty, ["shop_id", "shop_spu_id"]),
        };
      }));
      db.exec("BEGIN IMMEDIATE;");
      try {
        for (let index = 0; index < results.length; index += 1) {
          const result = results[index];
          fetchedShopRows += insertRows(insert, result.shops);
          fetchedPlatformRows += insertPlatformRows(insertPlatform, result.platform);
          fetchedLinkRows += insertLinkRows(insertLink, result.link);
          insertCheckpoint.run(batch[index], new Date().toISOString());
        }
        db.exec("COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK;");
        throw error;
      }
      fetchedSpus += batch.length;
      onProgress({
        fetchedSpus,
        totalSpus: spuIds.length,
        fetchedRows: fetchedShopRows,
        fetchedShopRows,
        fetchedPlatformRows,
        fetchedLinkRows,
        fetchedDailyRows,
        fetchedShopDailyRows,
      });
    }

    const checkpointStartedAt = db.prepare(
      "SELECT started_at FROM sales_analysis_checkpoint WHERE id = 1",
    ).get().started_at;
    const completedAt = new Date();
    const durationMs = Math.round(completedAt.valueOf() - new Date(checkpointStartedAt).valueOf());
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
        INSERT INTO sales_analysis_export_info (
          id, schema_version, started_at, completed_at, duration_ms, period_days,
          start_date, end_date, previous_start_date, previous_end_date, total_spus,
          fetched_spus, fetched_rows, fetched_platform_rows, fetched_link_rows,
          fetched_daily_rows, fetched_shop_daily_rows, page_size, concurrency
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        SALES_ANALYSIS_SCHEMA_VERSION,
        checkpointStartedAt, completedAt.toISOString(), durationMs, days,
        range.startDate, range.endDate, range.preStartDate, range.preEndDate,
        spuIds.length, fetchedSpus, fetchedShopRows, fetchedPlatformRows, fetchedLinkRows,
        fetchedDailyRows, fetchedShopDailyRows,
        pageSize, concurrency,
      );
      db.exec("DROP TABLE sales_analysis_checkpoint_spu; DROP TABLE sales_analysis_checkpoint;");
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
    return {
      output: resolvedPath,
      duration_ms: durationMs,
      period_days: days,
      start_date: range.startDate,
      end_date: range.endDate,
      total_spus: spuIds.length,
      fetched_spus: fetchedSpus,
      fetched_rows: fetchedShopRows,
      fetched_shop_rows: fetchedShopRows,
      fetched_platform_rows: fetchedPlatformRows,
      fetched_link_rows: fetchedLinkRows,
      fetched_daily_rows: fetchedDailyRows,
      fetched_shop_daily_rows: fetchedShopDailyRows,
      resumed,
      page_size: pageSize,
      concurrency,
    };
  } catch (error) {
    throw error;
  } finally {
    db.close();
  }
}
