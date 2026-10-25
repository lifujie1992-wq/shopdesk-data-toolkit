import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CliError } from "./bridge.js";
import { readPage } from "./page.js";

export const UNSHIPPED_STATUSES = ["waitpay", "waitconfirm", "delivering", "waitoutersent", "question"];
export const UNSHIPPED_PAGE_SIZE = 2000;
export const MAX_UNSHIPPED_ORDERS = 500_000;

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
const FIELDS = [
  "o_id", "so_id", "shop_id", "shop_name", "shop_site",
  "status", "src_status", "question_type", "question_desc", "type", "labels",
  "order_date", "pay_date", "confirm_date",
  "plan_delivery_date", "deliver_time_left", "promise_time", "send_date",
  "wms_co_id", "wms_co_name",
  "paid_amount", "pay_amount", "norefund_item_qty", "norefund_item_amount",
];

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
        BEGIN;
      `);
      this.db.prepare(`INSERT INTO sync_metadata
        (id,schema_version,captured_at,started_at,status_filter,source,page_size,expected_count,sort_json)
        VALUES (1,1,?,?,?,?,?,?,?)`).run(
        metadata.capturedAt, metadata.startedAt, metadata.statusFilter, metadata.source,
        metadata.pageSize, metadata.expectedCount, metadata.sortJson,
      );
      this.insert = this.db.prepare(`INSERT INTO unshipped_orders (
        o_id,so_id,shop_id,shop_name,shop_site,status,src_status,question_type,question_desc,
        type,labels,order_date,pay_date,confirm_date,plan_delivery_date,deliver_time_left,
        promise_time,send_date,wms_co_id,wms_co_name,paid_amount,pay_amount,norefund_item_qty,
        norefund_item_amount
      ) VALUES (${FIELDS.filter((name) => name !== "captured_at").map(() => "?").join(",")})
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
      this.insert.run(...FIELDS.filter((name) => name !== "captured_at").map((name) => sqliteValue(row[name])));
    }
    this.fetched += rows.length;
    this.pages += 1;
  }

  uniqueCount() {
    return this.db.prepare("SELECT count(*) AS count FROM unshipped_orders").get().count;
  }

  finish(finishedAt, drift = {}) {
    const unique = this.uniqueCount();
    this.db.prepare(`UPDATE sync_metadata SET finished_at=?,fetched_count=?,unique_count=?,
      duplicate_count=?,pages_completed=?,final_count=?,drift_count=? WHERE id=1`).run(
      finishedAt, this.fetched, unique, this.fetched - unique, this.pages,
      drift.final_total ?? null, drift.drift ?? null,
    );
    this.db.exec("COMMIT; PRAGMA optimize;");
    this.db.close();
    this.closed = true;
    chmodSync(this.tmp, 0o600);
    renameSync(this.tmp, this.output);
    chmodSync(this.output, 0o600);
    return { output: this.output, fetched: this.fetched, unique, duplicates: this.fetched - unique, pages: this.pages };
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
