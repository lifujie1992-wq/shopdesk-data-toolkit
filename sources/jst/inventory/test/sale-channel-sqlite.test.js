import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSaleChannels, SALE_CHANNEL_SCHEMA } from '../src/sale-channel-sqlite.js';

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'sale-channel-')), 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec(SALE_CHANNEL_SCHEMA);
  db.prepare('INSERT INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)').run('sku','001','channel','old',1,JSON.stringify({ rows: [{ pay_qty_today: 99 }] }));
  db.exec("CREATE TABLE sku_inventory(sku_id TEXT PRIMARY KEY); INSERT INTO sku_inventory VALUES('001');");
  db.exec(`CREATE TABLE spu_inventory(spu_id TEXT PRIMARY KEY);
    INSERT INTO spu_inventory VALUES('001');
    CREATE TABLE shop_product_sales_analysis(spu_id TEXT,shop_id TEXT,shop_name TEXT,platform TEXT,
      start_date TEXT,end_date TEXT,previous_start_date TEXT,previous_end_date TEXT,
      pay_qty_today REAL,pay_qty_3d REAL,pay_qty_7d REAL,pay_qty_15d REAL,pay_qty_30d REAL,raw_json TEXT,
      PRIMARY KEY(spu_id,shop_id));
    INSERT INTO shop_product_sales_analysis(spu_id,shop_id,pay_qty_today) VALUES('001','old',99);`);
  return { db, path };
}
test('complete pagination, raw values, all platforms and -1 survive; failed page resumes atomically', async () => {
  const { db, path } = fixture();
  const rows = Array.from({ length: 101 }, (_, i) => ({ shop_id: i === 0 ? -1 : i,
    platform: ['其他','拼多多','抖音','淘宝','天猫','快手'][i % 6], shop_name: `店${i}`,
    pay_qty_today: i === 0 ? null : 0, pay_qty_3d: 3, pay_qty_7d: 7, pay_qty_15d: 15, pay_qty_30d: 30 }));
  const seen = [];
  let fail = true;
  const fetchPage = async options => {
    assert.equal(options.countType, 'channel'); assert.equal(options.skuId, '001');
    assert.equal(options.spuId, undefined);
    assert.equal(options.platforms, undefined); seen.push(options.page);
    if (fail && options.page === 2) throw new Error('simulated');
    return { total: 101, rows: rows.slice((options.page-1)*100, options.page*100) };
  };
  await assert.rejects(exportSaleChannels({ outputPath: path, fetchPage }), /simulated/);
  assert.equal(db.prepare('SELECT captured_at FROM sale_channel_snapshots').get().captured_at, 'old');
  fail = false;
  const result = await exportSaleChannels({ outputPath: path, fetchPage });
  assert.deepEqual(seen, [1,2,2]); assert.equal(result.fetched_rows, 101);
  const raw = JSON.parse(db.prepare('SELECT raw_json FROM sale_channel_snapshots').get().raw_json);
  assert.equal(raw.rows[0].pay_qty_today, null);
  assert.equal(new Set(raw.rows.map(row => row.platform)).size, 6);
  assert.equal(raw.rows[1].pay_qty_today, 0); assert.equal(raw.rows[1].pay_qty_30d, 30); assert.ok(raw.captured_at);
  assert.equal(db.prepare('SELECT pay_qty_today FROM shop_product_sales_analysis').get().pay_qty_today, 99);
  db.close();
});
test('short page cannot overwrite a good snapshot', async () => {
  for (const response of [{ total: 2, rows: [{ shop_id: 1 }] }]) {
    const { db, path } = fixture();
    await assert.rejects(exportSaleChannels({ outputPath: path, fetchPage: async () => response }));
    assert.equal(db.prepare('SELECT pay_qty_today FROM shop_product_sales_analysis').get().pay_qty_today, 99);
    db.close();
  }
});
test('SPU and SKU stay separate; distributors with the same -1 shop identity are preserved', async () => {
  const { db, path } = fixture();
  const response = { total: 2, rows: [{ shop_id: -1, distributor_id: 'a' }, { shop_id: -1, distributor_id: 'b' }] };
  await exportSaleChannels({ outputPath: path, queryType: 'spu', fetchPage: async options => {
    assert.equal(options.spuId,'001'); assert.equal(options.skuId,undefined); return response;
  }});
  assert.equal(db.prepare('SELECT count(*) n FROM sale_channel_snapshots').get().n, 2);
  assert.deepEqual(JSON.parse(db.prepare("SELECT raw_json FROM sale_channel_snapshots WHERE query_type='spu'").get().raw_json).rows, response.rows);
  db.close();
});
test('temporary busy errors retry the same page with a bounded delay', async () => {
  const { db, path } = fixture();
  let calls = 0;
  const delays = [];
  await exportSaleChannels({ outputPath: path, wait: async ms => delays.push(ms), fetchPage: async options => {
    assert.equal(options.skuId, '001'); assert.equal(options.page, 1);
    if (++calls < 3) throw Object.assign(new Error('系统繁忙，请稍后再试'), { code: 'api_error' });
    return { total: 0, rows: [] };
  }});
  assert.equal(calls, 3); assert.deepEqual(delays, [30000,30000]);
  assert.equal(db.prepare('SELECT total FROM sale_channel_snapshots').get().total, 0);
  db.close();
});
