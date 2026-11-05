import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CliError } from "./bridge.js";
import { readPage } from "./page.js";

export const UNSHIPPED_STATUSES = ["waitpay", "waitconfirm", "delivering", "waitoutersent", "question"];
export const UNSHIPPED_PAGE_SIZE = 2000;
export const MAX_UNSHIPPED_ORDERS = 500_000;
export const UNSHIPPED_SCHEMA_VERSION = 2;

// Per-item statuses that mean the line no longer needs shipping: already sent,
// cancelled/refunded, disabled, or shipped from an external warehouse. Verified
// against the live list API: `Sent` lines stay inside the order and are still
// counted by the order-level `norefund_item_qty`, so they must be zeroed here.
export const SHIPPED_ITEM_STATUSES = ["Sent", "Cancelled", "Disabled", "OuterSent"];
// Bundle/promo lines such as 「好评卡」 never ship (19% of all lines).
export const NO_DELIVER_SKU_TYPE = "no_deliver";
const SHIPPED_ITEM_STATUS_SET = new Set(SHIPPED_ITEM_STATUSES);

export function unshippedItemQty(item) {
  if (!item || item.sku_type === NO_DELIVER_SKU_TYPE) return 0;
  if (SHIPPED_ITEM_STATUS_SET.has(item.item_status)) return 0;
  const qty = Number(item.qty);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

// Numeric ids arrive as JS numbers and would land as "42212164.0" in a TEXT
// column. Every other warehouse dataset stores plain integer text, so ids are
// normalised here to keep joins (o_id / shop_id) stable.
function idValue(value) {
  if (value == null) return null;
  const text = typeof value === "number" ? String(value) : String(value).trim();
  return /^-?\d+\.0+$/.test(text) ? text.replace(/\.0+$/, "") : text;
}

function sqliteValue(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  return JSON.stringify(value);
}

export function unshippedFilters() {
  return [{ k: "status", v: UNSHIPPED_STATUSES.join(","), c: "@=" }];
}

// Fields kept for the warehouse. Receiver identity/contact, buyer account,
// logistics details and buyer/remark messages are intentionally excluded.
const ORDER_FIELDS = [
  "o_id", "so_id", "shop_id", "shop_name", "shop_site",
  "status", "src_status", "question_type", "question_desc", "type", "labels",
  "order_date", "pay_date", "confirm_date",
  "plan_delivery_date", "deliver_time_left", "promise_time", "send_date",
  "wms_co_id", "wms_co_name",
  "paid_amount", "pay_amount", "norefund_item_qty", "norefund_item_amount",
];

// Product lines come from the same list response (`rows[].items[]`), so the
// snapshot stays one pass over the order page. Item names, pictures, prices and
// platform ids are dropped; the warehouse only needs the shipping keys.
const ITEM_FIELDS = [
  "o_id", "oi_id", "shop_id", "shop_name", "i_id", "sku_id", "sku_type", "is_gift",
  "qty", "unshipped_qty", "item_status", "status", "src_status", "plan_delivery_date",
];
const ID_FIELDS = new Set(["o_id", "shop_id", "wms_co_id"]);

function itemValues(row, item) {
  const oiId = item?.oi_id == null ? "" : String(item.oi_id);
  if (!oiId) throw new CliError("invalid_list", `订单 ${row.o_id} 存在缺少商品行号（oi_id）的商品。`);
  const skuId = item.sku_id == null ? "" : String(item.sku_id);
  if (!skuId) throw new CliError("invalid_list", `订单 ${row.o_id} 存在缺少 sku_id 的商品。`);
  return [
    idValue(row.o_id),
    idValue(oiId),
    idValue(row.shop_id),
    sqliteValue(row.shop_name),
    sqliteValue(item.i_id),
    skuId,
    sqliteValue(item.sku_type),
    item.is_gift ? 1 : 0,
    sqliteValue(item.qty),
    unshippedItemQty(item),
    sqliteValue(item.item_status),
    sqliteValue(row.status),
    sqliteValue(row.src_status),
    sqliteValue(item.item_plan_delivery_date ?? row.plan_delivery_date),
  ];
}

class UnshippedDatabase {
  constructor(output, metadata) {
    this.output = resolve(output);
    this.tmp = resolve(dirname(this.output), `.${basename(this.output)}.${randomUUID()}.tmp`);
    writeFileSync(this.tmp, "", { mode: 0o600, flag: "wx" });
    this.db = new DatabaseSync(this.tmp);
    this.closed = false;
    this.fetched = 0;
    this.pages = 0;
    try {
      this.db.exec(`
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=NORMAL;
        CREATE TABLE sync_metadata (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          schema_version INTEGER NOT NULL,
          captured_at TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          status_filter TEXT NOT NULL,
          source TEXT NOT NULL,
          page_size INTEGER NOT NULL,
          expected_count INTEGER NOT NULL,
          fetched_count INTEGER NOT NULL DEFAULT 0,
          unique_count INTEGER NOT NULL DEFAULT 0,
          duplicate_count INTEGER NOT NULL DEFAULT 0,
          pages_completed INTEGER NOT NULL DEFAULT 0,
          final_count INTEGER,
          drift_count INTEGER,
          item_count INTEGER NOT NULL DEFAULT 0,
          item_unshipped_qty REAL NOT NULL DEFAULT 0,
          sort_json TEXT NOT NULL
        );
        CREATE TABLE unshipped_orders (
          o_id TEXT PRIMARY KEY,
          so_id TEXT,
          shop_id TEXT,
          shop_name TEXT,
          shop_site TEXT,
          status TEXT,
          src_status TEXT,
          question_type TEXT,
          question_desc TEXT,
          type TEXT,
          labels TEXT,
          order_date TEXT,
          pay_date TEXT,
          confirm_date TEXT,
          plan_delivery_date TEXT,
          deliver_time_left REAL,
          promise_time TEXT,
          send_date TEXT,
          wms_co_id TEXT,
          wms_co_name TEXT,
          paid_amount REAL,
          pay_amount REAL,
          norefund_item_qty REAL,
          norefund_item_amount REAL
        );
        CREATE INDEX unshipped_plan_date_idx ON unshipped_orders(plan_delivery_date);
        CREATE INDEX unshipped_status_idx ON unshipped_orders(status);
        CREATE INDEX unshipped_shop_idx ON unshipped_orders(shop_id);
        CREATE TABLE unshipped_order_items (
          o_id TEXT NOT NULL,
          oi_id TEXT NOT NULL,
          shop_id TEXT,
          shop_name TEXT,
          i_id TEXT,
          sku_id TEXT NOT NULL,
          sku_type TEXT,
          is_gift INTEGER NOT NULL DEFAULT 0,
          qty REAL,
          unshipped_qty REAL NOT NULL DEFAULT 0,
          item_status TEXT,
          status TEXT,
          src_status TEXT,
          plan_delivery_date TEXT,
          PRIMARY KEY (o_id, oi_id)
        );
        CREATE INDEX unshipped_item_sku_idx ON unshipped_order_items(sku_id);
        CREATE INDEX unshipped_item_iid_idx ON unshipped_order_items(i_id);
        CREATE INDEX unshipped_item_shop_idx ON unshipped_order_items(shop_id);
        CREATE INDEX unshipped_item_plan_idx ON unshipped_order_items(plan_delivery_date);
        BEGIN;
      `);
      this.db.prepare(`INSERT INTO sync_metadata
        (id,schema_version,captured_at,started_at,status_filter,source,page_size,expected_count,sort_json)
        VALUES (1,?,?,?,?,?,?,?,?)`).run(
        UNSHIPPED_SCHEMA_VERSION,
        metadata.capturedAt, metadata.startedAt, metadata.statusFilter, metadata.source,
        metadata.pageSize, metadata.expectedCount, metadata.sortJson,
      );
      this.insert = this.db.prepare(`INSERT INTO unshipped_orders (
        o_id,so_id,shop_id,shop_name,shop_site,status,src_status,question_type,question_desc,
        type,labels,order_date,pay_date,confirm_date,plan_delivery_date,deliver_time_left,
        promise_time,send_date,wms_co_id,wms_co_name,paid_amount,pay_amount,norefund_item_qty,
        norefund_item_amount
      ) VALUES (${ORDER_FIELDS.map(() => "?").join(",")})
      ON CONFLICT(o_id) DO UPDATE SET
        so_id=excluded.so_id,shop_id=excluded.shop_id,shop_name=excluded.shop_name,
        shop_site=excluded.shop_site,status=excluded.status,src_status=excluded.src_status,
        question_type=excluded.question_type,question_desc=excluded.question_desc,
        type=excluded.type,labels=excluded.labels,order_date=excluded.order_date,
        pay_date=excluded.pay_date,confirm_date=excluded.confirm_date,
        plan_delivery_date=excluded.plan_delivery_date,deliver_time_left=excluded.deliver_time_left,
        promise_time=excluded.promise_time,send_date=excluded.send_date,wms_co_id=excluded.wms_co_id,
        wms_co_name=excluded.wms_co_name,paid_amount=excluded.paid_amount,pay_amount=excluded.pay_amount,
        norefund_item_qty=excluded.norefund_item_qty,norefund_item_amount=excluded.norefund_item_amount`);
      this.insertItem = this.db.prepare(`INSERT INTO unshipped_order_items (
        ${ITEM_FIELDS.join(",")}
      ) VALUES (${ITEM_FIELDS.map(() => "?").join(",")})
      ON CONFLICT(o_id,oi_id) DO UPDATE SET
        shop_id=excluded.shop_id,shop_name=excluded.shop_name,i_id=excluded.i_id,
        sku_id=excluded.sku_id,sku_type=excluded.sku_type,is_gift=excluded.is_gift,
        qty=excluded.qty,unshipped_qty=excluded.unshipped_qty,item_status=excluded.item_status,
        status=excluded.status,src_status=excluded.src_status,
        plan_delivery_date=excluded.plan_delivery_date`);
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  writePage(rows) {
    for (const row of rows) {
      if (row?.o_id == null || String(row.o_id).length === 0) {
        throw new CliError("invalid_list", "订单列表存在缺少内部订单号的记录。");
      }
      this.insert.run(...ORDER_FIELDS.map((name) => (ID_FIELDS.has(name) ? idValue(row[name]) : sqliteValue(row[name]))));
      for (const item of row.items ?? []) this.insertItem.run(...itemValues(row, item));
    }
    this.fetched += rows.length;
    this.pages += 1;
  }

  uniqueCount() {
    return this.db.prepare("SELECT count(*) AS count FROM unshipped_orders").get().count;
  }

  itemStats() {
    return this.db.prepare(`SELECT count(*) AS count, coalesce(sum(unshipped_qty), 0) AS qty
      FROM unshipped_order_items`).get();
  }

  finish(finishedAt, drift = {}) {
    const unique = this.uniqueCount();
    const items = this.itemStats();
    this.db.prepare(`UPDATE sync_metadata SET finished_at=?,fetched_count=?,unique_count=?,
      duplicate_count=?,pages_completed=?,final_count=?,drift_count=?,item_count=?,item_unshipped_qty=?
      WHERE id=1`).run(
      finishedAt, this.fetched, unique, this.fetched - unique, this.pages,
      drift.final_total ?? null, drift.drift ?? null, items.count, items.qty,
    );
    this.db.exec("COMMIT; PRAGMA optimize;");
    this.db.close();
    this.closed = true;
    chmodSync(this.tmp, 0o600);
    renameSync(this.tmp, this.output);
    chmodSync(this.output, 0o600);
    return { output: this.output, fetched: this.fetched, unique, duplicates: this.fetched - unique, pages: this.pages,
      items: items.count, unshipped_qty: items.qty };
  }

  abort() {
    if (!this.closed && this.db) {
      try { this.db.exec("ROLLBACK"); } catch {}
      try { this.db.close(); } catch {}
      this.closed = true;
    }
    try { unlinkSync(this.tmp); } catch {}
  }
}

export async function syncUnshipped({ bridge, output, pageSize = UNSHIPPED_PAGE_SIZE, now = new Date(), onProgress }) {
  if (![20, 50, 100, 200, 500, 1000, 1500, 2000].includes(pageSize)) {
    throw new CliError("invalid_arguments", "--page-size 只支持 20/50/100/200/500/1000/1500/2000。");
  }
  if (!output || !String(output).toLowerCase().endsWith(".sqlite")) {
    throw new CliError("invalid_arguments", "sync-unshipped 的 --output 必须是 .sqlite 文件。");
  }
  const filters = unshippedFilters();
  const sort = { o_id: false };
  const startedAt = now.toISOString();
  const capturedAt = startedAt;
  const count = await bridge.run(readPage, { command: "count", limit: pageSize, page: 1, filters, sort });
  if (!Number.isSafeInteger(count.total) || count.total < 0) {
    throw new CliError("count_unavailable", "接口未返回有效的未发货订单总数。");
  }
  const total = count.total;
  if (total > MAX_UNSHIPPED_ORDERS) {
    throw new CliError("unshipped_limit_exceeded", `未发货订单数 ${total} 超过安全上限 ${MAX_UNSHIPPED_ORDERS}，未开始抓取。`);
  }
  const pageCount = Math.ceil(total / pageSize);
  const writer = new UnshippedDatabase(output, {
    capturedAt, startedAt, statusFilter: UNSHIPPED_STATUSES.join(","),
    source: "https://www.erp321.com/app/order/order/list.aspx",
    pageSize, expectedCount: total, sortJson: JSON.stringify(sort),
  });
  try {
    for (let page = 1; page <= pageCount; page++) {
      const result = await bridge.run(readPage, {
        command: "list", limit: pageSize, page, filters, sort, includeColumns: false,
      });
      if (!Array.isArray(result.rows) || result.rows.length === 0) {
        throw new CliError("pagination_incomplete", `第 ${page} 页没有返回订单，未替换原数据库。`);
      }
      writer.writePage(result.rows);
      onProgress?.({ page, pageCount, fetched: writer.fetched, expected: total });
    }
    const finalCount = await bridge.run(readPage, { command: "count", limit: pageSize, page: 1, filters, sort });
    const unique = writer.uniqueCount();
    // The unshipped backlog changes while pages are being read (orders ship out
    // and new orders arrive). Accept small live drift but fail on real pagination
    // gaps; the drift range is recorded in sync_metadata.
    const drift = Math.abs(unique - finalCount.total);
    const tolerance = Math.max(200, Math.round(total * 0.01));
    if (drift > tolerance) {
      throw new CliError("dataset_changed", `同步期间订单集合变化过大（开始 ${total}，结束 ${finalCount.total}，写入 ${unique}，超出容忍范围 ${tolerance}），请重试。`);
    }
    return writer.finish(new Date().toISOString(), { final_total: finalCount.total, drift });
  } catch (error) {
    writer.abort();
    throw error;
  }
}
