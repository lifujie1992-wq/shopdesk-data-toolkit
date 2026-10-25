import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { callApi, callListApi, DEFAULT_PARAMS, PURCHASE_WARNING_CONTEXT } from './api.js';
import { todayShanghai } from './sales-analysis.js';

export const SHOP_SKU_BATCH_SCHEMA = `CREATE TABLE IF NOT EXISTS sale_channel_batch_snapshots (
  query_type TEXT NOT NULL, product_id TEXT NOT NULL, count_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, total INTEGER NOT NULL, raw_json TEXT NOT NULL,
  PRIMARY KEY(query_type,product_id,count_type));`;

const WINDOWS = ['pay_qty_today', 'pay_qty_3d', 'pay_qty_7d', 'pay_qty_15d', 'pay_qty_30d'];
const RAW_KEYS = ['sku_id', ...WINDOWS, 'shop_id', 'shop_name', 'platform',
  'dis_co_id', 'dis_co_name', 'distributor_id', 'distributor_name'];
const SOURCE_API = 'purchase_alarm_sku_detail_unfold';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

// The list API's responses describe a filtered inventory list, not a complete
// channel-popup snapshot. Keep this source separate even when values coincide.
function quality() {
  return { source_api: SOURCE_API, quality: 'batch_list', coverage: 'listed_shops_only',
    scope: 'listed_shops_only', complete: false, is_complete_popup: false,
    distributor_granularity: 'unavailable', raw_projection: true };
}

export function normalizeShops(input) {
  if (input?.code !== undefined && (input.code !== 0 || input.success !== true)) {
    throw new Error('shop_sku_invalid_shop_directory');
  }
  const groups = Array.isArray(input) ? input : input?.data;
  if (!Array.isArray(groups)) throw new Error('shop_sku_invalid_shop_directory');
  const result = new Map();
  for (const group of groups) {
    const members = Array.isArray(group?.shopList) ? group.shopList : [group];
    for (const shop of members) {
      const id = shop?.shop_id ?? shop?.shopId;
      const name = shop?.shop_name ?? shop?.shopName;
      const platform = shop?.platform ?? group.shopSite;
      if (!['string', 'number'].includes(typeof id) || String(id).length === 0
        || typeof name !== 'string' || typeof platform !== 'string' || !platform) {
        throw new Error('shop_sku_invalid_shop_identity');
      }
      // The live directory also contains account/configuration fields. Never
      // copy its objects wholesale into the database, progress output or upload.
      const row = { shop_id: String(id), shop_name: name, platform };
      const prior = result.get(row.shop_id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('shop_sku_conflicting_shop_identity');
      result.set(row.shop_id, row);
    }
  }
  if (!result.size) throw new Error('shop_sku_empty_shop_directory');
  return [...result.values()].sort((a, b) => a.shop_id.localeCompare(b.shop_id));
}

function assertSafeBusinessData(value, secrets) {
  if (typeof value === 'string') {
    if (secrets.some(secret => value.includes(secret)) || /(?:u_sso_token|u_co_id|u_id)\s*=/i.test(value)) {
      throw new Error('shop_sku_sensitive_business_payload');
    }
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (/^(?:cookie|set-cookie|authorization|u_sso_token|u_co_id|u_id|access_token|refresh_token|x-api-key)$/i.test(key)) {
        throw new Error('shop_sku_sensitive_business_payload');
      }
      assertSafeBusinessData(child, secrets);
    }
  }
}

function projectRow(row, shop, expected, seen, secrets) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || typeof row.sku_id !== 'string' || !expected.has(row.sku_id)) throw new Error('shop_sku_unexpected_sku');
  if (seen.has(row.sku_id)) throw new Error('shop_sku_duplicate_sku');
  if (row.shop_id != null && String(row.shop_id) !== shop.shop_id) throw new Error('shop_sku_unexpected_shop');
  const projected = {};
  for (const key of RAW_KEYS) {
    if (Object.hasOwn(row, key)) projected[key] = row[key];
  }
  for (const key of WINDOWS) {
    const value = projected[key];
    if (value != null && !['number', 'string'].includes(typeof value)) throw new Error('shop_sku_invalid_quantity');
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('shop_sku_invalid_quantity');
  }
  assertSafeBusinessData(projected, secrets);
  seen.add(row.sku_id);
  return projected;
}

