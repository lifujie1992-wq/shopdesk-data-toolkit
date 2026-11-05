import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  enrichShopShortageRows,
  getShopShortageSummary,
} from "./shop-shortage.js";

function createSchema(db, { dropLegacyExportInfo = false } = {}) {
  const legacyColumns = dropLegacyExportInfo
    ? db.prepare("PRAGMA table_info(export_info)").all().map((column) => column.name)
    : [];
  const dropLegacy = legacyColumns.includes("urgent_definition")
    ? "DROP TABLE IF EXISTS export_info;"
    : "";
  db.exec(`
    ${dropLegacy}
    DROP TABLE IF EXISTS shop_shortage_export_info;
    DROP TABLE IF EXISTS shop_shortage_summary;
    DROP TABLE IF EXISTS shop_stockout_warning;

    CREATE TABLE shop_shortage_export_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      api_total_links INTEGER NOT NULL,
      fetched_links INTEGER NOT NULL,
      fetched_shops INTEGER NOT NULL,
      pages INTEGER NOT NULL,
      page_size INTEGER NOT NULL,
      concurrency INTEGER NOT NULL,
      urgent_definition TEXT NOT NULL
    );

    CREATE TABLE shop_stockout_warning (
      shop_id TEXT NOT NULL,
      shop_name TEXT,
      platform TEXT,
      shop_type TEXT,
      shop_spu_id TEXT NOT NULL,
      shop_spu_name TEXT,
      shop_sku_url TEXT,
      shop_sku_cnt REAL,
      shop_stockout_qty REAL NOT NULL,
      shop_urgent_stockout_qty REAL NOT NULL,
      shop_no_sent_qty REAL NOT NULL,
      timeout_qty REAL NOT NULL,
      due_within_1d_qty REAL NOT NULL,
      no_sent_order_cnt REAL,
      timeout_order_cnt REAL,
      due_within_1d_order_cnt REAL,
      real_qty REAL,
      onway_qty REAL,
      purchase_qty REAL,
      children_json TEXT,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (shop_id, shop_spu_id)
    );

    CREATE TABLE shop_shortage_summary (
      shop_id TEXT PRIMARY KEY,
      shop_name TEXT,
      platform TEXT,
      shop_type TEXT,
      link_count INTEGER NOT NULL,
      shop_stockout_qty REAL NOT NULL,
      shop_urgent_stockout_qty REAL NOT NULL,
      shop_no_sent_qty REAL NOT NULL,
      timeout_qty REAL NOT NULL,
      due_within_1d_qty REAL NOT NULL
    );

    CREATE INDEX shop_stockout_warning_shop_name_idx
      ON shop_stockout_warning(shop_name);
    CREATE INDEX shop_stockout_warning_stockout_idx
      ON shop_stockout_warning(shop_stockout_qty DESC);
    CREATE INDEX shop_shortage_summary_stockout_idx
      ON shop_shortage_summary(shop_stockout_qty DESC);
  `);
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function prepareStatements(db) {
  return {
    detail: db.prepare(`
      INSERT OR REPLACE INTO shop_stockout_warning (
        shop_id, shop_name, platform, shop_type, shop_spu_id, shop_spu_name,
        shop_sku_url, shop_sku_cnt, shop_stockout_qty, shop_urgent_stockout_qty,
        shop_no_sent_qty, timeout_qty, due_within_1d_qty, no_sent_order_cnt,
        timeout_order_cnt, due_within_1d_order_cnt, real_qty, onway_qty,
        purchase_qty, children_json, raw_json
      ) VALUES (${Array.from({ length: 21 }, () => "?").join(", ")})
    `),
    summary: db.prepare(`
      INSERT INTO shop_shortage_summary (
        shop_id, shop_name, platform, shop_type, link_count, shop_stockout_qty,
        shop_urgent_stockout_qty, shop_no_sent_qty, timeout_qty, due_within_1d_qty
      ) VALUES (${Array.from({ length: 10 }, () => "?").join(", ")})
    `),
  };
}

function insertDetailRows(statement, inputRows) {
  const rows = enrichShopShortageRows(inputRows);
  let inserted = 0;
  for (const row of rows) {
    const shopId = String(row.shop_id ?? row.child_shop_id ?? "");
    const shopSpuId = String(row.shop_spu_id ?? row.shop_i_id ?? "");
    if (!shopId || !shopSpuId) continue;
    const {
      children,
      shop_stockout_qty: stockoutQty,
      shop_urgent_stockout_qty: urgentStockoutQty,
      shop_no_sent_qty: noSentQty,
      ...raw
    } = row;
    statement.run(
      shopId,
      row.shop_name ?? null,
      row.platform ?? null,
      row.shop_type ?? null,
      shopSpuId,
      row.shop_spu_name ?? null,
      row.shop_sku_url ?? null,
      numberOrNull(row.shop_sku_cnt),
      stockoutQty,
      urgentStockoutQty,
      noSentQty,
      numberOrNull(row.timeout_qty) ?? 0,
      numberOrNull(row.will_timeout_qty_1d) ?? 0,
      numberOrNull(row.no_sent_order_cnt),
      numberOrNull(row.timeout_order_cnt),
      numberOrNull(row.will_timeout_order_cnt_1d),
      numberOrNull(row.real_qty),
      numberOrNull(row.onway_qty),
      numberOrNull(row.purchase_qty),
      Array.isArray(children) ? JSON.stringify(children) : children ?? null,
      JSON.stringify(raw),
    );
    inserted += 1;
  }
  return inserted;
}

async function writeShopShortageTables({
  db,
  session,
  pageSize = 100,
  concurrency = 4,
  onProgress = () => {},
  fetchPage,
  dropLegacyExportInfo = false,
}) {
  const startedAt = new Date();
  const started = performance.now();
  createSchema(db, { dropLegacyExportInfo });
  const statements = prepareStatements(db);
  let fetchedLinks = 0;
  const result = await getShopShortageSummary({
      session,
      pageSize,
      concurrency,
      ...(fetchPage ? { fetchPage } : {}),
      onPage: (rows, page, pages) => {
        fetchedLinks += insertDetailRows(statements.detail, rows);
        onProgress({ completedPages: page, pages, fetchedLinks });
      },
  });

  for (const shop of result.shops) {
    statements.summary.run(
        shop.shop_id,
        shop.shop_name,
        shop.platform,
        shop.shop_type,
        shop.link_count,
        shop.shop_stockout_qty,
        shop.shop_urgent_stockout_qty,
        shop.shop_no_sent_qty,
        shop.timeout_qty,
        shop.due_within_1d_qty,
    );
  }

  const completedAt = new Date();
  const durationMs = Math.round(performance.now() - started);
  db.prepare(`
      INSERT INTO shop_shortage_export_info (
        id, schema_version, started_at, completed_at, duration_ms,
        api_total_links, fetched_links, fetched_shops, pages, page_size,
        concurrency, urgent_definition
      ) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
      startedAt.toISOString(),
      completedAt.toISOString(),
      durationMs,
      result.total_links,
      fetchedLinks,
      result.shops.length,
      result.pages,
      pageSize,
      concurrency,
      "timeout_qty + will_timeout_qty_1d",
  );
  return {
    duration_ms: durationMs,
    total_links: result.total_links,
    fetched_links: fetchedLinks,
    fetched_shops: result.shops.length,
    pages: result.pages,
    page_size: pageSize,
    concurrency,
  };
}

async function exportToPath(options, { dropLegacyExportInfo = false } = {}) {
  const resolvedPath = resolve(options.outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; BEGIN IMMEDIATE;");
  try {
    const result = await writeShopShortageTables({
      ...options,
      db,
      dropLegacyExportInfo,
    });
    db.exec("COMMIT;");
    return { output: resolvedPath, ...result };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}

export function exportShopShortageToSqlite(options) {
  return exportToPath(options, { dropLegacyExportInfo: true });
}

export function appendShopShortageToSqlite(options) {
  return exportToPath(options);
}
