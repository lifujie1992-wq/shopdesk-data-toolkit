import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DEFAULT_PAGE_SIZE, fetchOrderPage, fetchOrderSummary } from "./api.js";

const COLUMN_DEFS = {
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
};

const COLUMNS = Object.keys(COLUMN_DEFS);
const TEXT_IDS = new Set(["o_id", "sku_id", "so_id", "mainCoid", "outer_so_id", "l_id"]);

function sqliteValue(name, value) {
  if (value === null || value === undefined) return null;
  if (TEXT_IDS.has(name)) return String(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return Number(value);
  return value;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE order_details (
      ${Object.entries(COLUMN_DEFS).map(([name, type]) => `"${name}" ${type}`).join(",\n")}
    );
    CREATE TABLE sync_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
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

function prepareInsert(db) {
  return db.prepare(`
    INSERT OR REPLACE INTO order_details (${COLUMNS.map((name) => `"${name}"`).join(",")})
    VALUES (${COLUMNS.map(() => "?").join(",")})
  `);
}

function insertRows(statement, rows) {
  for (const row of rows) {
    if (row.o_id === null || row.o_id === undefined || row.o_id === "") continue;
    statement.run(...COLUMNS.map((name) => sqliteValue(name, row[name])));
  }
}

export async function exportOrdersToSqlite({
  session,
  range,
  outputPath,
  pageSize = DEFAULT_PAGE_SIZE,
  concurrency = 3,
  mergeFromPath = null,
  dimension = "order",
  onProgress = () => {},
  fetchPage = (page) => fetchOrderPage(session, range, page, pageSize, dimension),
  fetchSummary = () => fetchOrderSummary(session, range, dimension),
}) {
  const output = resolve(outputPath);
  const temporary = `${output}.tmp-${process.pid}`;
  mkdirSync(dirname(output), { recursive: true });
  rmSync(temporary, { force: true });
  const startedAt = new Date();
  const started = performance.now();
  const db = new DatabaseSync(temporary);
  chmodSync(temporary, 0o600);
  db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY;");

  try {
    createSchema(db);
    let preservedRows = 0;
    if (mergeFromPath) {
      const mergeSource = resolve(mergeFromPath);
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
    const insert = prepareInsert(db);
    const [first, summary] = await Promise.all([fetchPage(1), fetchSummary()]);
    const total = Number(first.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let fetchedRows = first.data?.length ?? 0;
    db.exec("BEGIN;");
    insertRows(insert, first.data ?? []);

    for (let firstPage = 2; firstPage <= pages; firstPage += concurrency) {
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, pages - firstPage + 1) },
        (_, index) => firstPage + index,
      );
      const payloads = await Promise.all(pageNumbers.map(fetchPage));
      for (const payload of payloads) {
        const rows = payload.data ?? [];
        fetchedRows += rows.length;
        insertRows(insert, rows);
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
    db.exec(`
      CREATE INDEX order_details_send_date_idx ON order_details(send_date);
      CREATE INDEX order_details_shop_idx ON order_details(shop_name);
      CREATE INDEX order_details_so_id_idx ON order_details(so_id);
      CREATE INDEX order_details_outer_so_id_idx ON order_details(outer_so_id);
    `);
    db.close();
    chmodSync(temporary, 0o600);
    renameSync(temporary, output);
    return {
      output,
      start_date: range.start_date,
      end_date: range.end_date,
      total,
      fetched_rows: fetchedRows,
      saved_rows: savedRows,
      pages,
      duration_ms: durationMs,
      size_bytes: statSync(output).size,
      preserved_rows: preservedRows,
      incremental: Boolean(mergeFromPath),
    };
  } catch (error) {
    try { db.close(); } catch {}
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function readOrderSummary(outputPath) {
  const db = new DatabaseSync(resolve(outputPath), { readOnly: true });
  try {
    const info = db.prepare("SELECT * FROM sync_info WHERE id = 1").get();
    return { ...info, summary: JSON.parse(info.summary_json), summary_json: undefined };
  } finally {
    db.close();
  }
}

export function readOrders(outputPath, limit) {
  const db = new DatabaseSync(resolve(outputPath), { readOnly: true });
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
