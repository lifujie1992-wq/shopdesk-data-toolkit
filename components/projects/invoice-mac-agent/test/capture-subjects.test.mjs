import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {createCaptureSource, latestConsumerSubject} from '../capture-source.mjs';
import {packCapture, loadManifest, captureCreateBody, validateCapture} from '../capture-pack.mjs';
import {runCapture} from '../capture-runner.mjs';

const log = {info() {}, warn() {}};
const shop = {id: 's1', name: '主体测试店'};
const current = {CompanyName: '当前销售方', CreditCode: '91440106MAK442EN1L', IsNewSubject: true,
  IsSubjectCancelled: false, HasPendingPlatformInvoiceBill: true};
const historical = {...current, CompanyName: '历史销售方', CreditCode: '91440106MAK5BF2363', IsNewSubject: false,
  IsSubjectCancelled: false, ExpireTimeUnix: 1778497634};
const consumer = {shop_order_id: '6929959493973344105', order_status_text: '已完成', title: '购买方', tax_no: 'buyer-tax', invoice_amount: '￥159.80'};
const success = (businessType, rowCount) => ({shopId: shop.id, businessType, status: 'success', isComplete: true,
  rowCount, errorCode: null, errorMessage: null});
function makeSource({subjects = [historical, current], failSubjects = false, emptyConsumer = false, failPlatform = false,
  shops = [shop], subjectsByShop, logImpl = log} = {}) {
  const calls = [];
  const source = createCaptureSource({cfg: {}, shops, log: logImpl,
    getCookies: (_dir, id) => [{name: 'sessionid', value: id, host_key: '.jinritemai.com', path: '/'}],
    fetchImpl: async (url, opts) => {
      calls.push(url.pathname);
      if (url.pathname.endsWith('/subject/list')) {
        const id = opts.headers.Cookie.split('=')[1];
        return Response.json(failSubjects ? {ret_code: 'FAIL'} : {ret_code: '0000', ret_data: {subject_list: subjectsByShop?.[id] || subjects}});
      }
      if (url.pathname === '/order/invoice/list') return Response.json({code: 0, total: emptyConsumer ? 0 : 1, data: emptyConsumer ? [] : [consumer]});
      assert.equal(url.pathname, '/api/ecomfinance/uninvoicebill/getPage');
      if (failPlatform) throw new DOMException('test', 'TimeoutError');
      return Response.json({ret_code: '0000', total_counts: 1, invoice_bills: [{id: 'bill-' + url.searchParams.get('credit_code'), bill_amount: '100', CorporationInfo: {Title: '平台收票方', TaxCode: 'platform-tax'}}]});
    }});
  return {source, calls};
}
async function collect(options) { const {source, calls} = makeSource(options); return {...await source.collect(), calls}; }
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-subject-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

test('消费者使用唯一最新主体，数组顺序及历史时间不改变选择', () => {
  const expected = {companyName: current.CompanyName, creditCode: current.CreditCode};
  assert.deepEqual(latestConsumerSubject([historical, current]), expected);
  assert.deepEqual(latestConsumerSubject([current, historical]), expected);
  assert.deepEqual(latestConsumerSubject([{...historical, ExpireTimeUnix: 9999999999}, {...current, IsNewSubject: 'true'}]), expected);
});

test('消费者用最新主体，平台按各自查询主体；两类行都直接携带名称和信用代码', async () => {
  const result = await collect();
  assert.equal(result.calls.filter(p => p.endsWith('/subject/list')).length, 1);
  assert.deepEqual(result.shopResults.map(r => [r.businessType, r.rowCount]), [['consumer_order', 1], ['platform_bill', 2]]);
  assert.ok(result.rows.every(r => ['consumer_order', 'platform_bill'].includes(r.businessType)));
  const buyer = result.rows.find(r => r.businessType === 'consumer_order');
  assert.equal(buyer.companyName, current.CompanyName);
  assert.equal(buyer.creditCode, current.CreditCode);
  assert.equal(buyer.title, '购买方');
  assert.equal(buyer.taxNo, 'buyer-tax');
  const bills = result.rows.filter(r => r.businessType === 'platform_bill');
  assert.deepEqual(bills.map(r => [r.companyName, r.creditCode]), [
    [historical.CompanyName, historical.CreditCode], [current.CompanyName, current.CreditCode],
  ]);
  assert.ok(bills.every(r => r.corpTitle === '平台收票方' && r.corpTaxNo === 'platform-tax'));
});

