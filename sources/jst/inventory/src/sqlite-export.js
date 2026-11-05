import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  callApi,
  callListApi,
  detailParams,
  parseChildren,
  PURCHASE_WARNING_CONTEXT,
  spuLiveParams,
} from "./api.js";
import { CliError } from "./errors.js";
import { normalizeShops } from "./shop-sku-batch.js";

const EXTRA_DATA = { customColumnTableCode: "procurement_rt_warning_table" };

function value(row, name) {
  return row[name] ?? null;
}

const NUMBER_FIELDS = [
  "advice_purchase_qty",
  "available_qty",
  "available_day",
  "available_avg_qty",
  "stockout_qty",
  "real_qty",
  "main_qty",
  "purchase_qty",
  "return_onway_item_qty",
  "return_qty",
  "in_qty",
  "onway_qty",
  "allocate_qty",
  "wms_qty",
  "virtual_qty",
  "wait_audit_purchase_qty",
  "no_sent_qty",
  "no_sent_qty_all",
  "pre_no_sent_qty",
  "pre_no_sent_qty_all",
  "timeout_qty",
  "timeout_qty_all",
  "will_timeout_qty_1d",
  "will_timeout_qty_1d_all",
  "will_timeout_qty_1d_3d",
  "will_timeout_qty_1d_3d_all",
  "will_timeout_qty_3d_7d",
  "will_timeout_qty_3d_7d_all",
  "will_timeout_qty_7d",
  "will_timeout_qty_7d_all",
  "pay_qty_today",
  "pay_qty_1d",
  "pay_qty_3d",
  "pay_qty_7d",
  "pay_qty_15d",
  "pay_qty_30d",
  "pay_qty_180d",
  "pay_avg_qty_1d",
  "pay_avg_qty_3d",
  "pay_avg_qty_7d",
  "pay_avg_qty_15d",
  "pay_avg_qty_30d",
  "pay_avg_qty_180d",
  "pay_avg_qty_7d_calculated",
  "inout_sent_item_qty_today",
  "inout_sent_item_qty_1d",
  "inout_sent_item_qty_3d",
  "inout_sent_item_qty_7d",
  "inout_sent_item_qty_15d",
  "inout_sent_item_qty_30d",
  "inout_sent_item_qty_180d",
  "return_item_qty_3d",
  "return_item_qty_7d",
  "return_item_qty_15d",
  "return_item_qty_30d",
  "return_item_qty_180d",
  "return_fact_item_qty_3d",
  "return_fact_item_qty_7d",
  "return_fact_item_qty_15d",
  "return_fact_item_qty_30d",
  "return_fact_item_qty_180d",
  "goods_link_cnt",
  "goods_link_cnt_1d",
  "goods_link_cnt_7d",
  "gross_margin_7d",
  "gross_margin_30d",
  "order_goods_profit_rate_7d",
  "order_goods_profit_rate_30d",
  "per_order_goods_profit_7d",
  "per_order_goods_profit_30d",
  "order_sku_gross_profit_7d",
  "net_order_item_amt_7d",
  "sent_send_refund_afs_item_qty_rate_pre3to5",
  "sent_send_refund_afs_item_qty_rate_pre5to7",
  "sent_send_refund_afs_item_qty_rate_pre7to15",
  "sent_send_refund_afs_item_qty_rate_pre15to30",
  "sent_send_refund_afs_item_qty_rate_pre7to180",
  "i_created",
];

const TEXT_FIELDS = [
  "category",
  "brand_name",
  "vc_name",
  "supplier_name",
  "supplier_id",
  "labels",
  "sku_labels",
  "created",
  "remark_time",
  "remark_u_id",
  "remark_u_name",
];

