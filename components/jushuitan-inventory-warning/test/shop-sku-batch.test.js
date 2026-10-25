import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportShopSkuBatches, SHOP_SKU_BATCH_SCHEMA } from '../src/shop-sku-batch.js';
import { SALE_CHANNEL_SCHEMA } from '../src/sale-channel-sqlite.js';

const captured = '2026-09-09T02:00:00.000Z';
const now = () => new Date(captured);
const shops = [{ shop_id: '1', shop_name: '拼多多店', platform: '拼多多' }];
const windows = { pay_qty_today: 0, pay_qty_3d: null, pay_qty_7d: 7, pay_qty_15d: 15, pay_qty_30d: 30 };

function fixture(t, ids = ['A', 'B']) {
  const dir = mkdtempSync(join(tmpdir(), 'shop-sku-batch-'));
  const path = join(dir, 'test.sqlite');
  const db = new DatabaseSync(path);
  db.exec(SHOP_SKU_BATCH_SCHEMA + SALE_CHANNEL_SCHEMA);
  db.exec('CREATE TABLE sku_inventory(sku_id TEXT PRIMARY KEY,raw_json TEXT);');
  for (const id of ids) db.prepare('INSERT INTO sku_inventory VALUES(?,?)').run(id, '{}');
  db.prepare('INSERT INTO sale_channel_batch_snapshots VALUES(?,?,?,?,?,?)')
    .run('sku', 'OLD', 'channel', 'old', 1, JSON.stringify({ rows: [{ pay_qty_today: 99 }] }));
  const original = JSON.stringify({ query_type: 'sku', sku_id: 'A', count_type: 'channel',
    captured_at: '2026-09-08T02:00:00.000Z', total: 1, rows: [{ shop_id: -1, pay_qty_today: 88 }],
    source_api: 'purchase_alarm_sale_channel_detail' });
  db.prepare('INSERT INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)')
    .run('sku', 'A', 'channel', '2026-09-08T02:00:00.000Z', 1, original);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, path, original, options: { outputPath: path, now, shops, intervalMs: 0, wait: async () => {} } };
}
const page = params => ({ total: params.skuIds.length,
  rows: params.skuIds.slice((params.pageNum - 1) * params.pageSize, params.pageNum * params.pageSize)
    .map(sku_id => ({ sku_id, ...windows })) });
const snapshots = db => db.prepare('SELECT raw_json FROM sale_channel_batch_snapshots ORDER BY product_id').all().map(row => JSON.parse(row.raw_json));

