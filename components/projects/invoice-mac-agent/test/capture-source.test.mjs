import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {gunzipSync} from 'node:zlib';
import {createCaptureSource, normalizeConsumer, normalizePlatform, parseSourceJson, readShopCookies, toNumber} from '../capture-source.mjs';
import {runCapture} from '../capture-runner.mjs';
const silent = {info() {}};
const shop = {id: 's1', name: '测试店'};
const item = {shop_order_id: '6953220432659486690', order_status_text: '已完成', invoice_amount: '￥1,234.50', registation_id: 'r1', latest_invoice_time_info: {description_text: '剩余1天'}};
const cookies = [{name: 'sessionid', value: 'test-secret', host_key: '.jinritemai.com', path: '/'}];
const json = value => Response.json(value);
function source(handler, shops = [shop]) {
  return createCaptureSource({cfg: {captureShopdeskDir: '/unused', captureRequestTimeoutMs: 1000}, shops, getCookies: () => cookies, log: silent,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.redirect, 'manual');
      assert.match(opts.headers.Cookie, /sessionid=/);
      assert.doesNotMatch(String(url), /wait_red/);
      return handler(url, opts);
    }});
}
test('无损 JSON 解析、人民币与字段映射', () => {
  const parsed = parseSourceJson('{"shop_order_id":6953220432659486690,"invoice_amount":"￥87.80"}');
  assert.equal(parsed.shop_order_id, '6953220432659486690');
  const row = normalizeConsumer({...item, ...parsed}, shop);
  assert.equal(row.amount, 87.8);
  assert.equal(row.registrationId, 'r1');
  assert.equal(row.deadlineText, '剩余1天');
  assert.equal(row.subOrderNo, null);
  assert.throws(() => normalizeConsumer({...item, shop_order_id: 6953220432659486690}, shop), /精度/);
  assert.throws(() => toNumber('￥abc'), /金额/);
  assert.throws(() => toNumber(''), /金额/);
  const bill = normalizePlatform({id: '19', bill_amount: '12345', IsFrozen: 'false', UnpayAmount: '￥2.00'}, shop, 'cc', '测试主体');
  assert.equal(bill.billAmountYuan, 123.45);
  assert.equal(bill.isFrozen, false);
  assert.equal(bill.unpayAmount, 2);
});
test('明确空列表成功，缺失列表结构不能假报0行', async () => {
  const good = await source(url => url.pathname.includes('subject') ? json({ret_code: '0000', ret_data: {subject_list: []}}) : json({code: 0, data: [], total: 0})).collect();
  assert.deepEqual(good.shopResults.map(r => [r.status, r.rowCount]), [['success', 0], ['success', 0]]);
  const bad = await source(() => json({})).collect();
  assert.equal(bad.rows.length, 0);
  assert.ok(bad.shopResults.every(r => r.status === 'failed' && r.rowCount === null));
});
test('待开票仅保留明确已完成，其他及缺失状态不进入明细', async () => {
  const excluded = ['待付款', '待发货', '已发货', '已关闭', '已取消', '未知状态', '', null, undefined];
  const data = [item, ...excluded.map(order_status_text => ({order_status: 5, order_status_text}))];
  const result = await source(url => url.pathname.includes('subject')
    ? json({ret_code: '0000', ret_data: {subject_list: []}}) : json({code: 0, total: data.length, data})).collect();
  assert.deepEqual(result.rows.map(r => [r.orderId, r.orderStatus]), [[item.shop_order_id, '已完成']]);
  assert.equal(result.shopResults[0].status, 'success');
  assert.equal(result.shopResults[0].isComplete, true);
  assert.equal(result.shopResults[0].rowCount, 1);
});
test('筛选后按原始total翻完全部页，全部被排除仍为完整0行', async () => {
  for (const keepCompleted of [true, false]) {
    const pages = [];
    const result = await source(url => {
      if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: []}});
      const page = Number(url.searchParams.get('page')); pages.push(page);
      return json({code: 0, total: 3, data: [{...item, shop_order_id: `order-${page}`,
        order_status_text: keepCompleted && page === 1 ? '已完成' : '已关闭'}]});
    }).collect();
    assert.deepEqual(pages, [0, 1, 2]);
    assert.deepEqual(result.rows.map(r => r.orderId), keepCompleted ? ['order-1'] : []);
    assert.equal(result.shopResults[0].rowCount, keepCompleted ? 1 : 0);
    assert.equal(result.shopResults[0].status, 'success');
    assert.equal(result.shopResults[0].isComplete, true);
  }
});
test('无total时被排除的满页仍继续翻页，短页或空页结束', async () => {
  for (const lastPage of [[item], []]) {
    const pages = [];
    const result = await source(url => {
      if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: []}});
      const page = Number(url.searchParams.get('page')); pages.push(page);
      return json({code: 0, data: page === 0 ? Array.from({length: 100}, (_, i) =>
        ({shop_order_id: `skip-${i}`, order_status_text: '已关闭'})) : lastPage});
    }).collect();
    assert.deepEqual(pages, [0, 1]);
    assert.equal(result.rows.length, lastPage.length);
    assert.equal(result.shopResults[0].rowCount, lastPage.length);
    assert.equal(result.shopResults[0].status, 'success');
  }
});
test('被排除的记录仍参与分页完整性校验，异常不能报成功0行', async () => {
  const skipped = {order_status_text: '已关闭'};
  for (const responses of [
    [{total: 0, data: [skipped]}],
    [{total: 2, data: [skipped]}, {total: 2, data: []}],
    [{total: 2, data: [skipped]}, {total: 3, data: [{...skipped, shop_order_id: 'other'}]}],
    [{total: 2, data: [skipped]}, {total: 2, data: [skipped]}],
  ]) {
    const result = await source(url => url.pathname.includes('subject')
      ? json({ret_code: '0000', ret_data: {subject_list: []}})
      : json({code: 0, ...responses[Number(url.searchParams.get('page'))]})).collect();
    assert.equal(result.rows.length, 0);
    assert.equal(result.shopResults[0].status, 'failed');
    assert.equal(result.shopResults[0].errorCode, 'PAGINATION_FAILED');
    assert.equal(result.shopResults[0].rowCount, null);
  }
});
test('筛选结果贯穿打包、上传和入库ACK，平台账单正常保留', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-completed-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const collectedSource = source(url => {
    if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: [
      {CreditCode: 'seller', CompanyName: '销售方', IsNewSubject: true, HasPendingPlatformInvoiceBill: true},
    ]}});
    if (url.pathname.includes('getPage')) return json({ret_code: '0000', total_counts: 1,
      invoice_bills: [{id: 'bill-1', bill_amount: '100'}]});
    return json({code: 0, total: 2, data: [item, {order_status_text: '已关闭'}]});
  });
  let body, uploaded = false, completed = false;
  const cloud = {
    captureRetry: fn => fn(),
    captureCreate: async value => {
      body = value;
      assert.equal(body.consumerRowCount, 1);
      assert.equal(body.platformRowCount, 1);
      assert.deepEqual(body.shopResults.map(r => r.rowCount), [1, 1]);
      return {...body, status: 'created'};
    },
    captureFile: async (id, file) => {
      assert.equal(id, body.captureRunId);
      const rows = gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(JSON.parse);
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.filter(r => r.businessType === 'consumer_order').map(r => r.orderStatus), ['已完成']);
      assert.equal(rows.find(r => r.businessType === 'platform_bill').billId, 'bill-1');
      uploaded = true;
      return {...body, status: 'uploaded'};
    },
    captureComplete: async () => {
      assert.equal(uploaded, true);
      completed = true;
      return {...body, status: 'processed', consumerReceivedRows: 1, platformReceivedRows: 1,
        consumerAcceptedRows: 1, platformAcceptedRows: 1, duplicateRows: 0, conflictRows: 0, staleRows: 0};
    },
  };
  const result = await runCapture({cfg: {captureEnabled: true, captureStateDir: dir}, source: collectedSource,
    cloud, log: silent, complete: true});
  assert.equal(result.status, 'processed');
  assert.equal(completed, true);
});
test('单店分页失败丢弃部分明细；平台成功与其他店不受影响', async () => {
  let consumerRequests = 0;
  const result = await source(url => {
    if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: []}});
    consumerRequests++;
    if (consumerRequests === 1) return json({code: 0, total: 2, data: [item]});
    if (consumerRequests === 2) throw new DOMException('timeout', 'TimeoutError');
    return json({code: 0, total: 1, data: [item]});
  }, [shop, {id: 's2', name: '第二店'}]).collect();
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].shopId, 's2');
  assert.equal(result.shopResults[0].errorCode, 'PAGE_TIMEOUT');
  assert.equal(result.shopResults[0].rowCount, null);
  assert.equal(result.shopResults[1].status, 'success');
  assert.equal(result.shopResults[2].status, 'success');
});
test('登录失效不报0行，其他店继续', async () => {
  const result = await source(() => json({msg: '请重新登录'})).collect();
  assert.ok(result.shopResults.every(r => r.errorCode === 'LOGIN_EXPIRED'));
});
test('主体失败不影响消费者；平台失败不上传该业务部分明细', async () => {
  const result = await source(url => url.pathname.includes('subject') ? json({ret_code: 'FAIL'}) : json({code: 0, total: 1, data: [item]})).collect();
  assert.equal(result.rows.length, 1);
  assert.equal(result.shopResults[1].status, 'failed');
  const paged = await source(url => {
    if (url.pathname.includes('subject')) return json({ret_data: {subject_list: [{CreditCode: 'cc', HasPendingPlatformInvoiceBill: true}]}});
    if (url.pathname.includes('getPage')) return json({ret_code: '0000', total: 51, invoice_bills: [{id: 'bill1', bill_amount: '1'}]});
    return json({code: 0, total: 0, data: []});
  }).collect();
  assert.equal(paged.shopResults[1].errorCode, 'PAGINATION_FAILED');
  assert.equal(paged.rows.length, 0);
});
test('50页仍未完成不得标记成功', async () => {
  const result = await source(url => url.pathname.includes('subject') ? json({ret_code: '0000', ret_data: {subject_list: []}}) : json({code: 0, total: 51, data: [{...item, shop_order_id: 'order-' + url.searchParams.get('page')}]})).collect();
  assert.equal(result.shopResults[0].errorCode, 'PAGINATION_FAILED');
  assert.equal(result.rows.length, 0);
});
test('真实 total_counts、重复分页与空列表确认保护', async () => {
  const paged = await source(url => {
    if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: [{CreditCode: 'cc', HasPendingPlatformInvoiceBill: true}]}});
    if (url.pathname.includes('getPage')) return json({ret_code: '0000', total_counts: 51, invoice_bills: [{id: 'b', bill_amount: '1'}]});
    return json({code: 0, total: 3, data: [item]});
  }).collect();
  assert.equal(paged.rows.length, 0);
  assert.ok(paged.shopResults.every(r => r.errorCode === 'PAGINATION_FAILED'));
  const ambiguous = await source(url => url.pathname.includes('subject') ? json({ret_data: {subject_list: []}}) : json({total: 0, data: []})).collect();
  assert.ok(ambiguous.shopResults.every(r => r.status === 'failed'));
});
test('Cookie SQLite 只读副本、严格域过滤、过期过滤及清理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-source-test-'));
  try {
    const partition = path.join(dir, 'Partitions', 'shop-s1');
    fs.mkdirSync(partition, {recursive: true});
    const db = new DatabaseSync(path.join(partition, 'Cookies'));
    db.exec('CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,path TEXT,is_secure INTEGER,expires_utc INTEGER)');
    const insert = db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?)');
    insert.run('.jinritemai.com', 'sessionid', 'secret', '/', 1, 16469458789900995n);
    insert.run('eviljinritemai.com', 'x', 'secret', '/', 1, 0);
    insert.run('.jinritemai.com', 'expired', 'secret', '/', 1, 1);
    db.close();
    const original = fs.readFileSync(path.join(partition, 'Cookies'));
    assert.deepEqual(readShopCookies(dir, 's1').map(x => x.name), ['sessionid']);
    assert.deepEqual(fs.readFileSync(path.join(partition, 'Cookies')), original);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('空名称及税号条目经接口明确确认0条后，不再丢弃正常主体账单', async () => {
  const requestedCodes = [];
  const result = await source(url => {
    if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: [
      {CreditCode: 'known-company', CompanyName: '正常主体', HasPendingPlatformInvoiceBill: true},
      {CreditCode: '', CompanyName: '', HasPendingPlatformInvoiceBill: true},
    ]}});
    if (url.pathname.includes('getPage')) {
      const code = url.searchParams.get('credit_code'); requestedCodes.push(code);
      return json({ret_code: '0000', total_counts: code ? 1 : 0,
        invoice_bills: code ? [{id: 'bill-1', bill_amount: '100'}] : []});
    }
    return json({code: 0, total: 0, data: []});
  }).collect();
  assert.deepEqual(requestedCodes, ['known-company', '']);
  assert.equal(result.shopResults[1].status, 'success');
  assert.equal(result.shopResults[1].rowCount, 1);
  assert.equal(result.rows[0].creditCode, 'known-company');
  assert.equal(result.rows[0].billId, 'bill-1');
});