test('多店分别选最新主体，不串用上一店名称及信用代码', async () => {
  const second = {id: 's2', name: '第二店'};
  const b = {...current, CompanyName: '第二店最新主体', CreditCode: 'second-code', HasPendingPlatformInvoiceBill: false};
  const result = await collect({shops: [shop, second], subjectsByShop: {s1: [current], s2: [b]}});
  const consumers = result.rows.filter(r => r.businessType === 'consumer_order');
  assert.deepEqual(consumers.map(r => [r.shopId, r.companyName, r.creditCode]), [
    ['s1', current.CompanyName, current.CreditCode], ['s2', b.CompanyName, b.CreditCode],
  ]);
});

test('消费者全部分页复用本次最新主体，下次新采集跟随主体切换', async () => {
  let subjectRequests = 0;
  const source = createCaptureSource({cfg: {}, shops: [shop], log,
    getCookies: () => [{name: 'sessionid', value: 'test', host_key: '.jinritemai.com', path: '/'}],
    fetchImpl: async url => {
      if (url.pathname.endsWith('/subject/list')) {
        subjectRequests++;
        return Response.json({ret_code: '0000', ret_data: {subject_list: [
          {...(subjectRequests === 1 ? current : {...current, CompanyName: '切换后主体', CreditCode: 'new-code'}), HasPendingPlatformInvoiceBill: false},
        ]}});
      }
      assert.equal(url.pathname, '/order/invoice/list');
      return Response.json({code: 0, total: 2, data: [{...consumer, shop_order_id: 'order-' + url.searchParams.get('page')}]});
    }});
  const first = await source.collect();
  assert.equal(first.rows.length, 2);
  assert.ok(first.rows.every(r => r.companyName === current.CompanyName && r.creditCode === current.CreditCode));
  assert.equal(subjectRequests, 1);
  const next = await source.collect();
  assert.equal(next.rows.length, 2);
  assert.ok(next.rows.every(r => r.companyName === '切换后主体' && r.creditCode === 'new-code'));
  assert.equal(subjectRequests, 2);
});

test('最新标志缺失、多候选、注销或半组信息时留空并记录，不回退历史主体', async () => {
  const cases = [[], [historical], [current, {...current, CreditCode: 'other'}], [{...current, IsSubjectCancelled: true}],
    [{...current, CompanyName: ''}], [{...current, CreditCode: ''}], [{...current, CreditCode: 123}], [null]];
  for (const subjects of cases) {
    assert.deepEqual(latestConsumerSubject(subjects), {companyName: null, creditCode: null});
    const warnings = [];
    const result = await collect({subjects, logImpl: {info() {}, warn(event) { warnings.push(event); }}});
    const buyer = result.rows.find(r => r.businessType === 'consumer_order');
    assert.equal(buyer.companyName, null);
    assert.equal(buyer.creditCode, null);
    assert.ok(warnings.some(w => w.event === 'capture_consumer_subject_unavailable'));
    assert.equal(result.shopResults[0].status, 'success');
  }
});

test('主体接口失败仍采消费者并传双null，平台失败仍保留消费者最新主体', async () => {
  const failed = await collect({failSubjects: true});
  assert.deepEqual(failed.shopResults.map(r => r.status), ['success', 'failed']);
  assert.equal(failed.rows[0].companyName, null);
  assert.equal(failed.rows[0].creditCode, null);
  const platform = await collect({failPlatform: true});
  assert.deepEqual(platform.shopResults.map(r => r.status), ['success', 'failed']);
  assert.equal(platform.rows[0].companyName, current.CompanyName);
  const incomplete = await collect({subjects: [{...current, CompanyName: ''}]});
  assert.equal(incomplete.shopResults[1].errorCode, 'PARSE_FAILED');
  assert.ok(incomplete.rows.every(r => r.businessType === 'consumer_order'));
});