function validatePublishedSnapshots(db, run) {
  const invalid = () => { throw new Error('shop_sku_invalid_published_checkpoint'); };
  const expectedIds = new Set(run.sku_ids);
  const expectedShops = new Map(run.shops.map(shop => [shop.shop_id, shop]));
  if (expectedIds.size !== run.sku_ids.length || run.published_skus !== expectedIds.size
    || run.published_shop_rows !== expectedIds.size * expectedShops.size
    || typeof run.published_at !== 'string' || Number.isNaN(Date.parse(run.published_at))
    || !/^[a-f0-9]{64}$/.test(run.snapshot_sha256 ?? '')) invalid();
  const digest = createHash('sha256');
  let count = 0;
  let shopRows = 0;
  for (const record of db.prepare("SELECT * FROM sale_channel_batch_snapshots WHERE query_type='sku' AND count_type='channel' ORDER BY product_id").iterate()) {
    let snapshot;
    try { snapshot = JSON.parse(record.raw_json); } catch { invalid(); }
    if (!expectedIds.delete(record.product_id) || snapshot?.query_type !== 'sku' || snapshot?.count_type !== 'channel'
      || snapshot.product_id !== record.product_id || snapshot.sku_id !== record.product_id || snapshot.spu_id !== null
      || snapshot.completed_at !== run.published_at || snapshot.business_date !== run.business_date
      || snapshot.captured_at !== record.captured_at || Number.isNaN(Date.parse(record.captured_at))
      || todayShanghai(new Date(record.captured_at)) !== run.business_date
      || snapshot.total !== record.total || record.total !== expectedShops.size
      || !Array.isArray(snapshot.rows) || snapshot.rows.length !== record.total
      || snapshot.listed_shop_count !== expectedShops.size
      || snapshot.unknown_shop_coverage !== 'unavailable'
      || snapshot.total_semantics !== 'queried_shop_rows_not_verified_sales_relationships'
      || Object.entries(quality()).some(([key, value]) => snapshot[key] !== value)) invalid();
    const seenShops = new Set();
    for (const row of snapshot.rows) {
      const shop = expectedShops.get(row?.shop_id);
      if (!shop || seenShops.has(row.shop_id) || row.sku_id !== record.product_id
        || row.platform !== shop.platform || row.shop_name !== shop.shop_name
        || row.relationship_verified !== false || row.identity_source !== 'shop_filter'
        || row.distributor_granularity !== 'unavailable') invalid();
      seenShops.add(row.shop_id);
    }
    digest.update(JSON.stringify([record.product_id, record.raw_json]) + '\n');
    count++; shopRows += record.total;
  }
  if (expectedIds.size || count !== run.published_skus || shopRows !== run.published_shop_rows
    || digest.digest('hex') !== run.snapshot_sha256) invalid();
}

