import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {captureFileDate, captureCutoffDate, runCaptureCleanup} from '../capture-cleanup.mjs';
import {parseCleanupArgs} from '../capture-cleanup-cli.mjs';
import {acquireCaptureLock, runCapture} from '../capture-runner.mjs';
import {packCapture, saveManifest} from '../capture-pack.mjs';
import {assertCaptureCleanupConfig, loadConfig} from '../config.mjs';

const now = new Date('2026-10-16T20:30:00Z'); // 上海10月17日04:30
const log = {info() {}, warn() {}, error() {}};
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-cleanup-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return {dir, cfg: {captureStateDir: dir, captureRetentionDays: 7}};
}
function batch(dir, date, status = 'processed') {
  const result = packCapture({stateDir: dir, rows: [], capturedAt: date + 'T00:00:00Z',
    shopResults: [{shopId: 's', businessType: 'consumer_order', status: 'success', isComplete: true, rowCount: 0, errorCode: null, errorMessage: null}]});
  saveManifest(result.manifestPath, {...result.manifest, status});
  return result;
}

test('按上海自然日保留今天和前6天，覆盖UTC跨日、月初和闰年', () => {
  assert.equal(captureCutoffDate(now, 7), '2026-10-11');
  assert.equal(captureCutoffDate(new Date('2026-10-16T15:59:59Z'), 7), '2026-10-10');
  assert.equal(captureCutoffDate(new Date('2026-10-16T16:00:00Z'), 7), '2026-10-11');
  assert.equal(captureCutoffDate(new Date('2024-03-01T00:00:00Z'), 7), '2024-02-24');
  assert.equal(captureCutoffDate(now, 1), '2026-10-17');
  for (const days of [0, -1, 1.5, NaN, 3651]) assert.throws(() => captureCutoffDate(now, days));
});

test('整批删除过期gzip与两份清单，保留七天边界；mtime不延长保留', t => {
  const {dir, cfg} = setup(t);
  const expired = batch(dir, '2026-10-10');
  const boundary = batch(dir, '2026-10-11');
  const recent = batch(dir, '2026-10-17');
  fs.utimesSync(expired.manifest.gzipPath, now, now);
  fs.utimesSync(boundary.manifest.gzipPath, new Date(0), new Date(0));
  const result = runCaptureCleanup({cfg, now, log});
  assert.equal(result.status, 'cleaned');
  assert.equal(result.deletedCount, 3);
  assert.ok(result.deletedBytes > 0);
  assert.ok(!fs.existsSync(expired.manifestPath));
  assert.ok(!fs.existsSync(expired.manifest.gzipPath));
  assert.ok(!fs.existsSync(path.join(dir, expired.manifest.captureRunId + '-manifest.json')));
  for (const b of [boundary, recent]) {
    assert.ok(fs.existsSync(b.manifestPath));
    assert.ok(fs.existsSync(b.manifest.gzipPath));
    assert.ok(fs.existsSync(path.join(dir, b.manifest.captureRunId + '-manifest.json')));
  }
  assert.ok(!fs.existsSync(path.join(dir, 'capture.lock')));
});