test('production requests only the verified shop directory and 500-SKU list; raw values and all platforms survive', async t => {
  const { db, options, original } = fixture(t);
  const platforms = ['拼多多', '淘宝', '天猫', '抖音', '快手', '其他'];
  const requests = [];
  const session = { cookies: [{ name: 'u_sso_token', value: 'secret-session-12345' },
    { name: 'u_id', value: '22222222' }, { name: 'u_co_id', value: '33333333' }] };
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async (url, init) => {
    const apiCode = new URL(url).searchParams.get('apiCode');
    const params = JSON.parse(init.body).data.apiParams;
    requests.push({ apiCode, params });
    if (apiCode === 'platform_shop_list') return { ok: true, json: async () => ({ code: 0, success: true,
      data: platforms.map((platform, i) => ({ shopSite: platform, hasAllAuthShop: false,
        shopList: [{ shopId: i === 5 ? -1 : i + 1, shopName: `${platform}店`, platform,
          sessionUid: 'secret-session-12345', shopSetting: { cookie: 'do not persist' }, impower: false }] })) }) };
    assert.equal(apiCode, 'purchase_alarm_sku_detail_unfold');
    assert.equal(params.viewType, 'sku'); assert.equal(params.excludeNoPayQtyFlag, 0);
    assert.equal(params.pageSize, 500); assert.equal(params.shopIds.length, 1);
    assert.deepEqual(params.skuIds, ['A', 'B']);
    for (const forbidden of ['spuId', 'platforms', 'countType', 'startDate', 'endDate']) assert.equal(params[forbidden], undefined);
    return { ok: true, json: async () => ({ code: 0, success: true, total: 2,
      data: [{ sku_id: 'A', ...windows, pay_qty_7d: '007', distributor_id: 'dis-a',
        unrelated_configuration: { token: 'should not persist' } }, { sku_id: 'B', pay_qty_today: null }] }) };
  };
  const result = await exportShopSkuBatches({ ...options, shops: undefined, session });
  assert.equal(result.published, true); assert.equal(result.published_skus, 2); assert.equal(result.published_shop_rows, 12);
  assert.deepEqual(requests.map(row => row.apiCode), ['platform_shop_list', ...platforms.map(() => 'purchase_alarm_sku_detail_unfold')]);
  const [first, second] = snapshots(db);
  assert.deepEqual(new Set(first.rows.map(row => row.platform)), new Set(platforms));
  assert.equal(first.rows.find(row => row.platform === '其他').shop_id, '-1');
  assert.equal(first.rows[0].pay_qty_today, 0); assert.equal(first.rows[0].pay_qty_3d, null);
  assert.equal(first.rows[0].pay_qty_7d, '007'); assert.equal(first.rows[0].raw_json.distributor_id, 'dis-a');
  assert.equal(second.rows[0].pay_qty_7d, null); assert.equal(Object.hasOwn(second.rows[0].raw_json, 'pay_qty_7d'), false);
  assert.equal(Object.hasOwn(second.rows[0].raw_json, 'pay_qty_today'), true);
  assert.equal(first.complete, false); assert.equal(first.is_complete_popup, false);
  assert.equal(first.coverage, 'listed_shops_only'); assert.equal(first.quality, 'batch_list');
  assert.equal(first.distributor_granularity, 'unavailable'); assert.equal(first.rows[0].relationship_verified, false);
  assert.equal(first.captured_at, captured); assert.equal(first.captured_at_beijing, '2026-09-09T10:00:00.000+08:00');
  assert.equal(db.prepare('SELECT raw_json FROM sale_channel_snapshots').get().raw_json, original);
  for (const table of ['sale_channel_batch_run', 'sale_channel_batch_pages', 'sale_channel_batch_rows', 'sale_channel_batch_snapshots']) {
    const serialized = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all());
    for (const secret of ['secret-session-12345', '22222222', '33333333', 'shopSetting', 'sessionUid', 'do not persist', 'should not persist']) {
      assert.equal(serialized.includes(secret), false);
    }
  }
});