test('每行字段进入gzip/哈希，原创建字段及行数不变，空店仍只有两种结果', async t => {
  const result = await collect();
  const dir = temp(t);
  const packed = packCapture({...result, stateDir: dir, capturedAt: '2026-10-19T12:13:33+08:00'});
  const body = captureCreateBody(packed.manifest);
  assert.deepEqual(Object.keys(body), ['captureRunId', 'statDate', 'capturedAt', 'consumerRowCount', 'platformRowCount', 'fileSize', 'fileSha256', 'shopResults']);
  assert.equal(body.consumerRowCount, 1);
  assert.equal(body.platformRowCount, 2);
  assert.ok(!Object.hasOwn(packed.manifest, 'subjectRowCount'));
  const lines = gunzipSync(fs.readFileSync(packed.manifest.gzipPath)).toString().trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 3);
  assert.ok(lines.every(r => typeof r.companyName === 'string' && typeof r.creditCode === 'string'));
  assert.deepEqual(loadManifest(packed.manifestPath), packed.manifest);
  const other = packCapture({...result, rows: result.rows.map(r => ({...r, companyName: '名称变更'})), stateDir: dir, capturedAt: packed.manifest.capturedAt});
  assert.notEqual(other.manifest.fileSha256, packed.manifest.fileSha256);
  const empty = await collect({emptyConsumer: true, subjects: []});
  assert.equal(empty.rows.length, 0);
  assert.deepEqual(empty.shopResults.map(r => r.rowCount), [0, 0]);
});

test('新格式校验成对主体，旧消费者和仅带信用代码的旧平台仍可恢复', t => {
  const row = {businessType: 'consumer_order', shopId: shop.id, orderId: 'order', amount: 1};
  const unit = [success('consumer_order', 1)];
  for (const fields of [{companyName: null, creditCode: null}, {companyName: '主体', creditCode: 'code'}, {}]) {
    assert.doesNotThrow(() => validateCapture([{...row, ...fields}], unit));
  }
  for (const fields of [{companyName: '主体'}, {creditCode: 'code'}, {companyName: '', creditCode: 'code'},
    {companyName: null, creditCode: 'code'}, {companyName: '主体', creditCode: 123}]) {
    assert.throws(() => validateCapture([{...row, ...fields}], unit), /成对/);
  }
  const old = packCapture({rows: [row, {businessType: 'platform_bill', shopId: shop.id, billId: 'bill', billAmountYuan: 1, creditCode: 'legacy'}],
    shopResults: [success('consumer_order', 1), success('platform_bill', 1)], stateDir: temp(t)});
  assert.deepEqual(loadManifest(old.manifestPath), old.manifest);
  assert.throws(() => validateCapture([], [success('shop_subject', 0)]), /业务标识/);
});

test('resume不重新匹配，上传原订单/账单字段并按原两类ACK完成', async t => {
  const result = await collect();
  const stateDir = temp(t);
  const packed = packCapture({...result, stateDir});
  const body = captureCreateBody(packed.manifest);
  const view = status => ({...body, status, consumerReceivedRows: 1, consumerAcceptedRows: 1,
    platformReceivedRows: 2, platformAcceptedRows: 2, duplicateRows: 0, conflictRows: 0, staleRows: 0});
  let files = 0;
  const cloud = {captureRetry: fn => fn(), captureCreate: async actual => { assert.deepEqual(actual, body); return view(files ? 'processed' : 'created'); },
    captureFile: async (_id, file) => {
      files++;
      const rows = gunzipSync(fs.readFileSync(file)).toString().trim().split('\n').map(JSON.parse);
      assert.equal(rows.find(r => r.businessType === 'consumer_order').creditCode, current.CreditCode);
      assert.equal(rows.find(r => r.billId === 'bill-' + historical.CreditCode).companyName, historical.CompanyName);
      return view('uploaded');
    }, captureComplete: async () => view('processed')};
  const opts = {cfg: {captureEnabled: true, captureStateDir: stateDir}, cloud, log, resume: true, complete: true,
    manifestPath: packed.manifestPath, source: {collect() { throw Error('恢复不得重新采集'); }}};
  assert.equal((await runCapture(opts)).status, 'processed');
  assert.equal((await runCapture(opts)).status, 'processed');
  assert.equal(files, 1);
});
