import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signedPayload, notifyTaskFailure, queueFailure, deliverAlert, flushAlerts, macFailureId } from '../src/failure-alerts.js';
import { cloudEvents, captureEvent, watchOnce, workerFailureEvent } from '../src/failure-watch.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xdr-alert-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.json');
  const url = 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-1111-4111-8111-111111111111';
  writeFileSync(configPath, JSON.stringify({ url, secret: 'test-secret' }));
  return { root, configPath, stateDir: join(root, 'state'), url, sleep: async () => {} };
}
const event = { id: 'job:1', task: 'sync_orders', reason: 'command_failed:not_logged_in', phase: 'fetching_orders' };
const response = (code = 0) => ({ ok: true, json: async () => ({ code }) });

test('飞书签名与独立Python HMAC向量一致', () => {
  const payload = signedPayload('test', 'test-secret', 1599360473000);
  assert.equal(payload.timestamp, '1599360473');
  assert.equal(payload.sign, 'wSds2BzzFIIGf/WrhUO+NI1q/9j+FRJd3JNHKAq0NZY=');
});

test('同一作业重复扫描和并发发送只产生一次成功通知', async t => {
  const f = fixture(t); let calls = 0;
  const options = { ...f, fetchImpl: async () => { calls++; await new Promise(r => setTimeout(r, 15)); return response(); } };
  await Promise.all([notifyTaskFailure(event, options), notifyTaskFailure(event, options)]);
  await notifyTaskFailure(event, options);
  assert.equal(calls, 1);
});

test('HTTP 200中的飞书业务错误不能当成功，保留待发消息并后续重试', async t => {
  const f = fixture(t); let calls = 0;
  const path = queueFailure(event, f);
  const result = await deliverAlert(path, { ...f, fetchImpl: async () => { calls++; return response(19021); } });
  assert.equal(result.pending, true); assert.equal(calls, 3);
  assert.equal(JSON.parse(readFileSync(path)).sent_at, undefined);
  const retry = await flushAlerts({ ...f, fetchImpl: async () => { calls++; return response(); } });
  assert.equal(retry[0].sent, true); assert.equal(calls, 4);
});

test('通知和待发队列不包含密钥、webhook、Cookie或Authorization', async t => {
  const f = fixture(t); let body;
  const unsafe = { ...event, reason: `${f.url} test-secret\nCookie: private-cookie\nAuthorization: Bearer private-token` };
  const path = queueFailure(unsafe, f);
  await deliverAlert(path, { ...f, fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return response(); } });
  for (const value of ['test-secret', f.url, 'private-cookie', 'private-token']) {
    assert(!body.content.text.includes(value)); assert(!readFileSync(path, 'utf8').includes(value));
  }
});

test('网络异常文本不进入持久化错误或通知', async t => {
  const f = fixture(t); const path = queueFailure(event, f);
  await deliverAlert(path, { ...f, fetchImpl: async () => { throw new Error(f.url + ' test-secret'); } });
  const raw = readFileSync(path, 'utf8'); assert(!raw.includes('test-secret')); assert(!raw.includes(f.url));
  assert.equal(JSON.parse(raw).last_error, 'delivery_failed');
});

test('云端入队成功时仍依据实际作业失败通知，并忽略启用前的历史失败', () => {
  const snapshot = { jobs: [
    { id: 'old', task: 'sync_orders', state: 'failed', completed_at: '2026-10-17T01:00:00Z' },
    { id: 'new', task: 'sync_orders', state: 'failed', completed_at: '2026-10-17T13:21:00Z', error: 'not_logged_in' },
  ], units: [{ Id: 'xdr-sync-orders-daily.service', Result: 'success', ExecMainStatus: '0' }] };
  const events = cloudEvents(snapshot, '2026-10-17T13:20:00Z');
  assert.equal(events.length, 1); assert.equal(events[0].id, 'cloud-job:new');
});

test('中国服务器CST时间按UTC+8处理，避免历史失败误报为新失败', () => {
  const units = [
    { Id: 'old.service', Result: 'exit-code', ExecMainStatus: '1', ExecMainExitTimestamp: 'Sat 2026-10-17 21:19:00 CST' },
    { Id: 'new.service', Result: 'exit-code', ExecMainStatus: '1', ExecMainExitTimestamp: 'Sat 2026-10-17 21:21:00 CST' },
  ];
  const events = cloudEvents({ units }, '2026-10-17T13:20:00Z');
  assert.equal(events.length, 1); assert.equal(events[0].failed_at, '2026-10-17T13:21:00.000Z');
});

