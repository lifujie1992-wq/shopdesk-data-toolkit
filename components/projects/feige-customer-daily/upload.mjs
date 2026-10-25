#!/usr/bin/env node
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ROOT, TASK, acquireLock, alertFailure } from './collect.mjs';
import { CaptureError, safeError } from './lib/common.mjs';
import { publishWarehouse } from './lib/warehouse.mjs';

export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：node upload.mjs [--output-dir PATH] [--no-notify]\n将已有本地SQLite完整历史发布至阿里云数仓，不重新采集。'); return;
  }
  let dir = path.join(ROOT, 'data'), notify = true;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-notify') notify = false;
    else if (args[i] === '--output-dir' && args[i + 1] && !args[i + 1].startsWith('--')) dir = path.resolve(args[++i]);
    else throw new CaptureError('unknown_argument', '上传选项无效，请查看--help。');
  }
  const release = acquireLock(dir);
  process.once('exit', release);
  const interrupt = () => process.exit(130), terminate = () => process.exit(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const result = await publishWarehouse({source: path.join(dir, 'feige-customer.sqlite'), stateDir: dir});
    console.log(JSON.stringify({ok: true, data: result}));
  } catch (error) {
    if (notify) {
      try { await alertFailure({id: 'feige-upload:' + randomUUID(), task: TASK, phase: '阿里云数仓同步', reason: safeError(error).message,
        log: path.join(dir, 'cloud-status.json')}); } catch {}
    }
    throw error;
  } finally {
    process.removeListener('exit', release); release();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ok: false, error: safeError(error)})); process.exitCode = 1; });
}
