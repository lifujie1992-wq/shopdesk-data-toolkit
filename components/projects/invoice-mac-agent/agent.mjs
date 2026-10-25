import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig, assertConfig, loadShopdeskBridge} from './config.mjs';
import {createLogger} from './log.mjs';
import {createCloudClient, FatalAuthError} from './cloud-client.mjs';
import {stagePdf} from './pdf-stage.mjs';
import {createShopdeskInvoiceDriver} from './shopdesk-invoice-driver.mjs';
import {createJobRunner} from './job-runner.mjs';
import {createState} from './state.mjs';
import {createWorkerBackoff, runWorkerRound} from './worker-round.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function main({once = process.argv.includes('--once'), uploadOnly = process.argv.includes('--upload-only')} = {}) {
  const cfg = assertConfig({...loadConfig(), ...(uploadOnly ? {submitMode: 'upload-only', maxJobs: 1} : {})});
  const log = createLogger(cfg.logDir);
  const cloud = createCloudClient(cfg, log);
  const driver = createShopdeskInvoiceDriver({getBridge: loadShopdeskBridge, timeoutMs: cfg.bridgeTimeoutMs, allowSubmit: cfg.submitMode === 'auto'});
  const runner = createJobRunner({cloud, stage: stagePdf, driver, cfg, log});
  const state = createState(path.join(path.dirname(cfg.stagingDir), 'state.json'));
  const backoff = createWorkerBackoff(path.join(path.dirname(cfg.stagingDir), 'worker-backoff.json'), cfg);
  let stopping = false;
  process.once('SIGINT', () => { stopping = true; log.info({event: 'signal', signal: 'SIGINT'}); });
  process.once('SIGTERM', () => { stopping = true; log.info({event: 'signal', signal: 'SIGTERM'}); });

  log.info({event: 'agent_started', mode: cfg.submitMode, pollIntervalMs: cfg.pollIntervalMs,
    maxJobs: cfg.maxJobs, maxJobsPerRun: cfg.maxJobsPerRun, once});
  while (!stopping) {
    let result;
    try {
      result = await runWorkerRound({cfg, cloud, runner, state, backoff, log, shouldStop: () => stopping});
      log.info({event: 'worker_round_finished', ...result});
    } catch (error) {
      if (error instanceof FatalAuthError) {
        log.error({event: 'fatal_auth', error: error.message});
        throw error;
      }
      log.error({event: 'worker_round_failed', error: error.message});
      if (once) throw error;
      await sleep(cfg.pollIntervalMs);
      continue;
    }

    if (once) break;
    if (result.processed > 0 && cfg.submitMode !== 'auto') {
      log.warn({event: 'development_mode_stopped', mode: cfg.submitMode, reason: '避免重复领取同一任务'});
      break;
    }
    if (!stopping) await sleep(cfg.pollIntervalMs);
  }
  log.info({event: 'agent_stopped'});
}

const launchedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (launchedDirectly) {
  main().catch(error => {
    process.stderr.write(`${error.name || 'Error'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
