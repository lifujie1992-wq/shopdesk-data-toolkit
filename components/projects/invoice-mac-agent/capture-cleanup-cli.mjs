import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig, assertCaptureCleanupConfig} from './config.mjs';
import {createLogger} from './log.mjs';
import {runCaptureCleanup} from './capture-cleanup.mjs';
import {redactMessage} from './redact.mjs';

export function parseCleanupArgs(args) {
  const options = {dryRun: false};
  for (const arg of args) {
    if (arg === '--once') continue;
    if (arg === '--dry-run') options.dryRun = true;
    else throw Error(`未知清理参数: ${arg}`);
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  const options = parseCleanupArgs(args);
  const cfg = assertCaptureCleanupConfig(loadConfig());
  const log = createLogger(cfg.logDir);
  const stop = signal => { log.warn({event: 'capture_cleanup_signal', signal}); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const int = () => stop('SIGINT'), term = () => stop('SIGTERM');
  process.once('SIGINT', int);
  process.once('SIGTERM', term);
  try {
    const result = runCaptureCleanup({cfg, ...options, log});
    log.info({event: 'capture_cleanup_finished', ...result});
    if (result.errorCount) process.exitCode = 1;
    return result;
  } finally {
    process.removeListener('SIGINT', int);
    process.removeListener('SIGTERM', term);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.name || 'Error'}: ${redactMessage(error.message)}\n`); process.exitCode = 1; }
}