test('空主体存在账单、无明确total或缺少成功码时，继续拒绝整个不完整单元', async () => {
  for (const ambiguous of [
    {ret_code: '0000', total_counts: 1, invoice_bills: [{id: 'unknown-bill', bill_amount: '100'}]},
    {ret_code: '0000', invoice_bills: []},
    {total_counts: 0, invoice_bills: []},
  ]) {
    const result = await source(url => {
      if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: [
        {CreditCode: 'known-company', CompanyName: '正常主体', HasPendingPlatformInvoiceBill: true},
        {CreditCode: '', CompanyName: '', HasPendingPlatformInvoiceBill: true},
      ]}});
      if (url.pathname.includes('getPage')) return json(url.searchParams.get('credit_code')
        ? {ret_code: '0000', total_counts: 1, invoice_bills: [{id: 'known-bill', bill_amount: '100'}]}
        : ambiguous);
      return json({code: 0, total: 0, data: []});
    }).collect();
    assert.equal(result.shopResults[1].status, 'failed');
    assert.equal(result.shopResults[1].errorCode, 'PARSE_FAILED');
    assert.equal(result.shopResults[1].rowCount, null);
    assert.equal(result.rows.length, 0);
  }
});

test('真实具名主体缺税号或字段缺失不能按空占位条目放行', async () => {
  for (const sub of [
    {CreditCode: '', CompanyName: '真实企业'},
    {CompanyName: ''},
    {CreditCode: ''},
  ]) {
    let platformCalls = 0;
    const result = await source(url => {
      if (url.pathname.includes('subject')) return json({ret_code: '0000', ret_data: {subject_list: [{...sub, HasPendingPlatformInvoiceBill: true}]}});
      if (url.pathname.includes('getPage')) platformCalls++;
      return json({code: 0, total: 0, data: []});
    }).collect();
    assert.equal(result.shopResults[1].errorCode, 'PARSE_FAILED');
    assert.equal(platformCalls, 0);
  }
});
