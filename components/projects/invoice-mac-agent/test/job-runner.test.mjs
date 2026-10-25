import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createJobRunner, amountToCents} from '../job-runner.mjs';

const silentLog = {info() {}, warn() {}, error() {}};

function job(overrides = {}) {
  return {
    job_id: 'job-1',
    leaseToken: 'lease-1',
    lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    payload: {
      shopId: 'shop-1',
      shopName: '南北行时尚服饰',
      orderId: 'order-1',
      amount: '79.80',
      fileName: 'invoice.pdf',
      ...overrides.payload,
    },
    ...overrides,
  };
}

function setup(mode, driverOverrides = {}, now) {
  const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-agent-test-'));
  const reports = [];
  const calls = {upload: 0, submit: 0, listShops: 0};
  const cloud = {
    async report(input) { reports.push(input); return {state: input.state, idempotent: false}; },
  };
  const stage = async () => ({path: path.join(stagingDir, 'job-1', 'invoice.pdf'), size: 100, sha256: 'abc'});
  const driver = {
    async listShops() { calls.listShops++; return {shops: [{id: 'shop-1', name: '南北行时尚服饰', platform: '抖店'}]}; },
    async invoiceList(args) {
      if (args.status_desc === 'done_blue') return {rows: [], total: 0};
      return {rows: [{shop_order_id: 'order-1', invoice_amount: '￥ 79.80', invoice_status: 1, invoice_status_text: '待开票'}], total: 1};
    },
    async invoiceUploadPdf() { calls.upload += 1; return {ok: true, key: 'tos-key'}; },
    async invoiceSubmit() { calls.submit += 1; return {ok: true, submitted: true, alreadySubmitted: false}; },
    ...driverOverrides,
  };
  const cfg = {submitMode: mode, stagingDir, leaseSoftDeadlineMs: 60_000};
  const runner = createJobRunner({cloud, stage, driver, cfg, log: silentLog, now});
  return {runner, reports, calls, stagingDir};
}

test('amountToCents 正确解析人民币格式', () => {
  assert.equal(amountToCents('￥ 79.80'), 7980);
  assert.equal(amountToCents('1,234.5元'), 123450);
  assert.equal(amountToCents('abc'), null);
});

test('dry-run 只核对，不上传、不提交，回 retryable', async () => {
  const env = setup('dry-run');
  await env.runner.run(job());
  assert.equal(env.calls.upload, 0);
  assert.equal(env.calls.submit, 0);
  assert.equal(env.reports[0].state, 'retryable');
  assert.match(env.reports[0].message, /dry-run/);
});

test('订单号不精确匹配时回 failed', async () => {
  const env = setup('dry-run', {
    async invoiceList(args) {
      if (args.status_desc === 'done_blue') return {rows: [], total: 0};
      return {rows: [{shop_order_id: 'order-10', invoice_amount: '￥ 79.80', invoice_status: 1, invoice_status_text: '待开票'}], total: 1};
    },
  });
  await env.runner.run(job());
  assert.equal(env.reports[0].state, 'failed');
  assert.match(env.reports[0].message, /未找到订单 order-1/);
});

test('金额不匹配时回 failed', async () => {
  const env = setup('dry-run', {
    async invoiceList(args) {
      if (args.status_desc === 'done_blue') return {rows: [], total: 0};
      return {rows: [{shop_order_id: 'order-1', invoice_amount: '￥ 89.80', invoice_status: 1, invoice_status_text: '待开票'}], total: 1};
    },
  });
  await env.runner.run(job());
  assert.equal(env.reports[0].state, 'failed');
  assert.match(env.reports[0].message, /金额不匹配/);
});

test('每单及上传提交前读取最新店铺；订单状态仍每单重新核对', async () => {
  let checks = 0;
  const env = setup('auto', {async invoiceList() {
    checks++;
    return {rows: [{shop_order_id: 'order-1', invoice_amount: '79.80', invoice_status: 1, invoice_status_text: '待开票'}]};
  }});
  await env.runner.run(job());
  await env.runner.run(job());
  assert.equal(env.calls.listShops, 6);
  assert.equal(checks, 2);
  env.runner.resetShopCache();
  await env.runner.run(job());
  assert.equal(env.calls.listShops, 9);
});

test('上传耗时导致租约不足时禁止最终提交', async () => {
  let time = Date.now();
  const expires = time + 120_000;
  const env = setup('auto', {async invoiceUploadPdf() {
    time += 80_000;
    return {ok: true, key: 'tos-key'};
  }}, () => time);
  await env.runner.run(job({lease_expires_at: new Date(expires).toISOString()}));
  assert.equal(env.calls.submit, 0);
  assert.equal(env.reports[0].state, 'retryable');
  assert.match(env.reports[0].message, /提交前租约/);
});

test('核对耗时导致租约不足时禁止上传PDF', async () => {
  let time = Date.now();
  const expires = time + 120_000;
  const env = setup('auto', {async invoiceList() {
    time += 80_000;
    return {rows: [{shop_order_id: 'order-1', invoice_amount: '79.80', invoice_status: 1, invoice_status_text: '待开票'}]};
  }}, () => time);
  await env.runner.run(job({lease_expires_at: new Date(expires).toISOString()}));
  assert.equal(env.calls.upload, 0);
  assert.equal(env.calls.submit, 0);
  assert.match(env.reports[0].message, /上传前租约/);
});

test('upload-only 上传成功后不提交，回 retryable', async () => {
  const env = setup('upload-only');
  await env.runner.run(job());
  assert.equal(env.calls.upload, 1);
  assert.equal(env.calls.submit, 0);
  assert.equal(env.reports[0].state, 'retryable');
  assert.match(env.reports[0].message, /upload-only/);
});

test('auto 提交失败但已开票列表存在时按 uploaded 回传', async () => {
  let doneChecks = 0;
  const env = setup('auto', {
    async invoiceList(args) {
      if (args.status_desc === 'done_blue') {
        doneChecks += 1;
        return {rows: [{shop_order_id: 'order-1'}], total: 1};
      }
      return {rows: [{shop_order_id: 'order-1', invoice_amount: '￥ 79.80', invoice_status: 1, invoice_status_text: '待开票'}], total: 1};
    },
    async invoiceSubmit() { return {ok: false, submitted: false, alreadySubmitted: false, errorMsg: '响应丢失'}; },
  });
  await env.runner.run(job());
  assert.equal(doneChecks, 1);
  assert.equal(env.reports[0].state, 'uploaded');
});
