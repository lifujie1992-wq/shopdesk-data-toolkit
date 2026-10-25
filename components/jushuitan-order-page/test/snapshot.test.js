import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { saveSnapshot, loadSnapshot, schemaOf } from '../src/storage.js';
import { render } from '../src/render.js';
import { dayFilters, dayWindow, MAX_DAY_ORDERS, syncDay, validateDayTotal } from '../src/day-sync.js';

const sample = { version: 1, captured_at: '2026-09-08T00:00:00Z', columns: [{ id: 'o_id', name: '内部订单号' }], rows: [{ o_id: '94894206', future_field: { unknown: true } }], details: [{ o_id: '94894206', order: { o_id: '94894206', items: [{ sku_id: 'A', qty: 2 }], pays: [], actions: [{ name: '读取', remark: '</script><script>alert(1)</script>$&' }] }, aftersales: null }] };
test('JSON and SQLite retain nested and unknown fields with private permissions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jst-page-test-'));
  try {
    for (const ext of ['json','sqlite']) {
      const path = join(dir, 'snapshot.' + ext);
      saveSnapshot(path, sample);
      assert.deepEqual(loadSnapshot(path), sample);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
    const db = new DatabaseSync(join(dir, 'snapshot.sqlite'), { readOnly: true });
    assert.equal(db.prepare("SELECT json_extract(json,'$.qty') AS qty FROM order_items").get().qty, 2);
    db.close();
    assert(schemaOf(sample).fields.some(f => f.path === 'list.future_field.unknown'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('offline renderer safely embeds attacker-controlled order text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jst-page-test-'));
  try {
    const path = render(sample, join(dir, 'index.html'));
    const html = readFileSync(path, 'utf8');
    assert(!html.includes('</script><script>alert(1)'));
    assert(html.includes('\\u003c/script>'));
    assert(html.includes('$&'));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert(html.includes("connect-src 'none'"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('day window uses Asia/Shanghai and freezes the current-day upper bound', () => {
  const now = new Date('2026-09-08T16:08:27Z');
  assert.deepEqual(dayWindow(undefined, now), {
    day: '2026-09-09',
    lowerBound: '2026-09-09 00:00:00',
    upperBound: '2026-09-09 00:08:27',
  });
  assert.deepEqual(dayWindow('2026-09-08', now), {
    day: '2026-09-08',
    lowerBound: '2026-09-08 00:00:00',
    upperBound: '2026-09-08 23:59:59',
  });
  assert.deepEqual(dayFilters(dayWindow(undefined, now)), [
    { k: 'order_date', v: '2026-09-09 00:00:00', c: '>=', t: 'date' },
    { k: 'order_date', v: '2026-09-09 00:08:27', c: '<=', t: 'date' },
  ]);
  assert.throws(() => dayWindow('2026-02-30', now), /有效/);
  assert.throws(() => dayWindow('2026-09-10', now), /不能晚于/);
  assert.equal(validateDayTotal(MAX_DAY_ORDERS), MAX_DAY_ORDERS);
  assert.throws(() => validateDayTotal(MAX_DAY_ORDERS + 1), error => error.code === 'day_limit_exceeded');
});

test('day sync pages into one atomic SQLite without opening details', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jst-day-sync-test-'));
  try {
    const rows = Array.from({ length: 21 }, (_, index) => ({
      o_id: String(1000 + index),
      order_date: `2026-09-09 00:00:${String(index).padStart(2, '0')}`,
      status: index % 2 ? 'WaitPay' : 'WaitConfirm',
      shop_id: 7,
      shop_name: '测试店',
      paid_amount: index,
      free_amount: 0,
      future_field: { retained: true },
      items: [{ sku_id: `SKU-${index}`, i_id: 'STYLE', qty: 1, price: 10, amount: 10 }],
    }));
    let countCalls = 0;
    const listInputs = [];
    const bridge = {
      async run(_expression, input) {
        assert.deepEqual(input.filters, [
          { k: 'order_date', v: '2026-09-09 00:00:00', c: '>=', t: 'date' },
          { k: 'order_date', v: '2026-09-09 00:08:27', c: '<=', t: 'date' },
        ]);
        assert.deepEqual(input.sort, { order_date: false });
        if (input.command === 'count') { countCalls++; return { total: rows.length }; }
        assert.equal(input.command, 'list');
        listInputs.push(input);
        const start = (input.page - 1) * input.limit;
        return { rows: rows.slice(start, start + input.limit), columns: input.includeColumns ? [{ id: 'o_id' }] : [] };
      },
    };
    const progress = [];
    const output = join(dir, 'today.sqlite');
    const result = await syncDay({
      bridge, output, pageSize: 20, now: new Date('2026-09-08T16:08:27Z'),
      onProgress: event => progress.push(event),
    });
    assert.equal(countCalls, 2);
    assert.deepEqual(listInputs.map(input => [input.page, input.limit, input.includeColumns]), [[1, 20, true], [2, 20, false]]);
    assert.deepEqual(progress.map(event => event.fetched), [20, 21]);
    assert.equal(result.unique, 21);
    assert.equal(result.duplicates, 0);
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const db = new DatabaseSync(output, { readOnly: true });
    assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get().count, 21);
    assert.equal(db.prepare('SELECT count(*) AS count FROM order_items').get().count, 21);
    assert.equal(db.prepare("SELECT json_extract(json,'$.future_field.retained') AS retained FROM orders LIMIT 1").get().retained, 1);
    const metadata = db.prepare('SELECT * FROM sync_metadata').get();
    assert.equal(metadata.day, '2026-09-09');
    assert.equal(metadata.page_size, 20);
    assert.equal(metadata.expected_count, 21);
    assert.equal(metadata.unique_count, 21);
    assert.equal(metadata.pages_completed, 2);
    assert.equal(JSON.parse(metadata.columns_json)[0].id, 'o_id');
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('day sync keeps the previous output when the fixed dataset changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jst-day-sync-failure-test-'));
  try {
    const output = join(dir, 'today.sqlite');
    const previous = Buffer.from('previous database');
    writeFileSync(output, previous);
    let countCalls = 0;
    const bridge = {
      async run(_expression, input) {
        if (input.command === 'count') return { total: ++countCalls === 1 ? 1 : 2 };
        return { rows: [{ o_id: '1', order_date: '2026-09-09 00:00:01', items: [] }], columns: [] };
      },
    };
    await assert.rejects(
      syncDay({ bridge, output, pageSize: 20, now: new Date('2026-09-08T16:08:27Z') }),
      error => error.code === 'dataset_changed',
    );
    assert.deepEqual(readFileSync(output), previous);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('day sync refuses more than 100000 orders before fetching any page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jst-day-sync-limit-test-'));
  try {
    const output = join(dir, 'today.sqlite');
    let listCalls = 0;
    const bridge = {
      async run(_expression, input) {
        if (input.command === 'count') return { total: 100001 };
        listCalls++;
        return { rows: [], columns: [] };
      },
    };
    await assert.rejects(
      syncDay({ bridge, output, now: new Date('2026-09-08T16:08:27Z') }),
      error => error.code === 'day_limit_exceeded',
    );
    assert.equal(listCalls, 0);
    assert.equal(readdirSync(dir).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('page loss rolls back partial rows and recovery replaces output only after a complete recollection', async () => {
  const {Bridge}=await import('../src/bridge.js');
  const dir=mkdtempSync(join(tmpdir(),'jst-recovery-'));
  try{
    const output=join(dir,'today.sqlite'), previous=Buffer.from('previous complete snapshot');
    writeFileSync(output,previous);
    const bridge=new Bridge({session:'test-paid'});bridge.browserSessionId='same-browser';bridge.tabId=123;
    let recovered=false;const pages=[];
    bridge.refresh=async options=>{
      assert.equal(options.browserSessionId,'same-browser');
      assert.deepEqual(readFileSync(output),previous);
      assert.deepEqual(readdirSync(dir),['today.sqlite']);
      recovered=true;
    };
    const rows=Array.from({length:21},(_,i)=>({o_id:String(i+1),items:[]}));
    bridge.run=async(_,input)=>{
      if(input.command==='count')return{total:21};
      pages.push(input.page);
      if(input.page===2&&!recovered)throw Object.assign(new Error('page changed'),{code:'page_changed'});
      return{rows:rows.slice((input.page-1)*input.limit,input.page*input.limit),columns:[]};
    };
    const result=await bridge.withPageRecovery(()=>syncDay({bridge,output,pageSize:20,now:new Date('2026-09-08T16:08:27Z')}),{sleep:async()=>{},onRetry:()=>{}});
    assert.equal(result.unique,21);assert.deepEqual(pages,[1,2,1,2]);
    const db=new DatabaseSync(output,{readOnly:true});
    try{assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n,21);}finally{db.close();}
  }finally{rmSync(dir,{recursive:true,force:true});}
});
