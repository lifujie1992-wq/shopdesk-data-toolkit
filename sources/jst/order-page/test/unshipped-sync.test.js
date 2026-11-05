import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { syncUnshipped, unshippedItemQty, UNSHIPPED_SCHEMA_VERSION } from '../src/unshipped-sync.js';

const ORDER = {
  o_id: 9001, so_id: 'SO-9001', shop_id: 20190470, shop_name: '示例旗舰店', shop_site: '头条放心购',
  status: '发货中', src_status: 'Delivering', type: '普通订单', labels: '优先发货',
  order_date: '2026-11-01 10:00:00', pay_date: '2026-11-01 10:00:05', confirm_date: '2026-11-01 10:01:00',
  plan_delivery_date: '2026-11-05 10:00:05', deliver_time_left: 3600, promise_time: null, send_date: null,
  wms_co_id: 10374294, wms_co_name: '主仓', paid_amount: 199.8, pay_amount: 199.8,
  norefund_item_qty: 4, norefund_item_amount: 199.8,
};

function item(overrides) {
  return {
    o_id: 9001, oi_id: 1, i_id: 'SKU-IID-1', sku_id: 'SKU-1-红-L', sku_type: 'normal',
    is_gift: false, qty: 1, item_status: null, item_plan_delivery_date: null, ...overrides,
  };
}

const PAGE = [
  {
    ...ORDER,
    items: [
      item({ oi_id: 11, i_id: 'IID-A', sku_id: 'A-红-L', qty: 2, item_plan_delivery_date: '2026-11-03 12:00:00' }),
      item({ oi_id: 12, i_id: '好评卡', sku_id: '好评卡', sku_type: 'no_deliver', is_gift: true, qty: 1 }),
      item({ oi_id: 13, i_id: 'IID-B', sku_id: 'B-蓝-M', qty: 1, item_status: 'Sent' }),
      item({ oi_id: 14, i_id: 'IID-C', sku_id: 'C-灰-XL', qty: 5, item_status: 'Cancelled' }),
    ],
  },
  {
    ...ORDER,
    o_id: 9002,
    items: [
      item({ o_id: 9002, oi_id: 21, i_id: null, sku_id: 'D-组合-2XL', sku_type: 'combine', qty: 3 }),
    ],
  },
];

function fakeBridge(pages, { total = pages.length } = {}) {
  return {
    calls: [],
    async run(_fn, input) {
      this.calls.push(input.command);
      if (input.command === 'count') return { total };
      const rows = pages[input.page - 1];
      if (!rows) throw new Error(`unexpected page ${input.page}`);
      return { rows };
    },
  };
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jst-unshipped-test-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('unshippedItemQty zeroes shipped, refunded and non-deliver lines', () => {
  assert.equal(unshippedItemQty({ qty: 2 }), 2);
  assert.equal(unshippedItemQty({ qty: '3' }), 3);
  assert.equal(unshippedItemQty({ qty: 1, item_status: null }), 1);
  for (const item_status of ['Sent', 'Cancelled', 'Disabled', 'OuterSent']) {
    assert.equal(unshippedItemQty({ qty: 2, item_status }), 0, item_status);
  }
  assert.equal(unshippedItemQty({ qty: 1, sku_type: 'no_deliver', is_gift: true }), 0);
  assert.equal(unshippedItemQty({ qty: 0 }), 0);
  assert.equal(unshippedItemQty({ qty: null }), 0);
  assert.equal(unshippedItemQty({ qty: 'abc' }), 0);
  assert.equal(unshippedItemQty(null), 0);
});

test('snapshot stores order lines with unshipped quantity and plan-date fallback', () => withDir(async (dir) => {
  const output = join(dir, 'jst-unshipped-orders.sqlite');
  const result = await syncUnshipped({
    bridge: fakeBridge([PAGE]), output, pageSize: 20, now: new Date('2026-11-04T01:00:00Z'),
  });

  assert.equal(result.unique, 2);
  assert.equal(result.items, 5);
  assert.equal(result.unshipped_qty, 5);
  assert.equal(statSync(output).mode & 0o777, 0o600);

  const db = new DatabaseSync(output, { readOnly: true });
  try {
    const meta = db.prepare('SELECT * FROM sync_metadata').get();
    assert.equal(meta.schema_version, UNSHIPPED_SCHEMA_VERSION);
    assert.equal(meta.item_count, 5);
    assert.equal(meta.item_unshipped_qty, 5);

    const rows = db.prepare(`SELECT o_id, oi_id, shop_id, shop_name, i_id, sku_id, sku_type, is_gift,
      qty, unshipped_qty, item_status, status, src_status, plan_delivery_date
      FROM unshipped_order_items ORDER BY o_id, oi_id`).all();
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((row) => row.unshipped_qty), [2, 0, 0, 0, 3]);
    assert.deepEqual(rows.map((row) => row.qty), [2, 1, 1, 5, 3]);
    assert.deepEqual(rows.map((row) => row.item_status), [null, null, 'Sent', 'Cancelled', null]);

    // shop/status copied from the order row, plan date falls back to order level
    assert.equal(rows[0].shop_id, '20190470');
    assert.equal(rows[0].shop_name, '示例旗舰店');
    assert.equal(rows[0].status, '发货中');
    assert.equal(rows[0].src_status, 'Delivering');
    assert.equal(rows[0].plan_delivery_date, '2026-11-03 12:00:00');
    assert.equal(rows[1].plan_delivery_date, '2026-11-05 10:00:05');
    assert.equal(rows[1].is_gift, 1);
    assert.equal(rows[1].sku_type, 'no_deliver');
    assert.equal(rows[2].unshipped_qty, 0);
    assert.equal(rows[4].i_id, null);
    assert.equal(rows[4].sku_type, 'combine');
  } finally { db.close(); }

  // no receiver/buyer/contact fields are carried over
  const columns = await (async () => {
    const readOnly = new DatabaseSync(output, { readOnly: true });
    try { return readOnly.prepare('PRAGMA table_info(unshipped_order_items)').all().map((row) => row.name); } finally { readOnly.close(); }
  })();
  assert.ok(!columns.some((name) => /receiver|buyer|mobile|phone|address|remark/.test(name)));
  assert.deepEqual(readdirSync(dir), ['jst-unshipped-orders.sqlite']);
}));

test('repeated order pages are deduplicated by (o_id, oi_id)', () => withDir(async (dir) => {
  const output = join(dir, 'jst-unshipped-orders.sqlite');
  const bridge = fakeBridge([[PAGE[0], PAGE[0]]], { total: 1 });
  const result = await syncUnshipped({ bridge, output, pageSize: 20, now: new Date('2026-11-04T01:00:00Z') });
  assert.equal(result.fetched, 2);
  assert.equal(result.unique, 1);
  assert.equal(result.items, 4);
  assert.equal(result.unshipped_qty, 2);
}));

test('a product line without oi_id or sku_id aborts the snapshot', async () => {
  for (const broken of [{ oi_id: null }, { sku_id: '' }]) {
    await withDir(async (dir) => {
      const output = join(dir, 'jst-unshipped-orders.sqlite');
      const page = [{ ...ORDER, items: [item({ oi_id: 11, sku_id: 'A-红-L' }), item({ oi_id: 12, sku_id: 'B-蓝-M', ...broken })] }];
      await assert.rejects(
        syncUnshipped({ bridge: fakeBridge([page]), output, pageSize: 20, now: new Date('2026-11-04T01:00:00Z') }),
        (error) => error.code === 'invalid_list',
      );
      assert.deepEqual(readdirSync(dir), [], 'temporary file must be removed');
    });
  }
});
