import { chmodSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CliError } from './bridge.js';
import { readPage } from './page.js';

export const PAGE_SIZES = [20, 50, 100, 200, 500, 1000, 1500, 2000];
export const DEFAULT_DAY_PAGE_SIZE = 2000;
export const MAX_DAY_ORDERS = 100_000;
export const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

function shanghaiParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function validCalendarDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [year, month, date] = day.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, date));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === date;
}

export function dayWindow(requestedDay, now = new Date()) {
  const parts = shanghaiParts(now);
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const day = requestedDay || today;
  if (!validCalendarDay(day)) throw new CliError('invalid_arguments', '--date 必须是有效的 YYYY-MM-DD 日期。');
  if (day > today) throw new CliError('invalid_arguments', '--date 不能晚于上海时区的今天。');
  return {
    day,
    lowerBound: `${day} 00:00:00`,
    upperBound: day === today ? `${day} ${parts.hour}:${parts.minute}:${parts.second}` : `${day} 23:59:59`,
  };
}

export function dayFilters(window, dateField = 'order_date') {
  if (!['order_date', 'pay_date'].includes(dateField)) {
    throw new CliError('invalid_arguments', '--date-field 只支持 order_date/pay_date。');
  }
  return [
    { k: dateField, v: window.lowerBound, c: '>=', t: 'date' },
    { k: dateField, v: window.upperBound, c: '<=', t: 'date' },
  ];
}

export function validateDayTotal(total) {
  if (!Number.isSafeInteger(total) || total < 0) throw new CliError('count_unavailable', '接口未返回有效的当天订单总数。');
  if (total > MAX_DAY_ORDERS) {
    throw new CliError('day_limit_exceeded', `当天订单数 ${total} 超过安全上限 ${MAX_DAY_ORDERS}，未开始抓取。`);
  }
  return total;
}

