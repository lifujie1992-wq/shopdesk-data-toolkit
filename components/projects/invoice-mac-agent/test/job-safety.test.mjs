import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createJobRunner} from '../job-runner.mjs';
import {createShopdeskInvoiceDriver} from '../shopdesk-invoice-driver.mjs';
const log = {info() {}};
const cfg = {submitMode: 'upload-only', stagingDir: '/tmp/invoice-safety-test', leaseSoftDeadlineMs: 1000};
function env(payload) {
  const calls = [], reports = [];
  const runner = createJobRunner({cfg, log, cloud: {report: async r => {reports.push(r); return {}; }}, stage: async () => ({path: '/tmp/test.pdf'}),
    driver: {listShops: async () => ({shops: [{id: 's', name: '店铺', platform: '抖店'}]}),
      invoiceList: async () => ({rows: [{shop_order_id: 'o', invoice_amount: '10.00', invoice_status: 1, invoice_status_text: '待开票'}]}),
      invoiceUploadPdf: async () => {calls.push('upload'); return {ok: true, key: 'key'};}, invoiceSubmit: async () => {throw Error('禁止提交');}}});
  return {runner, reports, calls, job: {job_id: 'safety', leaseToken: 'lease', payload: {shopId: 's', orderId: 'o', amount: 10, ...payload}}};
}
test('V2平台任务不得走消费者上传接口', async () => {
  const e = env({businessType: 'platform_bill', billId: 'b'});
  await e.runner.run(e.job);
  assert.deepEqual(e.calls, []);
  assert.match(e.reports[0].message, /仅支持消费者/);
});
test('子订单不能用同主订单的其他明细替代', async () => {
  const e = env({businessType: 'consumer_order', subOrderNo: 'sub1'});
  await e.runner.run(e.job);
  assert.deepEqual(e.calls, []);
});
test('upload-only验证仍待开票，不回报uploaded', async () => {
  const e = env({businessType: 'consumer_order'});
  await e.runner.run(e.job);
  assert.deepEqual(e.calls, ['upload']);
  assert.equal(e.reports[0].state, 'retryable');
  assert.match(e.reports[0].message, /仍待开票/);
});
test('bridge capability在调用前拦截最终提交', () => {
  const d = createShopdeskInvoiceDriver({allowSubmit: false, getBridge() {throw Error('不应获取bridge');}});
  assert.throws(() => d.invoiceSubmit({}), /禁止最终提交/);
  assert.throws(() => createJobRunner({cfg: {...cfg, submitMode: 'bad'}}), /非法 submitMode/);
});