test('500 target SKUs use one request, remainder uses the next batch', async t => {
  const { options, db } = fixture(t, Array.from({ length: 501 }, (_, i) => String(i).padStart(4, '0')));
  const sizes = [];
  const result = await exportShopSkuBatches({ ...options, fetchPage: async params => {
    sizes.push(params.skuIds.length); assert.equal(params.pageNum, 1); return page(params);
  }});
  assert.deepEqual(sizes, [500, 1]); assert.equal(result.total_batches, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sale_channel_batch_snapshots').get().n, 501);
});

test('successful pages persist; failed page alone resumes; old snapshots remain atomic', async t => {
  const { options, db, original } = fixture(t);
  const calls = [];
  let failing = true;
  const fetchPage = async params => {
    calls.push(params.pageNum);
    if (failing && params.pageNum === 2) throw new Error('simulated page failure');
    return page(params);
  };
  await assert.rejects(exportShopSkuBatches({ ...options, pageSize: 1, fetchPage }), /simulated/);
  assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sale_channel_batch_pages').get().n, 1);
  failing = false;
  const result = await exportShopSkuBatches({ ...options, pageSize: 1, fetchPage });
  assert.deepEqual(calls, [1, 2, 2]); assert.equal(result.published, true);
  assert.equal(result.fetched_pages, 1); assert.equal(db.prepare('SELECT raw_json FROM sale_channel_snapshots').get().raw_json, original);
});

test('bounded trial keeps staged rows private and resumes only unfinished shops', async t => {
  const { options, db } = fixture(t);
  const directory = [...shops, { shop_id: '2', shop_name: '抖音店', platform: '抖音' }];
  const seen = [];
  const fetchPage = async params => { seen.push(params.shopIds[0]); return page(params); };
  const trial = await exportShopSkuBatches({ ...options, shops: directory, fetchPage, maxBatches: 1 });
  assert.equal(trial.published, false); assert.equal(trial.completed_batches, 1);
  assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
  const finished = await exportShopSkuBatches({ ...options, shops: undefined,
    fetchShops: async () => { throw new Error('directory must be frozen'); }, fetchPage });
  assert.equal(finished.published, true); assert.deepEqual(seen, ['1', '2']);
  assert.equal(snapshots(db)[0].total, 2);
});

test('same-day complete popup SKUs are reused, stale and malformed snapshots are not trusted', async t => {
  const { options, db } = fixture(t, ['A', 'B', 'C']);
  const full = { query_type: 'sku', sku_id: 'A', count_type: 'channel', captured_at: captured,
    source_api: 'purchase_alarm_sale_channel_detail', total: 1, rows: [{ shop_id: -1, pay_qty_today: 99 }] };
  db.prepare('UPDATE sale_channel_snapshots SET captured_at=?,raw_json=? WHERE product_id=?').run(captured, JSON.stringify(full), 'A');
  db.prepare('INSERT INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)').run('sku', 'C', 'channel', captured, 2,
    JSON.stringify({ ...full, sku_id: 'C' }));
  const seen = [];
  const result = await exportShopSkuBatches({ ...options, fetchPage: async params => { seen.push(...params.skuIds); return page(params); } });
  assert.deepEqual(seen, ['B', 'C']); assert.equal(result.skipped_complete_skus, 1);
  assert.equal(db.prepare('SELECT raw_json FROM sale_channel_snapshots WHERE product_id=?').get('A').raw_json, JSON.stringify(full));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sale_channel_batch_snapshots WHERE product_id=?').get('A').n, 0);
});

test('cross-day and changed inventory checkpoints fail before another request', async t => {
  const { options, db } = fixture(t);
  await exportShopSkuBatches({ ...options, maxBatches: 0, fetchPage: async () => { throw new Error('not reached'); } });
  let calls = 0;
  const fetchPage = async params => { calls++; return page(params); };
  await assert.rejects(exportShopSkuBatches({ ...options, now: () => new Date('2026-09-10T02:00:00Z'), fetchPage }), /previous_day/);
  db.prepare('INSERT INTO sku_inventory VALUES(?,?)').run('new-sku', '{}');
  await assert.rejects(exportShopSkuBatches({ ...options, fetchPage }), /inventory_or_batch_mismatch/);
  assert.equal(calls, 0); assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
});

test('unexpected, duplicate, missing and failed API pages cannot publish', async t => {
  const cases = [
    { total: 2, rows: [{ sku_id: 'A' }, { sku_id: 'A' }] },
    { total: 2, rows: [{ sku_id: 'A' }, { sku_id: 'OTHER' }] },
    { total: 1, rows: [{ sku_id: 'A' }] },
    { total: 2, rows: [{ sku_id: 'A' }] },
    { total: 2, rows: [{ sku_id: 'A', shop_id: 'wrong' }, { sku_id: 'B' }] },
    { code: 404, success: false, total: 2, data: [{ sku_id: 'A' }, { sku_id: 'B' }] },
  ];
  for (const response of cases) {
    const { options, db } = fixture(t);
    await assert.rejects(exportShopSkuBatches({ ...options, fetchPage: async () => response }));
    assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sale_channel_batch_rows').get().n, 0);
  }
});

test('explicit busy response retries the same page at most three times', async t => {
  const { options, db } = fixture(t);
  let calls = 0;
  const delays = [];
  const fetchPage = async params => {
    calls++; assert.equal(params.pageNum, 1);
    throw Object.assign(new Error('系统繁忙，请稍后再试'), { code: 'api_error' });
  };
  await assert.rejects(exportShopSkuBatches({ ...options, fetchPage, wait: async ms => delays.push(ms) }), /系统繁忙/);
  assert.equal(calls, 4); assert.deepEqual(delays, [30000, 30000, 30000]);
  assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
});

test('credential-bearing projected response is rejected without storing its value', async t => {
  const { options, db } = fixture(t);
  const token = 'token-secret-not-business';
  await assert.rejects(exportShopSkuBatches({ ...options, session: { cookies: [{ name: 'u_sso_token', value: token }] },
    fetchPage: async () => ({ total: 2, rows: [{ sku_id: 'A', shop_name: token }, { sku_id: 'B' }] }) }),
  /sensitive_business_payload/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sale_channel_batch_rows').get().n, 0);
});

test('a final snapshot write failure rolls back the entire published generation', async t => {
  const { options, db } = fixture(t);
  db.exec(`CREATE TRIGGER fail_second_snapshot BEFORE INSERT ON sale_channel_batch_snapshots
    WHEN NEW.product_id='B' BEGIN SELECT RAISE(ABORT,'simulated final write failure'); END;`);
  let requests = 0;
  const fetchPage = async params => { requests++; return page(params); };
  await assert.rejects(exportShopSkuBatches({ ...options, fetchPage }), /simulated final write failure/);
  assert.equal(snapshots(db).length, 1); assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
  db.exec('DROP TRIGGER fail_second_snapshot');
  const resumed = await exportShopSkuBatches({ ...options, fetchPage });
  assert.equal(resumed.published, true); assert.equal(requests, 1);
  assert.equal(snapshots(db).length, 2);
});

test('the same shop ID under conflicting platforms fails instead of silently dropping a directory row', async t => {
  const { options, db } = fixture(t);
  let calls = 0;
  await assert.rejects(exportShopSkuBatches({ ...options,
    shops: [{ shop_id: -1, shop_name: '未知', platform: '拼多多' },
      { shop_id: -1, shop_name: '未知', platform: '抖音' }],
    fetchPage: async params => { calls++; return page(params); } }), /conflicting_shop_identity/);
  assert.equal(calls, 0); assert.equal(snapshots(db)[0].rows[0].pay_qty_today, 99);
});

test('published snapshots resume on the same day or later without a request or version change', async t => {
  const { options, db } = fixture(t);
  const first = await exportShopSkuBatches({ ...options, fetchPage: async params => page(params) });
  const originalSnapshots = db.prepare('SELECT * FROM sale_channel_batch_snapshots ORDER BY product_id').all();
  const originalRun = db.prepare('SELECT json FROM sale_channel_batch_run').get().json;
  const run = JSON.parse(originalRun);
  assert.equal(run.published, true); assert.equal(run.published_at, first.completed_at);
  assert.equal(run.published_skus, 2); assert.equal(run.published_shop_rows, 2);
  assert.match(run.snapshot_sha256, /^[a-f0-9]{64}$/);
  let requests = 0;
  const noFetch = async () => { requests++; throw new Error('published snapshots must not be recollected'); };
  for (const moment of ['2026-09-09T05:00:00.000Z', '2026-09-11T06:00:00.000Z']) {
    const resumed = await exportShopSkuBatches({ ...options, shops: undefined, now: () => new Date(moment),
      fetchShops: noFetch, fetchPage: noFetch });
    assert.equal(resumed.published, true); assert.equal(resumed.resumed_published, true);
    assert.equal(resumed.fetched_pages, 0); assert.equal(resumed.fetched_batches, 0);
    assert.equal(resumed.completed_at, first.completed_at); assert.equal(resumed.published_at, first.published_at);
    assert.equal(resumed.business_date, '2026-09-09');
    assert.deepEqual(db.prepare('SELECT * FROM sale_channel_batch_snapshots ORDER BY product_id').all(), originalSnapshots);
    assert.equal(db.prepare('SELECT json FROM sale_channel_batch_run').get().json, originalRun);
  }
  assert.equal(requests, 0);
});

test('published resume rejects changed scope or incomplete/tampered snapshots without recapturing', async t => {
  const { options, db } = fixture(t);
  await exportShopSkuBatches({ ...options, fetchPage: async params => page(params) });
  let requests = 0;
  const fetchPage = async () => { requests++; throw new Error('do not recapture'); };
  await assert.rejects(exportShopSkuBatches({ ...options, batchSize: 100, fetchPage }), /inventory_or_batch_mismatch/);
  await assert.rejects(exportShopSkuBatches({ ...options, shops: [{ shop_id: '2', shop_name: '店2', platform: '拼多多' }], fetchPage }), /shop_mismatch/);
  const row = db.prepare('SELECT raw_json FROM sale_channel_batch_snapshots WHERE product_id=?').get('A');
  const changed = JSON.parse(row.raw_json);
  changed.rows[0].pay_qty_today = 123456;
  db.prepare('UPDATE sale_channel_batch_snapshots SET raw_json=? WHERE product_id=?').run(JSON.stringify(changed), 'A');
  await assert.rejects(exportShopSkuBatches({ ...options, fetchPage }), /invalid_published_checkpoint/);
  db.prepare('UPDATE sale_channel_batch_snapshots SET raw_json=? WHERE product_id=?').run(row.raw_json, 'A');
  db.prepare('DELETE FROM sale_channel_batch_snapshots WHERE product_id=?').run('B');
  await assert.rejects(exportShopSkuBatches({ ...options, now: () => new Date('2026-09-10T02:00:00Z'), fetchPage }), /invalid_published_checkpoint/);
  assert.equal(requests, 0);
});

test('all SKUs with same-day complete popups need neither a directory nor any upstream requests', async t => {
  const { options, db } = fixture(t);
  for (const skuId of ['A', 'B']) {
    const snapshot = { query_type: 'sku', sku_id: skuId, count_type: 'channel', captured_at: captured,
      source_api: 'purchase_alarm_sale_channel_detail', total: 1, rows: [{ shop_id: -1, pay_qty_today: 99 }] };
    db.prepare('INSERT OR REPLACE INTO sale_channel_snapshots VALUES(?,?,?,?,?,?)')
      .run('sku', skuId, 'channel', captured, 1, JSON.stringify(snapshot));
  }
  const original = db.prepare('SELECT * FROM sale_channel_snapshots ORDER BY product_id').all();
  let requests = 0;
  const noFetch = async () => { requests++; throw new Error('all SKUs are already complete'); };
  const first = await exportShopSkuBatches({ ...options, shops: undefined, fetchShops: noFetch, fetchPage: noFetch });
  assert.equal(first.published, true); assert.equal(first.target_skus, 0); assert.equal(first.skipped_complete_skus, 2);
  assert.equal(first.total_shops, 0); assert.equal(first.published_skus, 0); assert.equal(first.published_shop_rows, 0);
  assert.deepEqual(snapshots(db), []);
  const resumed = await exportShopSkuBatches({ ...options, shops: undefined,
    now: () => new Date('2026-09-10T02:00:00.000Z'), fetchShops: noFetch, fetchPage: noFetch });
  assert.equal(resumed.published, true); assert.equal(resumed.resumed_published, true);
  assert.equal(resumed.completed_at, first.completed_at); assert.equal(requests, 0);
  assert.deepEqual(db.prepare('SELECT * FROM sale_channel_snapshots ORDER BY product_id').all(), original);
});