function sqliteValue(value) {
  if (value == null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  return JSON.stringify(value);
}

class DayDatabase {
  constructor(output, metadata) {
    this.output = resolve(output);
    this.tmp = resolve(dirname(this.output), `.${basename(this.output)}.${randomUUID()}.tmp`);
    writeFileSync(this.tmp, '', { mode: 0o600, flag: 'wx' });
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
          day TEXT NOT NULL,
          date_field TEXT NOT NULL,
          timezone TEXT NOT NULL,
          source TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          lower_bound TEXT NOT NULL,
          upper_bound TEXT NOT NULL,
          page_size INTEGER NOT NULL,
          expected_count INTEGER NOT NULL,
          fetched_count INTEGER NOT NULL DEFAULT 0,
          unique_count INTEGER NOT NULL DEFAULT 0,
          duplicate_count INTEGER NOT NULL DEFAULT 0,
          pages_completed INTEGER NOT NULL DEFAULT 0,
          filters_json TEXT NOT NULL,
          sort_json TEXT NOT NULL,
          columns_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE orders (
          o_id TEXT PRIMARY KEY,
          order_date TEXT,
          modified TEXT,
          status TEXT,
          question_type TEXT,
          shop_id TEXT,
          shop_name TEXT,
          shop_site TEXT,
          so_id TEXT,
          pay_date TEXT,
          confirm_date TEXT,
          send_date TEXT,
          paid_amount REAL,
          pay_amount REAL,
          item_amount REAL,
          item_qty REAL,
          freight REAL,
          free_amount REAL,
          labels TEXT,
          logistics_company TEXT,
          warehouse_id TEXT,
          warehouse_name TEXT,
          json TEXT NOT NULL
        );
        CREATE INDEX orders_order_date_idx ON orders(order_date);
        CREATE INDEX orders_status_idx ON orders(status);
        CREATE INDEX orders_shop_idx ON orders(shop_id);
        CREATE VIEW order_items AS
          SELECT orders.o_id,
                 CAST(item.key AS INTEGER) AS position,
                 json_extract(item.value, '$.sku_id') AS sku_id,
                 json_extract(item.value, '$.i_id') AS i_id,
                 json_extract(item.value, '$.shop_sku_id') AS shop_sku_id,
                 json_extract(item.value, '$.shop_i_id') AS shop_i_id,
                 json_extract(item.value, '$.name') AS name,
                 json_extract(item.value, '$.properties_value') AS properties_value,
                 json_extract(item.value, '$.qty') AS qty,
                 json_extract(item.value, '$.price') AS price,
                 json_extract(item.value, '$.amount') AS amount,
                 json_extract(item.value, '$.refund_qty') AS refund_qty,
                 json_extract(item.value, '$.is_gift') AS is_gift,
                 json_extract(item.value, '$.is_presale') AS is_presale,
                 item.value AS json
            FROM orders, json_each(orders.json, '$.items') AS item;
        BEGIN;
      `);
      this.db.prepare(`INSERT INTO sync_metadata
        (id,schema_version,day,date_field,timezone,source,started_at,lower_bound,upper_bound,page_size,expected_count,filters_json,sort_json)
        VALUES (1,2,?,?,?,?,?,?,?,?,?,?,?)`).run(
        metadata.day, metadata.dateField, SHANGHAI_TIME_ZONE, metadata.source, metadata.startedAt,
        metadata.lowerBound, metadata.upperBound, metadata.pageSize, metadata.expectedCount,
        JSON.stringify(metadata.filters), JSON.stringify(metadata.sort),
      );
      this.insert = this.db.prepare(`INSERT INTO orders (
        o_id,order_date,modified,status,question_type,shop_id,shop_name,shop_site,so_id,
        pay_date,confirm_date,send_date,paid_amount,pay_amount,item_amount,item_qty,freight,
        free_amount,labels,logistics_company,warehouse_id,warehouse_name,json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(o_id) DO UPDATE SET
        order_date=excluded.order_date,modified=excluded.modified,status=excluded.status,
        question_type=excluded.question_type,shop_id=excluded.shop_id,shop_name=excluded.shop_name,
        shop_site=excluded.shop_site,so_id=excluded.so_id,pay_date=excluded.pay_date,
        confirm_date=excluded.confirm_date,send_date=excluded.send_date,paid_amount=excluded.paid_amount,
        pay_amount=excluded.pay_amount,item_amount=excluded.item_amount,item_qty=excluded.item_qty,
        freight=excluded.freight,free_amount=excluded.free_amount,labels=excluded.labels,
        logistics_company=excluded.logistics_company,warehouse_id=excluded.warehouse_id,
        warehouse_name=excluded.warehouse_name,json=excluded.json`);
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  writePage(rows, columns) {
    for (const row of rows) {
      if (row?.o_id == null || String(row.o_id).length === 0) throw new CliError('invalid_list', '订单列表存在缺少内部订单号的记录。');
      this.insert.run(
        String(row.o_id), sqliteValue(row.order_date), sqliteValue(row.modified), sqliteValue(row.status),
        sqliteValue(row.question_type), row.shop_id == null ? null : String(row.shop_id),
        sqliteValue(row.shop_name), sqliteValue(row.shop_site), sqliteValue(row.so_id), sqliteValue(row.pay_date),
        sqliteValue(row.confirm_date), sqliteValue(row.send_date), sqliteValue(row.paid_amount),
        sqliteValue(row.pay_amount), sqliteValue(row.a_item_amount ?? row.item_amount),
        sqliteValue(row.norefund_item_qty), sqliteValue(row.freight), sqliteValue(row.free_amount),
        sqliteValue(row.labels), sqliteValue(row.logistics_company),
        row.store_id == null ? (row.wms_co_id == null ? null : String(row.wms_co_id)) : String(row.store_id),
        sqliteValue(row.store_name ?? row.wms_co_name), JSON.stringify(row),
      );
    }
    this.fetched += rows.length;
    this.pages++;
    if (columns?.length) this.db.prepare('UPDATE sync_metadata SET columns_json=? WHERE id=1').run(JSON.stringify(columns));
  }

  uniqueCount() {
    return this.db.prepare('SELECT count(*) AS count FROM orders').get().count;
  }

  finish(finishedAt) {
    const unique = this.uniqueCount();
    this.db.prepare(`UPDATE sync_metadata SET finished_at=?,fetched_count=?,unique_count=?,
      duplicate_count=?,pages_completed=? WHERE id=1`).run(
      finishedAt, this.fetched, unique, this.fetched - unique, this.pages,
    );
    this.db.exec('COMMIT; PRAGMA optimize;');
    this.db.close();
    this.closed = true;
    chmodSync(this.tmp, 0o600);
    renameSync(this.tmp, this.output);
    chmodSync(this.output, 0o600);
    return { output: this.output, fetched: this.fetched, unique, duplicates: this.fetched - unique, pages: this.pages };
  }

  abort() {
    if (!this.closed && this.db) {
      try { this.db.exec('ROLLBACK'); } catch {}
      try { this.db.close(); } catch {}
      this.closed = true;
    }
    try { unlinkSync(this.tmp); } catch {}
  }
}

export async function syncDay({ bridge, output, date, dateField = 'order_date', pageSize = DEFAULT_DAY_PAGE_SIZE, now = new Date(), onProgress }) {
  if (!PAGE_SIZES.includes(pageSize)) throw new CliError('invalid_arguments', `--page-size 只支持 ${PAGE_SIZES.join('/')}。`);
  if (!output || !String(output).toLowerCase().endsWith('.sqlite')) throw new CliError('invalid_arguments', 'sync-day 的 --output 必须是 .sqlite 文件。');
  const window = dayWindow(date, now);
  const filters = dayFilters(window, dateField);
  const sort = { [dateField]: false };
  const startedAt = now.toISOString();
  const count = await bridge.run(readPage, { command: 'count', limit: pageSize, page: 1, filters, sort });
  const total = validateDayTotal(count.total);
  const pageCount = Math.ceil(total / pageSize);
  const writer = new DayDatabase(output, {
    ...window, dateField, filters, sort, pageSize, expectedCount: total, startedAt,
    source: 'https://www.erp321.com/app/order/order/list.aspx',
  });
  try {
    for (let page = 1; page <= pageCount; page++) {
      const result = await bridge.run(readPage, {
        command: 'list', limit: pageSize, page, filters, sort, includeColumns: page === 1,
      });
      if (!Array.isArray(result.rows) || result.rows.length === 0) throw new CliError('pagination_incomplete', `第 ${page} 页没有返回订单，未替换原数据库。`);
      writer.writePage(result.rows, result.columns);
      onProgress?.({ page, pageCount, fetched: writer.fetched, expected: total });
    }
    const finalCount = await bridge.run(readPage, { command: 'count', limit: pageSize, page: 1, filters, sort });
    const unique = writer.uniqueCount();
    if (finalCount.total !== total || unique !== total) {
      throw new CliError('dataset_changed', `同步期间订单集合发生变化（开始 ${total}，结束 ${finalCount.total}，写入 ${unique}），请重试。`);
    }
    const stored = writer.finish(new Date().toISOString());
    return {
      ...stored,
      day: window.day,
      timezone: SHANGHAI_TIME_ZONE,
      lower_bound: window.lowerBound,
      upper_bound: window.upperBound,
      page_size: pageSize,
      max_orders: MAX_DAY_ORDERS,
      expected: total,
    };
  } catch (error) {
    writer.abort();
    throw error;
  }
}