test('发票进程退出成功但店铺采集失败也会生成通知', () => {
  const e = captureEvent({ captureRunId: 'run1', statDate: '2026-10-17', shopResults: [
    { shopId: 'a', status: 'success' },
    { shopId: 'b', status: 'failed', businessType: 'platform_bill', errorCode: 'LOGIN_EXPIRED' },
  ] }, { b: '测试店铺' });
  assert.equal(e.task, 'local.invoice-capture-sync');
  assert.match(e.reason, /1项失败.*\n测试店铺/);
  assert.match(e.reason, /LOGIN_EXPIRED/);
});

test('监控重启后仍能去重，初始化不群发历史错误', async t => {
  const f = fixture(t); const boardPath = join(f.root, 'board.json'); writeFileSync(boardPath, '{"tasks":[]}');
  let calls = 0, scan = 0;
  const old = { id: 'old', task: 'sync_orders', state: 'failed', completed_at: '2026-10-17T00:00:00Z' };
  const fresh = { id: 'new', task: 'sync_orders', state: 'failed', completed_at: new Date(Date.now() + 1000).toISOString() };
  const options = { stateDir: f.stateDir, boardPath, workerStatusPaths: [], captureDir: join(f.root, 'empty'), pdfLog: join(f.root, 'empty.log'), shopsPath: join(f.root, 'shops.json'),
    collect: async () => ({ captured_at: new Date().toISOString(), jobs: ++scan === 1 ? [old] : [old, fresh] }),
    alertOptions: { configPath: f.configPath, sleep: async () => {}, fetchImpl: async () => { calls++; return response(); } },
  };
  await watchOnce(options); assert.equal(calls, 0);
  await watchOnce(options); assert.equal(calls, 1);
  await watchOnce(options); assert.equal(calls, 1);
  assert.equal(readdirSync(join(f.stateDir, 'outbox')).filter(n => n.endsWith('.json')).length, 1);
});

test('本机原生通知与监控兜底使用相同执行编号，且脚本漏发时监控能补发', async t => {
  const f = fixture(t); const boardPath = join(f.root, 'board.json');
  const task = 'com.xdr.jst-purple-orders-sync';
  writeFileSync(boardPath, JSON.stringify({ tasks: [{ id: task, host: 'mac', installed: true }] }));
  let runs = 0, calls = 0;
  const options = { stateDir: f.stateDir, boardPath, workerStatusPaths: [], captureDir: join(f.root, 'empty'), pdfLog: join(f.root, 'empty.log'), shopsPath: join(f.root, 'shops.json'),
    collect: async () => ({ jobs: [], captured_at: new Date().toISOString() }),
    probeMac: async () => ({ loaded: true, runs, coalition: 'fixture', exit: runs ? 1 : 0, running: false }),
    alertOptions: { configPath: f.configPath, sleep: async () => {}, fetchImpl: async () => { calls++; return response(); } },
  };
  await watchOnce(options);
  runs = 1;
  await notifyTaskFailure({ id: macFailureId(task, { runs, coalition: 'fixture' }), task, reason: 'fixture failure' }, { ...f, ...options.alertOptions });
  await watchOnce(options); assert.equal(calls, 1);
  runs = 2;
  await watchOnce(options); assert.equal(calls, 2);
});

test('PDF回传业务失败被捕获，同一个job反复重试只通知一次', async t => {
  const f = fixture(t); const boardPath = join(f.root, 'board.json'); writeFileSync(boardPath, '{"tasks":[]}');
  const pdfLog = join(f.root, 'pdf.log'); writeFileSync(pdfLog, '');
  let calls = 0;
  const options = { stateDir: f.stateDir, boardPath, workerStatusPaths: [], pdfLog, captureDir: join(f.root, 'empty'), shopsPath: join(f.root, 'shops.json'),
    collect: async () => ({ jobs: [], captured_at: new Date().toISOString() }),
    alertOptions: { configPath: f.configPath, sleep: async () => {}, fetchImpl: async () => { calls++; return response(); } },
  };
  await watchOnce(options);
  const row = { ts: new Date().toISOString(), event: 'job_decision', job_id: 'pdf1', state: 'retryable', message: '登录失效' };
  appendFileSync(pdfLog, JSON.stringify(row) + '\n');
  await watchOnce(options); assert.equal(calls, 1);
  appendFileSync(pdfLog, JSON.stringify({ ...row, state: 'failed' }) + '\n');
  await watchOnce(options); assert.equal(calls, 1);
});

