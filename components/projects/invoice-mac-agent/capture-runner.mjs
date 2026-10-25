import fs from 'node:fs';
import path from 'node:path';
import {createCaptureSource} from './capture-source.mjs';
import {packCapture, loadManifest, shanghaiDate} from './capture-pack.mjs';
import {uploadCapture} from './capture-upload.mjs';
import {acquireCaptureLock} from './capture-lock.mjs';

export {acquireCaptureLock};
export async function runCapture({cfg, cloud, log = console, dryRun = false, resume = false, complete = false, shopId, manifestPath, source}) {
  if (!cfg.captureEnabled && !dryRun) {
    log.info?.({event: 'capture_disabled'});
    return {status: 'disabled'};
  }
  const release = acquireCaptureLock(cfg.captureStateDir);
  if (!release) { log.warn?.({event: 'capture_locked'}); return {status: 'locked'}; }
  const onExit = () => release();
  process.once('exit', onExit);
  try {
    let file = manifestPath || path.join(cfg.captureStateDir, `${shanghaiDate()}-manifest.json`);
    if (!resume) {
      if (fs.existsSync(file)) {
        const prior = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (prior.status !== 'processed') throw Error(`已有未完成批次，请使用 --resume（或 --manifest 指定历史清单）: ${file}`);
      }
      const collected = await (source || createCaptureSource({cfg, log})).collect({shopId});
      const packed = packCapture({...collected, stateDir: cfg.captureStateDir, sourceMachine: cfg.captureSourceMachine});
      file = packed.manifestPath;
      log.info?.({event: 'capture_prepared', captureRunId: packed.manifest.captureRunId, manifestPath: file,
        consumerRowCount: packed.manifest.consumerRowCount, platformRowCount: packed.manifest.platformRowCount,
        successUnits: collected.shopResults.filter(r => r.status === 'success').length,
        failedUnits: collected.shopResults.filter(r => r.status === 'failed').length});
    }
    if (dryRun) {
      const manifest = loadManifest(file);
      return {status: manifest.status, manifestPath: file, captureRunId: manifest.captureRunId,
        consumerRowCount: manifest.consumerRowCount, platformRowCount: manifest.platformRowCount};
    }
    return await uploadCapture({cloud, manifestPath: file, complete, log});
  } finally { process.removeListener('exit', onExit); release(); }
}
