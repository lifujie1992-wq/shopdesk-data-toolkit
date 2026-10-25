import fs from 'node:fs';
import path from 'node:path';
import {LeaseConflictError} from './cloud-client.mjs';

// 跨launchd进程保存退避；冷却期只读本地文件，不访问服务器。
export function createWorkerBackoff(file, cfg, now = Date.now) {
  function load() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(value.failures) || value.failures < 1 || !Number.isFinite(value.until)) throw Error('退避状态格式无效');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return {failures: 0, until: 0}; throw error; }
  }
  return {
    remainingMs: () => Math.max(0, load().until - now()),
    defer() {
      const failures = Math.min(load().failures + 1, 31);
      const delayMs = Math.min(cfg.maxRetryBackoffMs, cfg.retryBackoffMs * 2 ** (failures - 1));
      const value = {failures, until: now() + delayMs};
      fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
      fs.writeFileSync(file + '.tmp', JSON.stringify(value) + '\n', {mode: 0o600});
      fs.renameSync(file + '.tmp', file);
      fs.chmodSync(file, 0o600);
      return delayMs;
    },
    reset: () => fs.rmSync(file, {force: true}),
  };
}

// 一轮可以连续领多批；所有已领取任务落盘后才开始处理，崩溃时整批可恢复。
export async function runWorkerRound({cfg, cloud, runner, state, backoff, log, shouldStop = () => false, now = Date.now}) {
  const remainingMs = backoff.remainingMs();
  if (remainingMs > 0) {
    log.info({event: 'worker_backoff_wait', remainingMs});
    return {reason: 'backoff', processed: 0};
  }
  const defer = reason => log.warn({event: 'worker_backoff', reason, delayMs: backoff.defer()});
  const startedAt = now();
  let processed = 0, batches = 0;
  const seen = new Set();
  try {
    const recovered = state.loadAll();
    if (recovered.length) {
      for (const job of recovered) {
        try {
          await cloud.report({job_id: job.job_id, leaseToken: job.leaseToken, state: 'retryable', message: 'Mac Agent 上次运行中断，任务重新入队'});
        } catch (error) { if (!(error instanceof LeaseConflictError)) throw error; }
        state.remove(job.job_id);
        log.warn({event: 'recovered_job_requeued', job_id: job.job_id});
      }
      defer('recovered');
      return {reason: 'recovered', processed};
    }
    runner.resetShopCache?.();
    while (!shouldStop() && processed < cfg.maxJobsPerRun && now() - startedAt < cfg.maxRunMs) {
      const count = cfg.submitMode === 'auto' ? Math.min(cfg.maxJobs, cfg.maxJobsPerRun - processed) : 1;
      const claimStartedAt = now();
      const jobs = await cloud.claim(count);
      batches++;
      log.info({event: 'jobs_claimed', requested: count, count: jobs.length, elapsedMs: now() - claimStartedAt});
      if (!jobs.length) {
        backoff.reset();
        return {reason: 'empty', processed, batches};
      }
      state.saveAll(jobs);
      if (jobs.length > count) throw Error('服务器返回任务数超出申请数量');
      let retry = false;
      for (const job of jobs) {
        if (shouldStop() || seen.has(job.job_id)) {
          await cloud.report({job_id: job.job_id, leaseToken: job.leaseToken, state: 'retryable', message: '本轮停止或重复领取，留待后续执行'});
          retry = true;
        } else {
          seen.add(job.job_id);
          const result = await runner.run(job);
          retry ||= result.status === 'stale' || result.state === 'retryable';
          processed++;
        }
        state.remove(job.job_id);
      }
      if (retry) {
        defer('retryable');
        return {reason: 'retryable', processed, batches};
      }
      if (cfg.submitMode !== 'auto') break;
    }
    backoff.reset();
    return {reason: shouldStop() ? 'stopped' : 'limit', processed, batches};
  } catch (error) {
    defer('error');
    throw error;
  }
}
