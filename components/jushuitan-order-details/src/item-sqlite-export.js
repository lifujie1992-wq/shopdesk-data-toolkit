import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_PAGE_SIZE, fetchOrderPage, fetchOrderSummary } from "./api.js";

const ITEM_FIELDS = [
  "after_confirm_date", "after_created", "after_io_date", "aftersale_type", "as_id",
  "base_amount", "brand_name", "buyer_id", "buyer_message", "category", "combine_sku_id",
  "cost_price", "creator_name", "drp_co_from_name", "drp_co_to_name", "dw_io_ids",
  "dw_pay_amount", "free_amount", "freight_cost", "freight_price_share", "freight_revenue",
  "freight_share", "gross_margin", "gross_margin_rate", "i_id", "io_ids", "l_id", "labels",
  "logistics_company", "mainCoid", "market_price", "name", "node", "o_id",
  "oi_activity_u_id", "oi_activity_u_name", "oi_is_presale", "oi_item_end_time", "oi_name",
  "oi_outer_oi_id", "oi_properties_value", "oi_raw_so_id", "oi_referrer_id",
  "oi_referrer_name", "oi_shop_i_id", "oi_shop_sku_id", "order_amt", "order_date",
  "order_qty", "order_type", "outer_so_id", "pay_date", "platform", "properties_value",
  "purchase_price", "question_type", "r_refund_amt", "r_refund_cost", "r_refund_qty",
  "r_sent_amt", "r_sent_cost", "r_sent_qty", "receiver_city", "receiver_district",
  "receiver_name", "receiver_state", "refund_amt", "refund_cost", "refund_qty", "remark",
  "sale_price", "seller_flag", "send_date", "shop_id", "shop_name", "short_name", "sku_cost",
  "sku_id", "sku_price", "sku_row_number", "so_id", "status", "supplier_i_id", "supplier_id",
  "supplier_name", "supplier_sku_id", "vc_name", "wms_co_name",
];

const NUMBER_FIELDS = new Set([
  "base_amount", "cost_price", "dw_pay_amount", "free_amount", "freight_cost",
  "freight_price_share", "freight_revenue", "freight_share", "gross_margin",
  "gross_margin_rate", "market_price", "order_amt", "order_qty", "purchase_price",
  "r_refund_amt", "r_refund_cost", "r_refund_qty", "r_sent_amt", "r_sent_cost", "r_sent_qty",
  "refund_amt", "refund_cost", "refund_qty", "sale_price", "sku_cost", "sku_price",
  "sku_row_number",
]);

