import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig, assertCaptureConfig} from './config.mjs';
import {createCloudClient} from './cloud-client.mjs';
import {createLogger} from './log.mjs';
import {runCapture} from './capture-runner.mjs';
import {redactMessage} from './redact.mjs';

export function parseCaptureArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--once') continue;
    if (a === '--dry-run') options.dryRun = true;
    else if (a === '--resume') options.resume = true;
    else if (a === '--complete') options.complete = true;
    else if (a === '--shop-id' || a === '--manifest') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw Error(`${a} 缺少参数`);
      options[a === '--shop-id' ? 'shopId' : 'manifestPath'] = value;
    } else throw Error(`未知参数: ${a}`);
  }
  if (options.dryRun && options.complete) throw Error('--dry-run 不能与 --complete 同用');
  if (options.resume && options.shopId) throw Error('--resume 原样重放，不能重新筛选店铺');
  if (options.manifestPath && !options.resume) throw Error('--manifest 仅用于 --resume');
  return options;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseCaptureArgs(args);
  const cfg = assertCaptureConfig(loadConfig(), options);
  const log = createLogger(cfg.logDir);
  const cloud = options.dryRun ? null : createCloudClient(cfg, log);
  const stop = signal => { log.warn({event: 'capture_signal', signal}); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const int = () => stop('SIGINT'), term = () => stop('SIGTERM');
  process.once('SIGINT', int);
  process.once('SIGTERM', term);
  try {
    const result = await runCapture({cfg, cloud, log, ...options});
    log.info({event: 'capture_finished', status: result.status, captureRunId: result.captureRunId,
      manifestPath: result.manifestPath, consumerRowCount: result.consumerRowCount,
      platformRowCount: result.platformRowCount, consumerReceivedRows: result.consumerReceivedRows,
      platformReceivedRows: result.platformReceivedRows});
    return result;
  } finally { process.removeListener('SIGINT', int); process.removeListener('SIGTERM', term); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { process.stderr.write(`${error.name || 'Error'}: ${redactMessage(error.message)}\n`); process.exitCode = 1; });
}