export async function exportShopSkuBatches({ session, outputPath, shops,
  fetchShops = () => callApi(session, 'platform_shop_list', {}, {}, PURCHASE_WARNING_CONTEXT),
  fetchPage = params => callListApi(session, SOURCE_API, params,
    { customColumnTableCode: 'procurement_rt_warning_table' }, PURCHASE_WARNING_CONTEXT),
  onProgress = () => {}, now = () => new Date(), wait = sleep,
  batchSize = 500, pageSize = 500, intervalMs = 1500, maxBatches = Infinity } = {}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500
    || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) throw new Error('shop_sku_invalid_batch_size');
  if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('shop_sku_invalid_interval');
  if (maxBatches !== Infinity && (!Number.isInteger(maxBatches) || maxBatches < 0)) throw new Error('shop_sku_invalid_max_batches');
  const timestamp = () => new Date(typeof now === 'function' ? now() : now).toISOString();
  const day = () => todayShanghai(new Date(timestamp()));
  const secrets = (session?.cookies ?? []).map(cookie => cookie.value).filter(value => typeof value === 'string' && value.length >= 6);
  const db = new DatabaseSync(outputPath);
  db.exec('PRAGMA busy_timeout=10000');

  async function request(params) {
    for (let attempt = 0; ; attempt++) {
      // Queue the entire request: multiple collectors in this process cannot
      // send simultaneous inventory-list requests.
      const pending = requestQueue.then(async () => {
        const delay = Math.max(0, lastRequestAt + intervalMs - Date.now());
        if (delay) await wait(delay);
        lastRequestAt = Date.now();
        return fetchPage(params);
      });
      requestQueue = pending.catch(() => {});
      try { return await pending; }
      catch (error) {
        if (error?.code !== 'api_error' || !error.message.includes('系统繁忙') || attempt >= 3) throw error;
        await wait(30000);
      }
    }
  }

  try {
    db.exec(SHOP_SKU_BATCH_SCHEMA);
    db.exec(`CREATE TABLE IF NOT EXISTS sale_channel_batch_run(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sale_channel_batch_pages(
        shop_id TEXT NOT NULL,batch INTEGER NOT NULL,page INTEGER NOT NULL,total INTEGER NOT NULL,
        captured_at TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(shop_id,batch,page));
      CREATE TABLE IF NOT EXISTS sale_channel_batch_rows(
        shop_id TEXT NOT NULL,sku_id TEXT NOT NULL,batch INTEGER NOT NULL,page INTEGER NOT NULL,
        captured_at TEXT NOT NULL,raw_json TEXT NOT NULL,PRIMARY KEY(shop_id,sku_id));
      CREATE INDEX IF NOT EXISTS sale_channel_batch_rows_sku ON sale_channel_batch_rows(sku_id);
      CREATE TABLE IF NOT EXISTS sale_channel_batch_complete(
        shop_id TEXT NOT NULL,batch INTEGER NOT NULL,PRIMARY KEY(shop_id,batch));`);
    const inventoryIds = db.prepare('SELECT DISTINCT sku_id FROM sku_inventory ORDER BY sku_id').all().map(row => row.sku_id);
    if (!inventoryIds.length || inventoryIds.some(id => typeof id !== 'string' || !id)) throw new Error('shop_sku_invalid_inventory');
    assertSafeBusinessData(inventoryIds, secrets);
    const fingerprint = hash(inventoryIds);
    const prior = db.prepare('SELECT json FROM sale_channel_batch_run WHERE id=1').get();
    let run;
    if (prior) {
      run = JSON.parse(prior.json);
      if (run.version !== 1) throw new Error('shop_sku_invalid_checkpoint_version');
      // Finished data can be uploaded on a later day without recapturing or
      // pretending its values are current. Only unfinished collection is dated.
      if (run.published !== true && run.business_date !== day()) throw new Error('shop_sku_checkpoint_previous_day');
      if (run.inventory_hash !== fingerprint || run.batch_size !== batchSize || run.page_size !== pageSize) throw new Error('shop_sku_checkpoint_inventory_or_batch_mismatch');
      if (shops !== undefined && hash(normalizeShops(shops)) !== hash(run.shops)) throw new Error('shop_sku_checkpoint_shop_mismatch');
    } else {
      const alreadyComplete = new Set();
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sale_channel_snapshots'").get()) {
        for (const row of db.prepare("SELECT product_id,captured_at,total,raw_json FROM sale_channel_snapshots WHERE query_type='sku' AND count_type='channel'").iterate()) {
          let data;
          try { data = JSON.parse(row.raw_json); } catch { continue; }
          if (Number.isNaN(Date.parse(row.captured_at)) || todayShanghai(new Date(row.captured_at)) !== day()) continue;
          if (data.query_type === 'sku' && data.count_type === 'channel' && data.sku_id === row.product_id
            && data.source_api === 'purchase_alarm_sale_channel_detail' && data.complete !== false
            && data.is_complete_popup !== false && Array.isArray(data.rows)
            && Number.isInteger(data.total) && data.total === row.total && data.total === data.rows.length) alreadyComplete.add(row.product_id);
        }
      }
      const pendingIds = inventoryIds.filter(id => !alreadyComplete.has(id));
      // No missing SKU means there is nothing to discover or fetch upstream.
      // An empty directory is meaningful only for this zero-target generation.
      const directory = pendingIds.length || shops !== undefined
        ? normalizeShops(shops ?? await fetchShops()) : [];
      assertSafeBusinessData(directory, secrets);
      run = { version: 1, published: false, business_date: day(), started_at: timestamp(), inventory_hash: fingerprint,
        inventory_total: inventoryIds.length, sku_ids: pendingIds,
        skipped_complete_skus: inventoryIds.filter(id => alreadyComplete.has(id)).length,
        batch_size: batchSize, page_size: pageSize, shops: directory };
      assertSafeBusinessData(run, secrets);
      db.prepare('INSERT INTO sale_channel_batch_run VALUES(1,?)').run(JSON.stringify(run));
    }
    const batchesPerShop = Math.ceil(run.sku_ids.length / batchSize);
    const totalBatches = batchesPerShop * run.shops.length;
    let completedBatches = db.prepare('SELECT COUNT(*) n FROM sale_channel_batch_complete').get().n;
    let fetchedBatches = 0;
    let fetchedPages = 0;
    const stats = published => ({ output: outputPath, published, source_api: SOURCE_API,
      query_type: 'sku', count_type: 'channel', total_skus: run.inventory_total,
      target_skus: run.sku_ids.length, skipped_complete_skus: run.skipped_complete_skus,
      total_shops: run.shops.length, completed_batches: completedBatches, total_batches: totalBatches,
      fetched_batches: fetchedBatches, fetched_pages: fetchedPages, business_date: run.business_date });
    if (run.published === true) {
      validatePublishedSnapshots(db, run);
      return { ...stats(true), fetched_products: run.published_skus, fetched_rows: run.published_shop_rows,
        published_skus: run.published_skus, published_shop_rows: run.published_shop_rows,
        published_at: run.published_at, completed_at: run.published_at, resumed_published: true };
    }
    const assertDay = () => {
      if (day() !== run.business_date) throw new Error('shop_sku_checkpoint_previous_day');
    };
    const complete = db.prepare('SELECT 1 FROM sale_channel_batch_complete WHERE shop_id=? AND batch=?');
    const readPage = db.prepare('SELECT * FROM sale_channel_batch_pages WHERE shop_id=? AND batch=? AND page=?');
    const readRows = db.prepare('SELECT raw_json FROM sale_channel_batch_rows WHERE shop_id=? AND batch=? AND page=? ORDER BY sku_id');
    const savePage = db.prepare('INSERT INTO sale_channel_batch_pages VALUES(?,?,?,?,?,?)');
    const saveRow = db.prepare('INSERT INTO sale_channel_batch_rows VALUES(?,?,?,?,?,?)');
    for (const shop of run.shops) {
      for (let batch = 0; batch < batchesPerShop; batch++) {
        assertDay();
        if (complete.get(shop.shop_id, batch)) continue;
        if (fetchedBatches >= maxBatches) return stats(false);
        const skuIds = run.sku_ids.slice(batch * batchSize, (batch + 1) * batchSize);
        const expected = new Set(skuIds);
        const seen = new Set();
        for (let page = 1; seen.size < skuIds.length; page++) {
          assertDay();
          const cached = readPage.get(shop.shop_id, batch, page);
          if (cached) {
            if (cached.total !== skuIds.length || todayShanghai(new Date(cached.captured_at)) !== run.business_date) throw new Error('shop_sku_invalid_cached_page');
            const records = readRows.all(shop.shop_id, batch, page);
            if (records.length !== Math.min(pageSize, skuIds.length - seen.size)) throw new Error('shop_sku_incomplete_cached_page');
            for (const record of records) projectRow(JSON.parse(record.raw_json), shop, expected, seen, secrets);
            continue;
          }
          const params = { ...structuredClone(DEFAULT_PARAMS), viewType: 'sku', excludeNoPayQtyFlag: 0,
            shopIds: [shop.shop_id], skuIds, pageNum: page, pageSize,
            sortMap: { advice_purchase_qty: 'DESC' } };
          const capturedAt = timestamp();
          const response = await request(params);
          assertDay();
          if (response?.code !== undefined && (response.code !== 0 || response.success !== true)) throw new Error('shop_sku_invalid_api_response');
          const rows = response?.rows ?? response?.data;
          const total = response?.total;
          if (!Number.isInteger(total) || total !== skuIds.length || !Array.isArray(rows)) throw new Error('shop_sku_incomplete_batch_total');
          if (rows.length !== Math.min(pageSize, total - seen.size)) throw new Error('shop_sku_incomplete_page');
          const projected = rows.map(row => projectRow(row, shop, expected, seen, secrets));
          db.exec('BEGIN IMMEDIATE');
          try {
            savePage.run(shop.shop_id, batch, page, total, capturedAt, JSON.stringify({ source_api: SOURCE_API,
              api_params: params, raw_projection: true, raw_fields: RAW_KEYS, rows: projected.length }));
            for (const row of projected) saveRow.run(shop.shop_id, row.sku_id, batch, page, capturedAt, JSON.stringify(row));
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          fetchedPages++;
        }
        if (seen.size !== skuIds.length) throw new Error('shop_sku_missing_sku');
        db.prepare('INSERT INTO sale_channel_batch_complete VALUES(?,?)').run(shop.shop_id, batch);
        completedBatches++; fetchedBatches++;
        onProgress(stats(false));
      }
    }
    assertDay();
    if (completedBatches !== totalBatches) throw new Error('shop_sku_incomplete_run');
    const completedAt = timestamp();
    const observations = db.prepare('SELECT * FROM sale_channel_batch_rows WHERE sku_id=? ORDER BY shop_id');
    const insert = db.prepare('INSERT INTO sale_channel_batch_snapshots VALUES(?,?,?,?,?,?)');
    const shopMap = new Map(run.shops.map(shop => [shop.shop_id, shop]));
    const snapshotDigest = createHash('sha256');
    let publishedRows = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM sale_channel_batch_snapshots WHERE query_type='sku' AND count_type='channel'").run();
      for (const skuId of run.sku_ids) {
        const records = observations.all(skuId);
        if (records.length !== run.shops.length) throw new Error('shop_sku_incomplete_snapshot');
        const rows = records.map(record => {
          const raw = JSON.parse(record.raw_json);
          return { ...shopMap.get(record.shop_id), sku_id: skuId,
            ...Object.fromEntries(WINDOWS.map(key => [key, raw[key] ?? null])),
            captured_at: record.captured_at, relationship_verified: false,
            identity_source: 'shop_filter', distributor_granularity: 'unavailable', raw_json: raw };
        });
        const captures = records.map(record => record.captured_at).sort();
        const snapshot = { ...quality(), query_type: 'sku', product_id: skuId, sku_id: skuId, spu_id: null,
          count_type: 'channel', captured_at: captures[0],
          capture_started_at: captures[0], capture_ended_at: captures.at(-1), completed_at: completedAt,
          business_date: run.business_date, total: rows.length,
          total_semantics: 'queried_shop_rows_not_verified_sales_relationships',
          listed_shop_count: run.shops.length, unknown_shop_coverage: 'unavailable', rows };
        // ISO timestamps are UTC; this separate value is an actual +08:00
        // timestamp, not a relabelled UTC time.
        snapshot.captured_at_beijing = new Date(Date.parse(snapshot.captured_at) + 8 * 3600000).toISOString().replace('Z', '+08:00');
        const serialized = JSON.stringify(snapshot);
        insert.run('sku', skuId, 'channel', snapshot.captured_at, snapshot.total, serialized);
        snapshotDigest.update(JSON.stringify([skuId, serialized]) + '\n');
        publishedRows += rows.length;
      }
      assertDay();
      run = { ...run, published: true, published_at: completedAt, published_skus: run.sku_ids.length,
        published_shop_rows: publishedRows, snapshot_sha256: snapshotDigest.digest('hex') };
      db.prepare('UPDATE sale_channel_batch_run SET json=? WHERE id=1').run(JSON.stringify(run));
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { ...stats(true), fetched_products: run.sku_ids.length, fetched_rows: publishedRows,
      published_skus: run.sku_ids.length, published_shop_rows: publishedRows,
      published_at: completedAt, completed_at: completedAt };
  } finally { db.close(); }
}