function qi(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function rowKey(row) {
  return JSON.stringify([
    String(row.o_id ?? ""),
    String(row.sku_id ?? ""),
    String(row.oi_shop_sku_id ?? ""),
    String(row.oi_outer_oi_id ?? ""),
  ]);
}

function value(row, field) {
  const result = row[field];
  if (result === null || result === undefined) return null;
  if (typeof result === "object") return JSON.stringify(result);
  if (NUMBER_FIELDS.has(field)) {
    const parsed = Number(result);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return String(result);
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE order_item_details (
      row_key TEXT PRIMARY KEY,
      ${ITEM_FIELDS.map((field) => `${qi(field)} ${NUMBER_FIELDS.has(field) ? "REAL" : "TEXT"}`).join(",\n")},
      raw_json TEXT NOT NULL
    );
    CREATE TABLE item_sync_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      source_total INTEGER NOT NULL,
      fetched_rows INTEGER NOT NULL,
      saved_rows INTEGER NOT NULL,
      pages INTEGER NOT NULL,
      page_size INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      summary_json TEXT NOT NULL
    );
  `);
}

function insertRows(statement, rows) {
  for (const row of rows) {
    if (row.o_id == null || row.sku_id == null) continue;
    statement.run(rowKey(row), ...ITEM_FIELDS.map((field) => value(row, field)), JSON.stringify(row));
  }
}

export async function exportOrderItemsToSqlite({
  session,
  range,
  outputPath,
  pageSize = DEFAULT_PAGE_SIZE,
  concurrency = 3,
  mergeFromPath = null,
  append = false,
  onProgress = () => {},
  fetchPage = (page) => fetchOrderPage(session, range, page, pageSize, "item"),
  fetchSummary = () => fetchOrderSummary(session, range, "item"),
}) {
  const output = resolve(outputPath);
  const temporary = `${output}.tmp-${process.pid}`;
  mkdirSync(dirname(output), { recursive: true });
  if (!append) rmSync(temporary, { force: true });
  const startedAt = new Date();
  const started = performance.now();
  if (append && !existsSync(output)) throw new Error("append target is missing");
  const databasePath = append ? output : temporary;
  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec(append
    ? "PRAGMA journal_mode=DELETE; PRAGMA synchronous=NORMAL; BEGIN IMMEDIATE;"
    : "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;");
  try {
    if (append) db.exec("DROP TABLE IF EXISTS item_sync_info; DROP TABLE IF EXISTS order_item_details;");
    createSchema(db);
    let preservedRows = 0;
    if (mergeFromPath) {
      const source = resolve(mergeFromPath);
      if (!existsSync(source)) throw new Error("merge source is missing");
      db.prepare("ATTACH DATABASE ? AS previous").run(source);
      const sourceColumns = db.prepare("PRAGMA previous.table_info(order_item_details)").all()
        .map((row) => row.name);
      const targetColumns = db.prepare("PRAGMA main.table_info(order_item_details)").all()
        .map((row) => row.name);
      if (sourceColumns.length > 0 && sourceColumns.join("\0") !== targetColumns.join("\0")) {
        throw new Error("merge source schema mismatch");
      }
      if (sourceColumns.length > 0) {
        const columns = targetColumns.map(qi).join(",");
        db.prepare(`INSERT INTO order_item_details (${columns}) SELECT ${columns}
          FROM previous.order_item_details
          WHERE send_date IS NULL OR substr(send_date, 1, 10) < ? OR substr(send_date, 1, 10) > ?`)
          .run(range.start_date, range.end_date);
      }
      preservedRows = Number(db.prepare("SELECT count(*) count FROM order_item_details").get().count);
    }
    const columns = ["row_key", ...ITEM_FIELDS, "raw_json"];
    const insert = db.prepare(`INSERT OR REPLACE INTO order_item_details
      (${columns.map(qi).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
    const [first, summary] = await Promise.all([fetchPage(1), fetchSummary()]);
    const total = Number(first.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let fetchedRows = first.data?.length ?? 0;
    if (!append) db.exec("BEGIN;");
    insertRows(insert, first.data ?? []);
    for (let firstPage = 2; firstPage <= pages; firstPage += concurrency) {
      const numbers = Array.from(
        { length: Math.min(concurrency, pages - firstPage + 1) },
        (_, index) => firstPage + index,
      );
      const payloads = await Promise.all(numbers.map(fetchPage));
      for (const payload of payloads) {
        const rows = payload.data ?? [];
        fetchedRows += rows.length;
        insertRows(insert, rows);
      }
      onProgress({ completedPages: numbers.at(-1), pages, fetchedRows });
    }
    const savedRows = Number(db.prepare("SELECT count(*) count FROM order_item_details").get().count);
    const completedAt = new Date();
    const durationMs = Math.round(performance.now() - started);
    db.prepare(`INSERT INTO item_sync_info (
      id, schema_version, started_at, completed_at, duration_ms, start_date, end_date,
      source_total, fetched_rows, saved_rows, pages, page_size, concurrency, summary_json
    ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(startedAt.toISOString(), completedAt.toISOString(), durationMs,
        range.start_date, range.end_date, total, fetchedRows, savedRows, pages,
        pageSize, concurrency, JSON.stringify(summary.data ?? []));
    db.exec("COMMIT;");
    db.exec(`
      CREATE INDEX order_item_details_send_date_idx ON order_item_details(send_date);
      CREATE INDEX order_item_details_order_idx ON order_item_details(o_id);
      CREATE INDEX order_item_details_sku_idx ON order_item_details(sku_id);
      CREATE INDEX order_item_details_shop_idx ON order_item_details(shop_id);
    `);
    db.close();
    chmodSync(databasePath, 0o600);
    if (!append) renameSync(temporary, output);
    return {
      output, start_date: range.start_date, end_date: range.end_date, total,
      fetched_rows: fetchedRows, saved_rows: savedRows, pages, duration_ms: durationMs,
      size_bytes: statSync(output).size, preserved_rows: preservedRows,
      incremental: Boolean(mergeFromPath), appended: append, dimension: "item",
    };
  } catch (error) {
    try { db.close(); } catch {}
    if (!append) rmSync(temporary, { force: true });
    throw error;
  }
}

export { ITEM_FIELDS };
