import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { openStore, saveShop } from '../lib/store.mjs';
import { prepareSnapshot, publishWarehouse } from '../lib/warehouse.mjs';
import { run, parseArgs } from '../collect.mjs';
import { CaptureError } from '../lib/common.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const snapshot = date => ({shop: {id: 'shop-1', name: '测试店'}, date,
  rows: [{staffUserInfo: {staffId: '7695647379231383083'}, staffName: '客服', rank: 1, servConvCnt: 8}],
  total: 1, fetchedAt: '2026-10-18T00:00:00Z', sum: {servConvCnt: 8}, average: {servConvCnt: '8.00'},
  core: {coreChartInfo: {chart_info: {data: [{index_name: 'loginStaffCnt', y: '13'}]}}, avgOnlineInfo: {index_value: '28986'}}});
function source(dir, date = '2026-10-16') {
  const db = openStore(dir); saveShop(db, snapshot(date), 'run-1'); db.close();
  return path.join(dir, 'feige-customer.sqlite');
}

test('发布快照一致、只读视图可查询且不改本地源库', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feige-cloud-'));
  try {
    const input = source(dir), before = fs.readFileSync(input), target = path.join(dir, 'snapshot.sqlite');
    const manifest = prepareSnapshot(input, target);
    assert.equal(manifest.row_counts.staff_daily, 1);
    assert.deepEqual(fs.readFileSync(input), before);
    const db = new DatabaseSync(target, {readOnly: true});
    assert.equal(db.prepare('SELECT staff_id FROM v_staff_daily').get().staff_id, '7695647379231383083');
    assert.equal(db.prepare('SELECT login_staff,avg_online_seconds FROM v_shop_core_daily').get().avg_online_seconds, 28986);
    assert.equal(db.prepare('SELECT login_staff FROM v_shop_core_daily').get().login_staff, 13);
    db.close();
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('真实接收器原子应用，拒绝错误校验和和丢失历史，重复发布不重复行', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feige-receiver-'));
  try {
    const one = path.join(dir, 'one.sqlite'), two = path.join(dir, 'two.sqlite');
    const first = prepareSnapshot(source(path.join(dir, 'one'), '2026-10-16'), one);
    const second = prepareSnapshot(source(path.join(dir, 'two'), '2026-10-17'), two);
    const payload = {root: dir, helper: path.join(ROOT, 'cloud/apply-snapshot.py'), one, two, first, second};
    const script = String.raw`
import sys,json,importlib.util,shutil,hashlib,os,types
from pathlib import Path
p=json.load(sys.stdin)
spec=importlib.util.spec_from_file_location('receiver',p['helper']);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.BASE=Path(p['root'])/'cloud';m.TARGET=m.BASE/'data/feige-customer.sqlite'
m.os.chown=lambda *args:None
m.pwd.getpwnam=lambda name:types.SimpleNamespace(pw_uid=os.getuid())
m.grp.getgrnam=lambda name:types.SimpleNamespace(gr_gid=os.getgid())
def upload(manifest,file):
 r=m.main({'action':'prepare','manifest':manifest});shutil.copyfile(file,r['incoming'])
 return r
upload(p['first'],p['one']);r=m.main({'action':'apply','manifest':p['first']});assert r['row_counts']['staff_daily']==1
original=m.TARGET.read_bytes()
upload(p['first'],p['one']);bad=dict(p['first'],sha256='0'*64)
try:m.main({'action':'apply','manifest':bad});raise AssertionError('accepted bad checksum')
except ValueError as e:assert str(e)=='checksum_mismatch'
assert m.TARGET.read_bytes()==original
upload(p['second'],p['two'])
try:m.main({'action':'apply','manifest':p['second']});raise AssertionError('accepted missing history')
except ValueError as e:assert str(e)=='would_remove_history'
assert m.TARGET.read_bytes()==original
upload(p['first'],p['one']);assert m.main({'action':'apply','manifest':p['first']})['ok']
assert m.TARGET.read_bytes()==original
print('receiver checks passed')
`;
    assert.match(execFileSync('python3', ['-c', script], {input: JSON.stringify(payload), encoding: 'utf8'}), /checks passed/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('云端ACK行数错误不能返回同步成功，并保留本地事实', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feige-ack-'));
  try {
    const input = source(dir);
    await assert.rejects(publishWarehouse({source: input, stateDir: dir, config: {host: 'test', port: 22, identity: '/unused'},
      executeImpl: async (file, _args, script) => {
        if (file === 'scp') return '';
        const encoded = script.match(/base64\.b64decode\("([^"]+)"\)/)[1];
        const request = JSON.parse(Buffer.from(encoded, 'base64').toString());
        if (request.action === 'prepare') return JSON.stringify({ok: true});
        return JSON.stringify({ok: true, sha256: request.manifest.sha256, row_counts: {...request.manifest.row_counts, staff_daily: 2}});
      }}), {code: 'cloud_ack_mismatch'});
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cloud-status.json'))).status, 'failed');
    const db = new DatabaseSync(input, {readOnly: true}); assert.equal(db.prepare('SELECT count(*) AS n FROM staff_daily').get().n, 1); db.close();
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('定时流程采集后发布；发布失败保留本地数据并发送失败通知', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feige-flow-'));
  try {
    let alerted = 0, uploaded = 0;
    const result = await run({date: '2026-10-16', outputDir: dir, notify: true, publish: true}, {
      shops: [{id: 'shop-1', name: '测试店'}], collectShop: async () => snapshot('2026-10-16'), log: () => {}, logFile: path.join(dir, 'run.log'),
      publish: async options => { uploaded++; assert(fs.existsSync(options.source)); throw new CaptureError('cloud_transport_failed', '连接失败'); },
      alert: async event => { alerted++; assert.equal(event.phase, '阿里云数仓同步'); return {sent: true}; },
    });
    assert.equal(result.status, 'sync_failed'); assert.equal(result.cloud.status, 'failed');
    assert.equal(result.staff_rows_this_run, 1); assert.equal(uploaded, 1); assert.equal(alerted, 1);
    assert.equal(parseArgs([]).publish, true); assert.equal(parseArgs(['--local-only']).publish, false);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
