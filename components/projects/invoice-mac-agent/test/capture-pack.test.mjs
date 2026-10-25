import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {packCapture, loadManifest, sha256, shanghaiDate, validateCapture} from '../capture-pack.mjs';
const success = (businessType, rowCount) => ({shopId: 's1', businessType, status: 'success', isComplete: true, rowCount, errorCode: null, errorMessage: null});
const row = {businessType: 'consumer_order', shopId: 's1', orderId: '6953220432659486690', amount: 87.8};
const capturedAt = '2026-10-16T16:01:02.345Z';
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-pack-test-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
test('稳定排序/键序，gzip哈希、权限、重复行计数与原样恢复', t => {
  const stateDir = temp(t);
  const rows = [row, {...row, orderId: 'a'}, row];
  const shopResults = [success('consumer_order', 3), success('platform_bill', 0)];
  const first = packCapture({rows, shopResults, stateDir, capturedAt});
  const second = packCapture({rows: rows.toReversed().map(r => Object.fromEntries(Object.entries(r).reverse())), shopResults, stateDir, capturedAt});
  assert.equal(first.manifest.captureRunId, second.manifest.captureRunId);
  assert.equal(first.manifest.fileSha256, second.manifest.fileSha256);
  assert.equal(first.manifest.statDate, '2026-10-17');
  const file = fs.readFileSync(first.manifest.gzipPath);
  assert.equal(sha256(file), first.manifest.fileSha256);
  assert.equal(gunzipSync(file).toString().trim().split('\n').length, 3);
  assert.deepEqual(loadManifest(first.manifestPath), first.manifest);
  assert.equal(fs.statSync(first.manifestPath).mode & 0o777, 0o600);
  fs.appendFileSync(first.manifest.gzipPath, 'tampered');
  assert.throws(() => loadManifest(first.manifestPath), /SHA-256/);
});
test('空全失败批次合法gzip；不同shopResults不撞ID', t => {
  const stateDir = temp(t);
  const failed = {...success('consumer_order', 0), status: 'failed', isComplete: false, rowCount: null, errorCode: 'LOGIN_EXPIRED', errorMessage: '登录失效'};
  const a = packCapture({rows: [], shopResults: [failed], stateDir, capturedAt});
  const b = packCapture({rows: [], shopResults: [{...failed, errorCode: 'PAGE_TIMEOUT'}], stateDir, capturedAt});
  assert.ok(a.manifest.fileSize > 0);
  assert.equal(gunzipSync(fs.readFileSync(a.manifest.gzipPath)).length, 0);
  assert.notEqual(a.manifest.captureRunId, b.manifest.captureRunId);
  assert.equal(shanghaiDate(new Date('2026-10-16T15:59:59Z')), '2026-10-16');
});
test('shopResults严格校验与逐店对账', () => {
  assert.throws(() => validateCapture([row], []));
  assert.throws(() => validateCapture([row], [success('consumer_order', 0)]), /逐店/);
  assert.throws(() => validateCapture([row], [success('consumer_order', 1), success('consumer_order', 1)]), /重复/);
  assert.throws(() => validateCapture([row], [{...success('consumer_order', 1), errorMessage: 'bad'}]), /success/);
  assert.throws(() => validateCapture([row], [{...success('consumer_order', 1), status: 'failed', isComplete: false, rowCount: null, errorCode: 'OTHER', errorMessage: 'bad'}]), /失败/);
  assert.throws(() => validateCapture([{...row, orderId: 1}], [success('consumer_order', 1)]), /字符串/);
});