test('监控身份格式升级只重建基线，不把既有失败当成新失败', async t => {
  const f = fixture(t); const boardPath = join(f.root, 'board.json');
  writeFileSync(boardPath, JSON.stringify({ tasks: [{ id: 'test-task', host: 'mac', installed: true }] }));
  let calls = 0, runs = 1;
  const options = { stateDir: f.stateDir, boardPath, workerStatusPaths: [], pdfLog: join(f.root, 'empty.log'), captureDir: join(f.root, 'empty'), shopsPath: join(f.root, 'shops.json'),
    collect: async () => ({ jobs: [], captured_at: new Date().toISOString() }),
    probeMac: async () => ({ loaded: true, runs, coalition: 'fixture', exit: 1, running: false }),
    alertOptions: { configPath: f.configPath, sleep: async () => {}, fetchImpl: async () => { calls++; return response(); } },
  };
  await watchOnce(options);
  const path = join(f.stateDir, 'monitor.json'); const state = JSON.parse(readFileSync(path));
  delete state.mac_key_version; state.mac['test-task'] = '[true,1,1]'; writeFileSync(path, JSON.stringify(state));
  await watchOnce(options); assert.equal(calls, 0);
  runs = 2; await watchOnce(options); assert.equal(calls, 1);
});

test('兼容飞书旧版成功字段，同时拒绝缺少业务成功码的响应', async t => {
  const f = fixture(t); const first = queueFailure(event, f);
  assert.equal((await deliverAlert(first, { ...f, fetchImpl: async () => ({ ok: true, json: async () => ({ StatusCode: 0 }) }) })).sent, true);
  const second = queueFailure({ ...event, id: 'job:2' }, f);
  assert.equal((await deliverAlert(second, { ...f, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })).pending, true);
});

test('Mac上报云端失败时，仍能从本机worker状态通知，并与云端记录去重', () => {
  const status = { result: 'failed', job_id: 'same-job', task: 'sync_orders', error: 'server_unreachable', completed_at: '2026-10-17T13:21:00Z' };
  const local = workerFailureEvent(status, '2026-10-17T13:20:00Z');
  const remote = cloudEvents({ jobs: [{ ...status, id: status.job_id, state: 'failed' }] }, '2026-10-17T13:20:00Z')[0];
  assert.equal(local.id, remote.id);
  assert.equal(workerFailureEvent({ ...status, completed_at: '2026-10-17T13:19:00Z' }, '2026-10-17T13:20:00Z'), null);
});

test('售后等待和补采期间不通知，补采成功不通知，最终失败每轮仅通知一次', async t => {
  const f = fixture(t), task = 'local.shopdesk.aftersale-counts';
  const boardPath = join(f.root,'board.json'), statusPath = join(f.root,'status.json');
  writeFileSync(boardPath,JSON.stringify({tasks:[{id:task,host:'mac',installed:true}]}));
  let record={loaded:true,runs:0,coalition:'fixture',exit:0,running:false}, bodies=[];
  const options={stateDir:f.stateDir,boardPath,workerStatusPaths:[],captureDir:join(f.root,'empty'),pdfLog:join(f.root,'empty.log'),shopsPath:join(f.root,'shops.json'),aftersaleStatusPath:statusPath,
    collect:async()=>({jobs:[],captured_at:new Date().toISOString()}),probeMac:async()=>record,
    alertOptions:{configPath:f.configPath,sleep:async()=>{},fetchImpl:async(_url,opts)=>{bodies.push(JSON.parse(opts.body).content.text);return response();}}};
  await watchOnce(options);
  record={...record,runs:1,running:true,exit:2};await watchOnce(options);assert.equal(bodies.length,0);
  record={...record,running:false,exit:0};await watchOnce(options);assert.equal(bodies.length,0);
  record={...record,runs:2,running:true};await watchOnce(options);assert.equal(bodies.length,0);
  writeFileSync(statusPath,JSON.stringify({run_id:'final-run',launchd_runs:2,completed_at:new Date().toISOString(),retry_complete:true,exit_code:2,shops_total:39,shops_ok:38,shops_failed:1,errors:[{shop:'测试店',reason:'等待页面超时'}]}));
  record={...record,running:false,exit:2};await watchOnce(options);await watchOnce(options);
  assert.equal(bodies.length,1);assert.match(bodies[0],/共39家，成功38家，最终失败1家/);
  assert.match(bodies[0],/轮末补采已结束/);assert.match(bodies[0],/测试店：等待页面超时/);
});

test('售后通知详情不混入旧轮次或手动运行的状态', async () => {
  const {aftersaleFailureDetail}=await import('../src/failure-watch.js');
  const task={id:'local.shopdesk.aftersale-counts'},record={exit:2,runs:3};
  const status={exit_code:2,retry_complete:true,launchd_runs:2,run_id:'old',completed_at:'now'};
  assert.equal(aftersaleFailureDetail(task,record,status),null);
  assert.equal(aftersaleFailureDetail(task,record,{...status,launchd_runs:null}),null);
});
