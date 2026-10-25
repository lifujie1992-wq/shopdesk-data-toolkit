import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createState} from '../state.mjs';
import {createWorkerBackoff, runWorkerRound} from '../worker-round.mjs';
import {FatalAuthError, LeaseConflictError} from '../cloud-client.mjs';
import {assertConfig, loadConfig} from '../config.mjs';

const log = {info() {}, warn() {}};
const job = n => ({job_id: `job-${n}`, leaseToken: `lease-${n}`, lease_expires_at: '2099-01-01T00:00:00Z'});
function setup(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-round-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let time = 1000;
  const cfg = {submitMode: 'auto', maxJobs: 3, maxJobsPerRun: 20,
    maxRunMs: 480_000, retryBackoffMs: 300_000, maxRetryBackoffMs: 1_800_000, ...overrides};
  const now = () => time;
  const stateFile = path.join(dir, 'state.json');
  const backoffFile = path.join(dir, 'backoff.json');
  const state = createState(stateFile);
  const backoff = createWorkerBackoff(backoffFile, cfg, now);
  const claimed = [], ran = [], reported = [];
  const queue = [];
  const cloud = {
    async claim(count) { claimed.push(count); return queue.splice(0, count); },
    async report(value) { reported.push(value); return {}; },
  };
  const runner = {async run(value) { ran.push(value.job_id); return {status: 'reported', state: 'uploaded'}; }};
  const input = {cfg, cloud, runner, state, backoff, log, now};
  return {dir, stateFile, backoffFile, state, backoff, cfg, now, cloud, runner, queue, claimed, ran, reported, input,
    advance: ms => { time += ms; }, run: () => runWorkerRound(input)};
}

test('小批连续领取，最后一批按剩余上限领取，已领整批先持久化且串行执行', async t => {
  const e = setup(t, {maxJobsPerRun: 5});
  e.queue.push(...[1, 2, 3, 4, 5, 6].map(job));
  let active = 0;
  e.runner.run = async value => {
    assert.equal(active++, 0);
    assert.ok(e.state.loadAll().some(j => j.job_id === value.job_id));
    await Promise.resolve();
    active--;
    e.ran.push(value.job_id);
    return {status: 'reported', state: 'uploaded'};
  };
  const result = await e.run();
  assert.deepEqual(e.claimed, [3, 2]);
  assert.equal(result.processed, 5);
  assert.equal(e.ran.length, 5);
  assert.equal(e.queue.length, 1);
  assert.deepEqual(e.state.loadAll(), []);
});

test('空队列每轮只发一次claim，无下载或工作台调用', async t => {
  const e = setup(t);
  assert.equal((await e.run()).reason, 'empty');
  assert.deepEqual(e.claimed, [3]);
  assert.deepEqual(e.ran, []);
});

test('达到时间预算后不再领取，但会完成已领取的这一批', async t => {
  const e = setup(t, {maxRunMs: 1000});
  e.queue.push(...[1, 2, 3, 4].map(job));
  e.runner.run = async () => { e.advance(1001); return {status: 'reported', state: 'uploaded'}; };
  assert.equal((await e.run()).processed, 3);
  assert.deepEqual(e.claimed, [3]);
  assert.deepEqual(e.state.loadAll(), []);
});

test('retryable停止续领；退避跨进程生效、逐步增加并封顶，成功后清零', async t => {
  const e = setup(t, {maxJobsPerRun: 1});
  e.queue.push(job(1));
  e.runner.run = async value => { e.queue.push(value); return {status: 'reported', state: 'retryable'}; };
  assert.equal((await e.run()).reason, 'retryable');
  assert.equal(e.backoff.remainingMs(), 300_000);
  e.input.backoff = createWorkerBackoff(e.backoffFile, e.cfg, e.now);
  assert.equal((await e.run()).reason, 'backoff');
  assert.equal(e.claimed.length, 1);
  for (const expected of [600_000, 1_200_000, 1_800_000, 1_800_000]) {
    e.advance(e.backoff.remainingMs());
    await e.run();
    assert.equal(e.backoff.remainingMs(), expected);
  }
  e.advance(e.backoff.remainingMs());
  e.runner.run = async () => ({status: 'reported', state: 'uploaded'});
  await e.run();
  assert.equal(e.backoff.remainingMs(), 0);
  assert.ok(!fs.existsSync(e.backoffFile));
});

