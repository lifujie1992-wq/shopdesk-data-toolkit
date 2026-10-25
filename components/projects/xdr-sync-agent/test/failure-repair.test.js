import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enqueueIncident, atomicJson, scrub, incidentKey } from '../src/failure-incidents.js';
import { repairOnce, repairStatus } from '../src/failure-repair.js';
import { snapshotProject, changedFiles, applyPatch, rollbackPatch, validateWorkspace, runProcess } from '../src/repair-workspace.js';
import { monthlyFailureEvents, watchOnce } from '../src/failure-watch.js';
import { queueFailure, deliverAlert } from '../src/failure-alerts.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xdr-repair-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'project'), stateDir = join(root, 'state'), configPath = join(root, 'repair.json'), alertState = join(root, 'alerts'), alertConfig = join(root, 'feishu.json');
  mkdirSync(join(project, 'src'), { recursive: true }); mkdirSync(join(project, 'test'));
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'src/value.js'), 'export const value = () => 1;\n');
  writeFileSync(join(project, 'test/value.test.js'), "import {value} from '../src/value.js';import assert from 'node:assert/strict';assert.equal(value(),2);\n");
  const config = { enabled: true, model: 'gpt-6.1-sol', maxAttempts: 2, timeoutSeconds: 30, inventory: join(root, 'board.json'),
    projects: { demo: { root: project, autoApply: true, allowPrefixes: ['src/', 'test/'], tests: [[process.execPath, '--test']] } }, tasks: [{ match: '^demo$', project: 'demo' }] };
  atomicJson(configPath, config); atomicJson(config.inventory, { tasks: [] });
  atomicJson(alertConfig, { url: 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-1111-4111-8111-111111111111', secret: 'fixture-secret' });
  const event = { id: 'demo:run1', task: 'demo', reason: 'value returned 1 instead of 2' };
  const options = { stateDir, configPath, alertState, alertConfig, deliver: async () => [], probe: async () => ({ running: false, runs: 1, exit: '1', coalition: 'same' }) };
  // macOS cannot nest sandbox-exec. Inside the registered outer validation sandbox,
  // run the toy suite directly; the normal test run separately exercises the OS boundary.
  if (process.env.XDR_VALIDATION_SANDBOX) options.validator = async (_project, _snapshot, workdir) => {
    const result = await runProcess(process.execPath, ['--test'], { cwd: workdir, timeoutMs: 10000 });
    return { passed: result.code === 0, results: [result] };
  };
  return { root, project, stateDir, configPath, config, event, options, alertConfig, alertState };
}
const diagnosis = { category: 'code_bug', outcome: 'patch_ready', cause: '返回值错误', evidence: ['固定测试期望2，实际1'], fix: '修正返回值为2', conclusion: '已准备修复', confidence: 'high' };
const fixAgent = async ({ workdir }) => { writeFileSync(join(workdir, 'src/value.js'), 'export const value = () => 2;\n'); return diagnosis; };

test('故障队列持久化去重、禁用和监控自身排除', t => {
  const f = fixture(t); const key = enqueueIncident(f.event, f.options);
  assert.equal(enqueueIncident(f.event, f.options), key); assert.equal(repairStatus(f.stateDir).counts.queued, 1);
  assert.equal(enqueueIncident({ ...f.event, task: 'com.xdr.failure-repair' }, f.options), null);
  atomicJson(f.configPath, { enabled: false }); assert.equal(enqueueIncident({ ...f.event, id: 'other' }, f.options), null);
});
test('失败通知进入处理队列后延迟原始消息，队列不可用则回退告警', async t => {
  const f = fixture(t); const path = queueFailure(f.event, { stateDir: f.alertState, configPath: f.alertConfig, autoRepair: true, repairOptions: f.options });
  assert.equal((await deliverAlert(path, { configPath: f.alertConfig })).queued_for_repair, true);
  assert.equal(repairStatus(f.stateDir).counts.queued, 1);
  const fallback = queueFailure({ ...f.event, id: 'fallback' }, { stateDir: f.alertState, configPath: f.alertConfig, autoRepair: true, repairOptions: { configPath: '/does/not/exist' } });
  assert.equal(JSON.parse(readFileSync(fallback)).repair_key, null);
});
test('快照排除生产数据和密钥，并拒绝已有测试篡改和源文件删除', t => {
  const f = fixture(t); mkdirSync(join(f.project, 'data')); writeFileSync(join(f.project, 'data/private.json'), '{"secret":"x"}');
  writeFileSync(join(f.project, 'auth.json'), '{"secret":"x"}');
  const work = join(f.root, 'work'), snapshot = snapshotProject(f.project, work), project = f.config.projects.demo;
  assert(!existsSync(join(work, 'data'))); assert(!existsSync(join(work, 'auth.json')));
  writeFileSync(join(work, 'test/value.test.js'), ''); assert.throws(() => changedFiles(snapshot, work, project), /existing_test/);
  rmSync(join(work, 'src/value.js')); assert.throws(() => changedFiles(snapshot, work, project), /source_deletion/);
});
test('真实操作系统沙箱验证通过后应用修复，保留备份和原始告警关联', async t => {
  const f = fixture(t); const original = queueFailure(f.event, { stateDir: f.alertState, configPath: f.alertConfig, autoRepair: true, repairOptions: f.options });
  const result = await repairOnce({ ...f.options, agent: fixAgent });
  assert.equal(result.status, 'applied'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 2/);
  const record = JSON.parse(readFileSync(join(f.stateDir, 'incidents', result.processed + '.json')));
  assert.equal(record.state, 'awaiting_verification'); assert(existsSync(join(record.run_dir, 'backup/src/value.js')));
  assert.equal(JSON.parse(readFileSync(original)).superseded_by, result.processed);
  assert.equal(JSON.parse(readFileSync(join(record.run_dir, 'validation.json'))).passed, true);
});
test('检查失败最多两轮，不修改生产文件，也不误报恢复', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options);
  const result = await repairOnce({ ...f.options, agent: fixAgent, validator: async () => ({ passed: false, results: [{ output: 'fixture failure' }] }) });
  assert.equal(result.attempts, 2); assert.equal(result.status, 'failed'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 1/);
});
test('处理期间有人修改源文件时拒绝覆盖', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options);
  const result = await repairOnce({ ...f.options, agent: async args => { const r = await fixAgent(args); writeFileSync(join(f.project, 'src/value.js'), 'export const value = () => 3;\n'); return r; } });
  assert.equal(result.status, 'failed'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 3/);
});
test('原任务运行中先暂存补丁，空闲后应用，后续进程成功不冒充业务已验证', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options); let running = true, runs = 1, exit = '1';
  const options = { ...f.options, agent: fixAgent, probe: async () => ({ running, runs, exit, coalition: 'same' }) };
  const first = await repairOnce(options); assert.equal(first.status, 'prepared'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 1/);
  running = false; await repairOnce(options); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 2/);
  runs = 2; exit = '0'; await repairOnce(options);
  assert.equal(repairStatus(f.stateDir).incidents[0].status, 'execution_succeeded');
});
test('后续执行仍失败会自动回滚，回滚不覆盖人工后续修改', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options);
  await repairOnce({ ...f.options, agent: fixAgent });
  await repairOnce({ ...f.options, probe: async () => ({ running: false, runs: 2, exit: '1', coalition: 'same' }) });
  assert.equal(repairStatus(f.stateDir).incidents[0].status, 'rolled_back'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 1/);
  const work = join(f.root, 'second'), snap = snapshotProject(f.project, work); await fixAgent({ workdir: work });
  const changes = changedFiles(snap, work, f.config.projects.demo), dir = join(f.root, 'deploy'); mkdirSync(dir);
  applyPatch(snap, work, changes, dir); writeFileSync(join(f.project, 'src/value.js'), 'human edit');
  assert.equal(rollbackPatch(dir).state, 'rollback_conflict'); assert.equal(readFileSync(join(f.project, 'src/value.js'), 'utf8'), 'human edit');
});
test('中断后优先恢复未完成部署，不重复执行AI', async t => {
  const f = fixture(t), key = enqueueIncident(f.event, f.options), path = join(f.stateDir, 'incidents', key + '.json');
  const work = join(f.root, 'crash/workspace'), runDir = join(f.root, 'crash'), snapshot = snapshotProject(f.project, work); await fixAgent({ workdir: work });
  applyPatch(snapshot, work, changedFiles(snapshot, work, f.config.projects.demo), runDir);
  const record = JSON.parse(readFileSync(path)); atomicJson(path, { ...record, state: 'running', attempts: 1, run_dir: runDir });
  await repairOnce({ ...f.options, agent: () => { throw new Error('must_not_run'); } });
  assert.equal(repairStatus(f.stateDir).incidents[0].status, 'rolled_back'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 1/);
});
test('相同故障短期重复只复用结论，不反复改代码', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options); let calls = 0;
  const agent = async args => { calls++; return fixAgent(args); };
  await repairOnce({ ...f.options, agent }); enqueueIncident({ ...f.event, id: 'demo:run2' }, f.options);
  const result = await repairOnce({ ...f.options, agent }); assert(result.coalesced); assert.equal(calls, 1);
});
test('Codex启动失败可收尾并生成失败结论，后续仍能处理新故障', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options);
  const result = await repairOnce({ ...f.options, agent: async () => { throw new Error('codex_execution_failed'); } });
  assert.equal(result.status, 'failed'); assert.equal(result.attempts, 2); assert.equal(repairStatus(f.stateDir).counts.done, 1);
});
test('验证沙箱禁止写生产目录，命令超时能终止进程组', { skip: !!process.env.XDR_VALIDATION_SANDBOX }, async t => {
  const f = fixture(t), work = join(f.root, 'work'), snapshot = snapshotProject(f.project, work);
  const project = { tests: [[process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(join(f.project, 'forbidden'))},'x')`]] };
  const validation = await validateWorkspace(project, snapshot, work, []); assert.equal(validation.passed, false); assert(!existsSync(join(f.project, 'forbidden')));
  const timeout = await runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 }); assert.equal(timeout.timedOut, true);
});
test('部署拒绝符号链接替换和验证后的补丁改动', async t => {
  const f = fixture(t), work = join(f.root, 'work'), snapshot = snapshotProject(f.project, work); await fixAgent({ workdir: work });
  const changes = changedFiles(snapshot, work, f.config.projects.demo); writeFileSync(join(work, 'src/value.js'), 'tampered');
  assert.throws(() => applyPatch(snapshot, work, changes, f.root), /candidate_changed/);
  await fixAgent({ workdir: work }); rmSync(join(f.project, 'src/value.js')); symlinkSync(join(work, 'src/value.js'), join(f.project, 'src/value.js'));
  assert.throws(() => applyPatch(snapshot, work, changes, f.root), /symlink/);
});
test('月度账单从店铺业务状态发现部分失败，不误报等待实名认证', t => {
  const batch = { month: '2026-10', updated_at: '2026-11-01T01:00:00+08:00', shops: [
    { shopdesk_shop_uuid: 'a', shop_name: 'A', state: 'retry_collection', collection_attempts: 1, last_error: { phase: 'collection', message: 'download timeout' } },
    { shopdesk_shop_uuid: 'b', state: 'awaiting_verification', last_error: { message: '实名认证' } },
  ] };
  const events = monthlyFailureEvents(batch, '/test/batch.json'); assert.equal(events.length, 1); assert.match(events[0].id, /^monthly:2026-10:a:/);
  assert.equal(events[0].task, 'local.douyin-settle-recon.monthly'); assert.equal(events[0].job_id, '2026-10:a');
});
test('脱敏覆盖JSON密钥、密码、API key和机器人地址', () => {
  const text = scrub('"password":"secret123"\napi_key=sk-abcdefghijk12345678\nCookie: PRIVATE\nAuthorization: Bearer hidden');
  for (const s of ['secret123', 'sk-abcdefghijk12345678', 'PRIVATE', 'Bearer hidden']) assert(!text.includes(s));
});
test('月度监控在退出码0时发现新增店铺失败，重复轮询不重发', async t => {
  const f = fixture(t), monthlyDir = join(f.root, 'monthly'), batchPath = join(monthlyDir, '2026-10/batch.json');
  const batch = { month: '2026-10', updated_at: new Date().toISOString(), shops: [] }; atomicJson(batchPath, batch);
  let sent = 0;
  const options = { stateDir: join(f.root, 'watch'), boardPath: f.config.inventory, monthlyDir, workerStatusPaths: [],
    captureDir: join(f.root, 'empty'), pdfLog: join(f.root, 'empty.log'), shopsPath: join(f.root, 'shops.json'),
    collect: async () => ({ jobs: [], captured_at: new Date().toISOString() }), probeMac: async () => ({ loaded: true, runs: 1, running: false, exit: 0 }),
    alertOptions: { configPath: f.alertConfig, sleep: async () => {}, fetchImpl: async () => { sent++; return { ok: true, json: async () => ({ code: 0 }) }; } } };
  await watchOnce(options); assert.equal(sent, 0);
  batch.shops.push({ shopdesk_shop_uuid: 'partial', state: 'failed', last_error: { phase: 'collection', message: 'timeout' } }); atomicJson(batchPath, batch);
  await watchOnce(options); await watchOnce(options); assert.equal(sent, 1);
});
test('处理器并发启动只允许一个领取队列', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options); let release, entered;
  const started = new Promise(r => { entered = r; }), wait = new Promise(r => { release = r; });
  const first = repairOnce({ ...f.options, agent: async () => { entered(); await wait; return { ...diagnosis, outcome: 'no_change' }; } });
  await started; assert.equal((await repairOnce(f.options)).busy, true); release(); await first;
});
test('原代码不能复现时不应用候选补丁', async t => {
  const f = fixture(t); enqueueIncident(f.event, f.options);
  const result = await repairOnce({ ...f.options, agent: fixAgent, validator: async () => ({ passed: true, results: [{ code: 0 }] }) });
  assert.equal(result.status, 'failed'); assert.match(readFileSync(join(f.project, 'src/value.js'), 'utf8'), /=> 1/);
});
test('发票故障自动补齐最新店铺信息，只向模型提供ID名称平台', async t => {
  const f = fixture(t), shops = join(f.root, 'shops.json');
  atomicJson(shops, [{id:'current',name:'当前店铺',platform:'抖店',token:'DO_NOT_EXPOSE'}, {id:'other',name:'其他平台',platform:'淘宝'}]);
  atomicJson(f.configPath, {...f.config, shopdeskShops:shops, tasks:[{match:'^local\\.invoice-mac-agent$',project:'demo'}]});
  enqueueIncident({...f.event,task:'local.invoice-mac-agent'},f.options);
  let context;
  const result = await repairOnce({...f.options,agent:async args=>{context=args.context;return {...diagnosis,outcome:'no_change'};}});
  assert.equal(result.status,'diagnosed');assert.deepEqual(context.current_shopdesk_shops,[{id:'current',name:'当前店铺',platform:'抖店'}]);
  assert.match(context.shopdesk_policy,/最新/);assert(!JSON.stringify(context).includes('DO_NOT_EXPOSE'));
});
