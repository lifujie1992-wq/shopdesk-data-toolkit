import { DatabaseSync } from 'node:sqlite';
import { listSaleChannel } from './api.js';
import { todayShanghai } from './sales-analysis.js';

export const SALE_CHANNEL_SCHEMA = `CREATE TABLE IF NOT EXISTS sale_channel_snapshots (
  query_type TEXT NOT NULL, product_id TEXT NOT NULL, count_type TEXT NOT NULL,
  captured_at TEXT NOT NULL, total INTEGER NOT NULL, raw_json TEXT NOT NULL,
  PRIMARY KEY(query_type,product_id,count_type));`;

export async function exportSaleChannels({ session, outputPath, queryType = 'sku', concurrency = 16,
  fetchPage = options => listSaleChannel({ session, ...options }), onProgress = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!['spu', 'sku'].includes(queryType)) throw new Error('invalid_query_type');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('invalid_concurrency');
  const db = new DatabaseSync(outputPath);
  db.exec('PRAGMA busy_timeout=10000');
  async function fetchWithBusyRetry(options) {
    for (let attempt = 0; ; attempt++) {
      try { return await fetchPage(options); }
      catch (error) {
        if (error?.code !== 'api_error' || !error.message.includes('系统繁忙') || attempt >= 3) throw error;
        await wait(30_000);
      }
    }
  }
  try {
    const ids = db.prepare(`SELECT DISTINCT ${queryType}_id AS id FROM ${queryType}_inventory ORDER BY ${queryType}_id`).all().map(r => r.id);
    if (ids.some(id => typeof id !== 'string' || !id)) throw new Error('invalid_inventory_product');
    db.exec(SALE_CHANNEL_SCHEMA);
    db.exec(`CREATE TABLE IF NOT EXISTS sale_channel_pages (
      query_type TEXT NOT NULL, product_id TEXT NOT NULL, page INTEGER NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(query_type,product_id,page));
      CREATE TABLE IF NOT EXISTS sale_channel_complete (
      query_type TEXT NOT NULL, product_id TEXT NOT NULL, captured_at TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY(query_type,product_id));`);
    const done = new Set(db.prepare('SELECT product_id FROM sale_channel_complete WHERE query_type=?').all(queryType).map(r => r.product_id));
    const readPage = db.prepare('SELECT json FROM sale_channel_pages WHERE query_type=? AND product_id=? AND page=?');
    const savePage = db.prepare('INSERT INTO sale_channel_pages VALUES(?,?,?,?)');
    const save = db.prepare('INSERT INTO sale_channel_complete VALUES(?,?,?,?)');
    let completed = ids.filter(id => done.has(id)).length;
    const pending = ids.filter(id => !done.has(id));
    let next = 0; let failure;
    async function worker() {
      while (!failure && next < pending.length) {
        const productId = pending[next++];
        try {
          const rows = []; let total = null; let capturedAt = new Date().toISOString();
          for (let page = 1; ; page++) {
            const cached = readPage.get(queryType, productId, page);
            const result = cached ? JSON.parse(cached.json) : await fetchWithBusyRetry({
              ...(queryType === 'sku' ? { skuId: productId } : { spuId: productId }),
              countType: 'channel', page, pageSize: 100,
            });
            if (page === 1 && cached) capturedAt = result.captured_at;
            if (!capturedAt) throw new Error('sale_channel_missing_capture_time');
            if (todayShanghai(new Date(capturedAt)) !== todayShanghai()) throw new Error('sale_channel_checkpoint_previous_day');
            if (!Number.isInteger(result.total) || result.total < 0 || !Array.isArray(result.rows)
              || (total !== null && result.total !== total)) throw new Error('sale_channel_invalid_pagination');
            total = result.total;
            if (result.rows.length !== Math.min(100, total - rows.length)) throw new Error('sale_channel_incomplete_page');
            if (!cached) savePage.run(queryType, productId, page, JSON.stringify({ ...result, captured_at: capturedAt }));
            rows.push(...result.rows);
            if (rows.length === total) break;
          }
          // Keep every row, including unassigned and distributor-grain records.
          const snapshot = { query_type: queryType, product_id: productId,
            spu_id: queryType === 'spu' ? productId : null, sku_id: queryType === 'sku' ? productId : null,
            count_type: 'channel', total, captured_at: capturedAt, business_date: todayShanghai(new Date(capturedAt)),
            completed_at: new Date().toISOString(), source_api: 'purchase_alarm_sale_channel_detail', rows };
          save.run(queryType, productId, capturedAt, JSON.stringify(snapshot));
          completed++;
          onProgress({ completed, total: ids.length, query_type: queryType });
        } catch (error) { failure ??= error; }
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    if (failure) throw failure;
    const insert = db.prepare('INSERT INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)');
    const read = db.prepare('SELECT json FROM sale_channel_complete WHERE query_type=? AND product_id=?');
    let rowCount = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("DELETE FROM sale_channel_snapshots WHERE query_type=? AND count_type='channel'").run(queryType);
      for (const productId of ids) {
        const raw = read.get(queryType, productId).json;
        const snapshot = JSON.parse(raw);
        insert.run(queryType, productId, 'channel', snapshot.captured_at, snapshot.total, raw);
        rowCount += snapshot.total;
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { output: outputPath, query_type: queryType, fetched_products: completed, fetched_rows: rowCount,
      completed_at: new Date().toISOString(), source_api: 'purchase_alarm_sale_channel_detail' };
  } finally { db.close(); }
}