test('单批出现retryable仍处理完其他已领取任务，不再次领取失败项', async t => {
  const e = setup(t);
  e.queue.push(...[1, 2, 3, 4].map(job));
  e.runner.run = async value => {
    e.ran.push(value.job_id);
    if (value.job_id === 'job-1') e.queue.unshift(value);
    return {status: 'reported', state: value.job_id === 'job-1' ? 'retryable' : 'uploaded'};
  };
  assert.equal((await e.run()).reason, 'retryable');
  assert.deepEqual(e.ran, ['job-1', 'job-2', 'job-3']);
  assert.deepEqual(e.claimed, [3]);
});

test('进程中断保留整批未完成租约，下轮恢复含过期租约且不重新提交', async t => {
  const e = setup(t);
  e.queue.push(...[1, 2, 3].map(job));
  e.runner.run = async value => {
    if (value.job_id === 'job-2') throw new FatalAuthError('测试鉴权错误');
    return {status: 'reported', state: 'uploaded'};
  };
  await assert.rejects(() => e.run(), FatalAuthError);
  assert.deepEqual(e.state.loadAll().map(j => j.job_id), ['job-2', 'job-3']);
  assert.equal(fs.statSync(e.stateFile).mode & 0o777, 0o600);
  e.advance(e.backoff.remainingMs());
  e.cloud.report = async value => {
    e.reported.push(value);
    if (value.job_id === 'job-2') throw new LeaseConflictError('过期');
    return {};
  };
  assert.equal((await e.run()).reason, 'recovered');
  assert.deepEqual(e.reported.map(j => j.job_id), ['job-2', 'job-3']);
  assert.deepEqual(e.state.loadAll(), []);
  assert.equal(e.claimed.length, 1);
});

test('兼容旧单任务恢复文件，回报失败时保留状态', async t => {
  const e = setup(t);
  fs.writeFileSync(e.stateFile, JSON.stringify(job(9)));
  e.cloud.report = async () => { throw Error('网络故障'); };
  await assert.rejects(() => e.run(), /网络故障/);
  assert.equal(e.state.loadAll()[0].job_id, 'job-9');
  assert.deepEqual(e.claimed, []);
});

test('停止信号不再提交排队任务，并释放同批剩余租约', async t => {
  const e = setup(t);
  e.queue.push(...[1, 2, 3].map(job));
  let stop = false;
  e.input.shouldStop = () => stop;
  e.runner.run = async () => { stop = true; return {status: 'reported', state: 'uploaded'}; };
  assert.equal((await e.run()).processed, 1);
  assert.deepEqual(e.reported.map(j => j.job_id), ['job-2', 'job-3']);
  assert.deepEqual(e.state.loadAll(), []);
});

test('非auto模式强制单任务，claim异常后也进入跨进程退避', async t => {
  const e = setup(t, {submitMode: 'upload-only'});
  e.queue.push(job(1), job(2));
  assert.equal((await e.run()).processed, 1);
  assert.deepEqual(e.claimed, [1]);
  e.cloud.claim = async () => { throw Error('服务器故障'); };
  await assert.rejects(() => e.run(), /服务器故障/);
  assert.equal(e.backoff.remainingMs(), 300_000);
});

test('配置拒绝无上限续领和无效退避参数', () => {
  const cfg = loadConfig({});
  assert.throws(() => assertConfig({...cfg, maxJobsPerRun: 0}));
  assert.throws(() => assertConfig({...cfg, maxJobs: 21}));
  assert.throws(() => assertConfig({...cfg, maxRunMs: 0}));
  assert.throws(() => assertConfig({...cfg, maxRetryBackoffMs: cfg.retryBackoffMs - 1}));
});