test('历史归档、未完成批次、损坏清单和临时文件均遵守七天期限', t => {
  const {dir, cfg} = setup(t);
  batch(dir, '2026-10-09', 'uploaded');
  batch(dir, '2026-10-08', 'prepared');
  const old = [
    '2026-10-10-manifest.before-live-230110.json',
    '2026-10-10-pre-cookie-fix-manifest.json',
    '2026-10-10-manifest.json.part',
    'mac-20261010-094000-1234abcd-abcd1234.jsonl.gz.part',
    'mac-20261010-094000-1234abcd-abcd1234-manifest.json.part',
    'mac-20261010-094000-1234abcd-abcd1234.jsonl',
  ];
  for (const name of old) fs.writeFileSync(path.join(dir, name), 'invalid JSON/data');
  const result = runCaptureCleanup({cfg, now, log});
  assert.equal(result.deletedCount, 6 + old.length);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('预览列出候选及字节但不删除任何文件，结束释放锁', t => {
  const {dir, cfg} = setup(t);
  batch(dir, '2026-10-10');
  const before = fs.readdirSync(dir).map(name => [name, fs.readFileSync(path.join(dir, name))]);
  const result = runCaptureCleanup({cfg, now, dryRun: true, log});
  assert.equal(result.status, 'dry-run');
  assert.equal(result.candidateCount, 3);
  assert.equal(result.deletedCount, 0);
  assert.equal(result.candidateBytes, before.reduce((sum, [, bytes]) => sum + bytes.length, 0));
  for (const [name, bytes] of before) assert.deepEqual(fs.readFileSync(path.join(dir, name)), bytes);
  assert.ok(!fs.existsSync(path.join(dir, 'capture.lock')));
});

test('未知文件、伪造日期、目录和软链接不删除，不追踪清单中的外部路径', t => {
  const {dir, cfg} = setup(t);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-cleanup-outside-'));
  t.after(() => fs.rmSync(externalDir, {recursive: true, force: true}));
  const outside = path.join(externalDir, 'keep.jsonl.gz');
  fs.writeFileSync(outside, 'keep outside');
  fs.writeFileSync(path.join(dir, '2026-10-10-manifest.json'), JSON.stringify({gzipPath: outside}));
  fs.symlinkSync(outside, path.join(dir, 'mac-20261009-094000-1234abcd-abcd1234.jsonl.gz'));
  fs.mkdirSync(path.join(dir, '2026-10-09-manifest.json'));
  const keep = ['config.json', 'agent.log', '2026-10-10-not-capture.txt', '2026-02-30-manifest.json', 'mac-20260230-094000-1234abcd-abcd1234.jsonl.gz'];
  for (const name of keep) fs.writeFileSync(path.join(dir, name), 'keep');
  const result = runCaptureCleanup({cfg, now, log});
  assert.equal(result.deletedCount, 1);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep outside');
  for (const name of keep) assert.ok(fs.existsSync(path.join(dir, name)));
  assert.ok(fs.lstatSync(path.join(dir, 'mac-20261009-094000-1234abcd-abcd1234.jsonl.gz')).isSymbolicLink());
  assert.ok(fs.statSync(path.join(dir, '2026-10-09-manifest.json')).isDirectory());
});

test('采集持锁时整次清理跳过，清理持锁时采集不执行', async t => {
  const {dir, cfg} = setup(t);
  batch(dir, '2026-10-10');
  const release = acquireCaptureLock(dir);
  assert.equal(runCaptureCleanup({cfg, now, log}).status, 'locked');
  assert.ok(fs.existsSync(path.join(dir, '2026-10-10-manifest.json')));
  release();
  let captureAttempt;
  runCaptureCleanup({cfg, now, log: {info() {
    captureAttempt ||= runCapture({cfg: {...cfg, captureEnabled: true}, log,
      source: {collect() { throw Error('不应进入采集'); }}});
  }}});
  assert.equal((await captureAttempt).status, 'locked');
});

test('目录不存在时不创建；拒绝根目录、相对目录、软链接目录和非法参数', t => {
  const {dir, cfg} = setup(t);
  const missing = path.join(dir, 'missing');
  assert.equal(runCaptureCleanup({cfg: {...cfg, captureStateDir: missing}, now, log}).status, 'missing');
  assert.ok(!fs.existsSync(missing));
  const link = path.join(dir, 'link');
  fs.symlinkSync(dir, link);
  assert.throws(() => runCaptureCleanup({cfg: {...cfg, captureStateDir: link}, now, log}), /符号链接/);
  for (const captureStateDir of ['/', 'relative']) assert.throws(() => assertCaptureCleanupConfig({...cfg, captureStateDir}));
  assert.throws(() => assertCaptureCleanupConfig({...cfg, captureRetentionDays: 0}));
  assert.equal(loadConfig({INVOICE_AGENT_CAPTURE_RETENTION_DAYS: '7'}).captureRetentionDays, 7);
  assert.deepEqual(parseCleanupArgs(['--once', '--dry-run']), {dryRun: true});
  assert.throws(() => parseCleanupArgs(['--complete']));
  assert.equal(captureFileDate('../2026-10-10-manifest.json'), null);
});

test('删除单文件失败时记录错误并继续，始终释放采集锁', t => {
  const {dir, cfg} = setup(t);
  batch(dir, '2026-10-10');
  const original = fs.unlinkSync;
  const errors = [];
  fs.unlinkSync = file => {
    if (file === path.join(dir, '2026-10-10-manifest.json')) throw Object.assign(Error('测试删除失败'), {code: 'EACCES'});
    return original(file);
  };
  let result;
  try { result = runCaptureCleanup({cfg, now, log: {info() {}, error(value) { errors.push(value); }}}); }
  finally { fs.unlinkSync = original; }
  assert.equal(result.status, 'partial');
  assert.equal(result.errorCount, 1);
  assert.equal(result.deletedCount, 2);
  assert.equal(errors.length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'capture.lock')));
});