const PRICE_FIELDS = ["cost_price", "last_purchase_price"];
const COMMON_FIELDS = [...TEXT_FIELDS, ...NUMBER_FIELDS];
const SPU_FIELDS = ["spu_name", "spu_pic", "spu_remark", ...COMMON_FIELDS];
const SKU_FIELDS = [
  "sku_name",
  "properties_value",
  "pic",
  "sku_remark",
  ...PRICE_FIELDS,
  ...COMMON_FIELDS,
];

function fieldType(name) {
  return NUMBER_FIELDS.includes(name) || PRICE_FIELDS.includes(name) ? "REAL" : "TEXT";
}

function sqlColumns(fields) {
  return fields.map((name) => `      ${name} ${fieldType(name)}`).join(",\n");
}

function exportValue(row, name) {
  const result = name === "labels"
    ? value(row, "labels") ?? value(row, "sku_labels")
    : value(row, name);
  if (result !== null && typeof result === "object") return JSON.stringify(result);
  return result;
}

export function normalizeShopGroups(input) {
  if (input?.code !== undefined && (input.code !== 0 || input.success !== true)) {
    throw new Error("invalid_shop_group_directory");
  }
  const rows = Array.isArray(input) ? input : input?.data;
  if (!Array.isArray(rows)) throw new Error("invalid_shop_group_directory");
  const groups = [];
  const ids = new Set();
  for (const row of rows) {
    const groupId = String(row?.group_id ?? row?.groupId ?? "").trim();
    const groupName = String(row?.group_name ?? row?.groupName ?? "").trim();
    let shopIds = row?.shop_list ?? row?.shopList;
    if (typeof shopIds === "string") {
      try { shopIds = JSON.parse(shopIds); } catch { throw new Error("invalid_shop_group_members"); }
    }
    if (!groupId || !groupName || ids.has(groupId) || !Array.isArray(shopIds)) {
      throw new Error("invalid_shop_group_identity");
    }
    const members = [...new Set(shopIds.map(value => String(value).trim()))];
    if (members.some(value => !value)) throw new Error("invalid_shop_group_members");
    const expected = Number(row?.shop_cnt ?? row?.shopCount ?? members.length);
    if (!Number.isSafeInteger(expected) || expected !== members.length) {
      throw new Error("invalid_shop_group_count");
    }
    ids.add(groupId);
    groups.push({ group_id: groupId, group_name: groupName, shop_ids: members.sort() });
  }
  return groups.sort((a, b) => a.group_name.localeCompare(b.group_name, "zh-CN"));
}

function createSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS export_info;
    DROP TABLE IF EXISTS sku_inventory;
    DROP TABLE IF EXISTS spu_inventory;
    DROP TABLE IF EXISTS shop_directory;
    DROP TABLE IF EXISTS shop_groups;
    DROP TABLE IF EXISTS shop_group_members;
    DROP TABLE IF EXISTS shop_shortage_export_info;
    DROP TABLE IF EXISTS shop_shortage_summary;
    DROP TABLE IF EXISTS shop_stockout_warning;
    DROP TABLE IF EXISTS sales_analysis_export_info;
    DROP TABLE IF EXISTS platform_product_sales_analysis;
    DROP TABLE IF EXISTS shop_product_sales_analysis;
    DROP TABLE IF EXISTS link_product_sales_analysis;
    DROP TABLE IF EXISTS product_daily_sales_analysis;

    CREATE TABLE export_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      api_total_spu INTEGER NOT NULL,
      fetched_spu INTEGER NOT NULL,
      fetched_sku INTEGER NOT NULL,
      pages INTEGER NOT NULL,
      page_size INTEGER NOT NULL,
      concurrency INTEGER NOT NULL
    );

    CREATE TABLE spu_inventory (
      spu_id TEXT PRIMARY KEY,
${sqlColumns(SPU_FIELDS)},
      raw_json TEXT NOT NULL
    );

    CREATE TABLE sku_inventory (
      spu_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
${sqlColumns(SKU_FIELDS)},
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, sku_id)
    );

    CREATE INDEX sku_inventory_advice_purchase_idx
      ON sku_inventory(advice_purchase_qty DESC);
    CREATE INDEX sku_inventory_stockout_idx
      ON sku_inventory(stockout_qty DESC);
    CREATE INDEX sku_inventory_sku_id_idx
      ON sku_inventory(sku_id);

    CREATE TABLE shop_directory (
      shop_id TEXT PRIMARY KEY,
      shop_name TEXT NOT NULL,
      platform TEXT NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE INDEX shop_directory_platform_idx
      ON shop_directory(platform, shop_name);

    CREATE TABLE shop_groups (
      group_id TEXT PRIMARY KEY,
      group_name TEXT NOT NULL,
      shop_count INTEGER NOT NULL,
      captured_at TEXT NOT NULL
    );
    CREATE TABLE shop_group_members (
      group_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      PRIMARY KEY (group_id, shop_id),
      FOREIGN KEY (group_id) REFERENCES shop_groups(group_id)
    );
    CREATE INDEX shop_group_members_shop_idx
      ON shop_group_members(shop_id, group_id);
  `);
}

function createSpuLiveSchema(db) {
  db.exec(`
    DROP TABLE IF EXISTS export_info;
    DROP TABLE IF EXISTS sku_inventory;
    DROP TABLE IF EXISTS spu_inventory;

    CREATE TABLE export_info (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      schema_version INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      api_total_spu INTEGER NOT NULL,
      fetched_spu INTEGER NOT NULL,
      fetched_sku INTEGER NOT NULL,
      pages INTEGER NOT NULL,
      page_size INTEGER NOT NULL,
      concurrency INTEGER NOT NULL
    );

    CREATE TABLE spu_inventory (
      spu_id TEXT PRIMARY KEY,
${sqlColumns(SPU_FIELDS)},
      raw_json TEXT NOT NULL
    );

    CREATE TABLE sku_inventory (
      spu_id TEXT NOT NULL,
      sku_id TEXT NOT NULL,
${sqlColumns(SKU_FIELDS)},
      raw_json TEXT NOT NULL,
      PRIMARY KEY (spu_id, sku_id)
    );

    CREATE INDEX spu_inventory_advice_purchase_idx
      ON spu_inventory(advice_purchase_qty DESC);
    CREATE INDEX spu_inventory_stockout_idx
      ON spu_inventory(stockout_qty DESC);
    CREATE INDEX sku_inventory_advice_purchase_idx
      ON sku_inventory(advice_purchase_qty DESC);
    CREATE INDEX sku_inventory_stockout_idx
      ON sku_inventory(stockout_qty DESC);
    CREATE INDEX sku_inventory_sku_id_idx
      ON sku_inventory(sku_id);
  `);
}

function prepareInventoryStatements(db) {
  const insert = (table, idFields, fields) => {
    const columns = [...idFields, ...fields, "raw_json"];
    return db.prepare(`
      INSERT OR REPLACE INTO ${table} (${columns.join(", ")})
      VALUES (${columns.map(() => "?").join(", ")})
    `);
  };
  return {
    spu: insert("spu_inventory", ["spu_id"], SPU_FIELDS),
    sku: insert("sku_inventory", ["spu_id", "sku_id"], SKU_FIELDS),
  };
}

function prepareStatements(db) {
  return {
    ...prepareInventoryStatements(db),
    shop: db.prepare(`
      INSERT INTO shop_directory (shop_id, shop_name, platform, captured_at)
      VALUES (?, ?, ?, ?)
    `),
    shopGroup: db.prepare(`
      INSERT INTO shop_groups (group_id, group_name, shop_count, captured_at)
      VALUES (?, ?, ?, ?)
    `),
    shopGroupMember: db.prepare(`
      INSERT INTO shop_group_members (group_id, shop_id) VALUES (?, ?)
    `),
  };
}

function insertRows(statements, inputRows) {
  let skuCount = 0;
  for (const row of parseChildren(inputRows)) {
    const { children, ...spuRaw } = row;
    statements.spu.run(
      String(value(row, "spu_id") ?? value(row, "c_id") ?? ""),
      ...SPU_FIELDS.map((name) => exportValue(row, name)),
      JSON.stringify(spuRaw),
    );

    if (!Array.isArray(children)) continue;
    for (const sku of children) {
      const spuId = String(value(sku, "spu_id") ?? value(row, "spu_id") ?? "");
      const skuId = String(value(sku, "sku_id") ?? "");
      if (!spuId || !skuId) continue;
      statements.sku.run(
        spuId,
        skuId,
        ...SKU_FIELDS.map((name) => exportValue(sku, name)),
        JSON.stringify(sku),
      );
      skuCount += 1;
    }
  }
  return skuCount;
}

function incompleteExport(message) {
  return new CliError("incomplete_export", `SPU live export rejected: ${message}`);
}

function validateTotal(payload, page) {
  const total = Number(payload?.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw incompleteExport(`page ${page} returned an invalid total.`);
  }
  return total;
}

function insertStrictSpuPage({ statements, payload, page, pageSize, expectedTotal, seenSpu, seenSku }) {
  const actualTotal = validateTotal(payload, page);
  if (actualTotal !== expectedTotal) {
    throw incompleteExport(
      `total changed from ${expectedTotal} to ${actualTotal} on page ${page}.`,
    );
  }
  if (!Array.isArray(payload.data)) {
    throw incompleteExport(`page ${page} did not return a row array.`);
  }
  const expectedRows = Math.max(0, Math.min(
    pageSize,
    expectedTotal - ((page - 1) * pageSize),
  ));
  if (payload.data.length !== expectedRows) {
    throw incompleteExport(
      `page ${page} returned ${payload.data.length} rows; expected ${expectedRows}.`,
    );
  }

  for (const row of parseChildren(payload.data)) {
    const spuId = String(value(row, "spu_id") ?? value(row, "c_id") ?? "").trim();
    if (!spuId) throw incompleteExport(`page ${page} contains an empty SPU id.`);
    if (seenSpu.has(spuId)) throw incompleteExport(`SPU ${spuId} appeared more than once.`);
    if (!Array.isArray(row.children)) {
      throw incompleteExport(`SPU ${spuId} did not include its SKU children.`);
    }
    const spuToday = value(row, "pay_qty_today");
    if (spuToday != null) {
      const skuToday = row.children.reduce(
        (sum, sku) => sum + Number(value(sku, "pay_qty_today") ?? 0), 0,
      );
      if (!Number.isFinite(Number(spuToday)) || !Number.isFinite(skuToday)
          || Math.abs(Number(spuToday) - skuToday) > 1e-9) {
        throw incompleteExport(
          `SPU ${spuId} today quantity ${String(spuToday)} does not equal SKU total ${String(skuToday)}.`,
        );
      }
    }
    seenSpu.add(spuId);
    const { children, ...spuRaw } = row;
    statements.spu.run(
      spuId,
      ...SPU_FIELDS.map((name) => exportValue(row, name)),
      JSON.stringify(spuRaw),
    );
    for (const sku of children) {
      const skuId = String(value(sku, "sku_id") ?? "").trim();
      const declaredSpuId = String(value(sku, "spu_id") ?? spuId).trim();
      if (!skuId) throw incompleteExport(`SPU ${spuId} contains an empty SKU id.`);
      if (declaredSpuId !== spuId) {
        throw incompleteExport(`SKU ${skuId} belongs to SPU ${declaredSpuId}, expected ${spuId}.`);
      }
      const key = `${spuId}\u0000${skuId}`;
      if (seenSku.has(key)) throw incompleteExport(`SKU ${skuId} appeared more than once for SPU ${spuId}.`);
      seenSku.add(key);
      statements.sku.run(
        spuId,
        skuId,
        ...SKU_FIELDS.map((name) => exportValue(sku, name)),
        JSON.stringify(sku),
      );
    }
  }
}

// Both inventory exporters read the same SPU/SKU endpoint. Retry only the
// explicit system exception on its failed page, leaving validation/rollback
// to the caller and other APIs to their own error policies.
function inventoryPageReader({ fetchPage, pageSize, retryDelaysMs, onProgress }) {
  return async function readPage(page) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await fetchPage(page); }
      catch (error) {
        const status = error.diagnostic?.http_status;
        const retryable = error.code === 'api_error'
          && /^系统异常，请稍后再试[。.!！]?$/.test(error.message.trim())
          && (status === undefined || status === 200 || status >= 500 && status <= 599);
        if (!retryable || attempt > retryDelaysMs.length) {
          if (error instanceof CliError) throw new CliError(error.code, error.message, {
            ...error.diagnostic, page_num: page, page_size: pageSize, attempts: attempt,
          });
          throw error;
        }
        const delayMs = retryDelaysMs[attempt - 1];
        onProgress({event: 'retry', pageNum: page, pageSize, attempt, delayMs});
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  };
}

export async function exportSpuInventoryToSqlite({
  session,
  outputPath,
  pageSize = 100,
  concurrency = 4,
  onProgress = () => {},
  retryDelaysMs = [5_000, 15_000],
  fetchPage = (page) => callListApi(
    session,
    "purchase_alarm_sku_detail",
    spuLiveParams(page, pageSize),
    EXTRA_DATA,
  ),
}) {
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const startedAt = new Date();
  const started = performance.now();
  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; BEGIN IMMEDIATE;");
  const readPage = inventoryPageReader({ fetchPage, pageSize, retryDelaysMs, onProgress });

  try {
    createSpuLiveSchema(db);
    const statements = prepareInventoryStatements(db);
    const first = await readPage(1);
    const total = validateTotal(first, 1);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const seenSpu = new Set();
    const seenSku = new Set();
    insertStrictSpuPage({ statements, payload: first, page: 1, pageSize,
      expectedTotal: total, seenSpu, seenSku });
    onProgress({ completedPages: 1, pages, fetchedSpu: seenSpu.size, fetchedSku: seenSku.size });

    for (let firstPage = 2; firstPage <= pages; firstPage += concurrency) {
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, pages - firstPage + 1) },
        (_, index) => firstPage + index,
      );
      const payloads = await Promise.all(pageNumbers.map((page) => readPage(page)));
      for (let index = 0; index < payloads.length; index += 1) {
        insertStrictSpuPage({
          statements,
          payload: payloads[index],
          page: pageNumbers[index],
          pageSize,
          expectedTotal: total,
          seenSpu,
          seenSku,
        });
      }
      onProgress({ completedPages: pageNumbers.at(-1), pages,
        fetchedSpu: seenSpu.size, fetchedSku: seenSku.size });
    }

    const storedSpu = Number(db.prepare("SELECT COUNT(*) AS count FROM spu_inventory").get().count);
    const storedSku = Number(db.prepare("SELECT COUNT(*) AS count FROM sku_inventory").get().count);
    if (seenSpu.size !== total || storedSpu !== total) {
      throw incompleteExport(`stored ${storedSpu} distinct SPUs; expected ${total}.`);
    }
    if (storedSku !== seenSku.size || storedSku === 0) {
      throw incompleteExport(`stored ${storedSku} distinct SKUs; observed ${seenSku.size}.`);
    }

    const completedAt = new Date();
    const durationMs = Math.round(performance.now() - started);
    db.prepare(`
      INSERT INTO export_info (
        id, schema_version, started_at, completed_at, duration_ms, api_total_spu,
        fetched_spu, fetched_sku, pages, page_size, concurrency
      ) VALUES (1, 7, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      startedAt.toISOString(),
      completedAt.toISOString(),
      durationMs,
      total,
      seenSpu.size,
      seenSku.size,
      pages,
      pageSize,
      concurrency,
    );
    db.exec("COMMIT;");
    return {
      output: resolvedPath,
      duration_ms: durationMs,
      total_spu: total,
      fetched_spu: seenSpu.size,
      fetched_sku: seenSku.size,
      pages,
      page_size: pageSize,
      concurrency,
    };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}

