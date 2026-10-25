import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {acquireCaptureLock, runCapture} from '../capture-runner.mjs';
import {parseCaptureArgs} from '../capture-cli.mjs';
import {assertCaptureConfig, loadConfig} from '../config.mjs';
const log = {info() {}, warn() {}};
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-runner-test-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true})); return dir; }
test('锁防重入、异常释放与默认开关', async t => {
  const dir = temp(t);
  const release = acquireCaptureLock(dir);
  assert.equal(acquireCaptureLock(dir), null);
  const cfg = {captureEnabled: true, captureStateDir: dir};
  assert.equal((await runCapture({cfg, log})).status, 'locked');
  release(); release();
  await assert.rejects(() => runCapture({cfg, log, source: {collect() { throw Error('test'); }}}), /test/);
  assert.ok(!fs.existsSync(path.join(dir, 'capture.lock')));
  assert.equal((await runCapture({cfg: {...cfg, captureEnabled: false}, log})).status, 'disabled');
});
test('dry-run不访问cloud；未完成清单不得覆盖', async t => {
  const dir = temp(t);
  const cfg = {captureEnabled: false, captureStateDir: dir};
  const source = {collect: async () => ({rows: [], shopResults: [{shopId: 's', businessType: 'consumer_order', status: 'failed', isComplete: false, rowCount: null, errorCode: 'OTHER', errorMessage: 'test'}]})};
  const result = await runCapture({cfg, log, dryRun: true, source, cloud: new Proxy({}, {get() { throw Error('禁止云端访问'); }})});
  assert.equal(result.status, 'prepared');
  await assert.rejects(() => runCapture({cfg, log, dryRun: true, source}), /未完成批次/);
});
test('CLI拒绝危险/不明确参数，环境布尔值不按字符串真值解析', () => {
  assert.deepEqual(parseCaptureArgs(['--once', '--resume', '--complete']), {resume: true, complete: true});
  assert.throws(() => parseCaptureArgs(['--dry-run', '--complete']));
  assert.throws(() => parseCaptureArgs(['--shop-id']));
  assert.throws(() => parseCaptureArgs(['--resume', '--shop-id', 's']));
  assert.throws(() => parseCaptureArgs(['--auto']));
  assert.equal(loadConfig({INVOICE_AGENT_CAPTURE_ENABLED: 'false'}).captureEnabled, false);
  assert.equal(loadConfig({INVOICE_AGENT_CAPTURE_ENABLED: 'true'}).captureEnabled, true);
  assert.throws(() => loadConfig({INVOICE_AGENT_CAPTURE_ENABLED: '1'}));
  assert.throws(() => assertCaptureConfig({...loadConfig({}), captureUploadAllFailedBatch: false}, {dryRun: true}));
});