export async function exportInventoryToSqlite({
  session,
  outputPath,
  pageSize = 100,
  concurrency = 4,
  onProgress = () => {},
  retryDelaysMs = [5_000, 15_000],
  fetchPage = (page) => callListApi(
    session,
    "purchase_alarm_sku_detail",
    detailParams(page, pageSize),
    EXTRA_DATA,
  ),
  fetchShops = () => callApi(
    session,
    "platform_shop_list",
    {},
    {},
    PURCHASE_WARNING_CONTEXT,
  ),
  fetchShopGroups = () => callApi(
    session,
    "query_shop_group_config",
    {},
    {},
    PURCHASE_WARNING_CONTEXT,
  ),
}) {
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const startedAt = new Date();
  const started = performance.now();
  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = NORMAL; BEGIN IMMEDIATE;");
  const readPage = inventoryPageReader({ fetchPage, pageSize, retryDelaysMs, onProgress });

  try {
    createSchema(db);
    const statements = prepareStatements(db);
    const [first, shopPayload, shopGroupPayload] = await Promise.all([
      readPage(1), fetchShops(), fetchShopGroups(),
    ]);
    const shops = normalizeShops(shopPayload);
    const shopGroups = normalizeShopGroups(shopGroupPayload);
    for (const shop of shops) {
      statements.shop.run(shop.shop_id, shop.shop_name, shop.platform, startedAt.toISOString());
    }
    for (const group of shopGroups) {
      statements.shopGroup.run(group.group_id, group.group_name, group.shop_ids.length, startedAt.toISOString());
      for (const shopId of group.shop_ids) statements.shopGroupMember.run(group.group_id, shopId);
    }
    const total = Number(first.total ?? 0);
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let fetchedSpu = first.data?.length ?? 0;
    let fetchedSku = insertRows(statements, first.data ?? []);
    onProgress({ completedPages: 1, pages, fetchedSpu, fetchedSku });

    for (let firstPage = 2; firstPage <= pages; firstPage += concurrency) {
      const pageNumbers = Array.from(
        { length: Math.min(concurrency, pages - firstPage + 1) },
        (_, index) => firstPage + index,
      );
      const payloads = await Promise.all(pageNumbers.map((page) => readPage(page)));
      for (const payload of payloads) {
        const rows = payload.data ?? [];
        fetchedSpu += rows.length;
        fetchedSku += insertRows(statements, rows);
      }
      onProgress({
        completedPages: pageNumbers.at(-1),
        pages,
        fetchedSpu,
        fetchedSku,
      });
    }

    const completedAt = new Date();
    const durationMs = Math.round(performance.now() - started);
    db.prepare(`
      INSERT INTO export_info (
        id, schema_version, started_at, completed_at, duration_ms, api_total_spu,
        fetched_spu, fetched_sku, pages, page_size, concurrency
      ) VALUES (1, 6, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      startedAt.toISOString(),
      completedAt.toISOString(),
      durationMs,
      total,
      fetchedSpu,
      fetchedSku,
      pages,
      pageSize,
      concurrency,
    );
    db.exec("COMMIT;");
    return {
      output: resolvedPath,
      duration_ms: durationMs,
      total_spu: total,
      fetched_spu: fetchedSpu,
      fetched_sku: fetchedSku,
      fetched_shops: shops.length,
      fetched_shop_groups: shopGroups.length,
      fetched_shop_group_members: shopGroups.reduce((sum, group) => sum + group.shop_ids.length, 0),
      pages,
      page_size: pageSize,
      concurrency,
    };
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  } finally {
    db.close();
  }
}
