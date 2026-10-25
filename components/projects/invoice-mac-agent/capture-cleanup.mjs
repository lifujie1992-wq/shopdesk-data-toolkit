import fs from 'node:fs';
import path from 'node:path';
import {shanghaiDate} from './capture-pack.mjs';
import {acquireCaptureLock} from './capture-lock.mjs';
import {assertCaptureCleanupConfig} from './config.mjs';

function validDate(value) {
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

// 仅识别本项目生成的快照、清单、历史归档及.part文件，不按mtime延长保留期。
export function captureFileDate(name) {
  const batch = /^mac-(\d{4})(\d{2})(\d{2})-\d{6}-[a-f0-9]{8}-[a-f0-9]{8}(?:-manifest\.json|\.jsonl(?:\.gz)?)(?:\.part)?$/.exec(name);
  const dated = /^(\d{4}-\d{2}-\d{2})-(?:manifest(?:\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+-manifest)\.json(?:\.part)?$/.exec(name);
  const date = batch ? `${batch[1]}-${batch[2]}-${batch[3]}` : dated?.[1];
  return date && validDate(date) ? date : null;
}

export function captureCutoffDate(now, retentionDays) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw Error('保留天数必须为1-3650的整数');
  const today = shanghaiDate(now);
  return new Date(Date.parse(`${today}T00:00:00Z`) - (retentionDays - 1) * 86400_000).toISOString().slice(0, 10);
}

export function runCaptureCleanup({cfg, dryRun = false, now = new Date(), log = console}) {
  assertCaptureCleanupConfig(cfg);
  const dir = path.resolve(cfg.captureStateDir);
  const cutoffDate = captureCutoffDate(now, cfg.captureRetentionDays);
  const summary = {status: dryRun ? 'dry-run' : 'cleaned', retentionDays: cfg.captureRetentionDays,
    cutoffDate, scannedCount: 0, candidateCount: 0, deletedCount: 0, candidateBytes: 0, deletedBytes: 0,
    skippedCount: 0, errorCount: 0, candidates: []};
  let directory;
  try { directory = fs.lstatSync(dir); }
  catch (error) { if (error.code === 'ENOENT') return {...summary, status: 'missing'}; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('采集清理目录必须是实际目录，不能是符号链接');
  const release = acquireCaptureLock(dir);
  if (!release) return {...summary, status: 'locked'};
  const onExit = () => release();
  process.once('exit', onExit);
  try {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'capture.lock') continue;
      summary.scannedCount++;
      const statDate = captureFileDate(entry.name);
      if (!entry.isFile() || !statDate) { summary.skippedCount++; continue; }
      if (statDate >= cutoffDate) continue;
      const file = path.join(dir, entry.name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) { summary.skippedCount++; continue; }
        summary.candidateCount++;
        summary.candidateBytes += stat.size;
        summary.candidates.push({file: entry.name, statDate, bytes: stat.size});
        if (dryRun) continue;
        // 不读取清单内的路径，不跟随软链接，也不递归删除目录。
        fs.unlinkSync(file);
        summary.deletedCount++;
        summary.deletedBytes += stat.size;
        log.info?.({event: 'capture_cleanup_deleted', file: entry.name, statDate, bytes: stat.size});
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        summary.errorCount++;
        log.error?.({event: 'capture_cleanup_error', file: entry.name, error: error.message});
      }
    }
    if (summary.errorCount) summary.status = 'partial';
    return summary;
  } finally {
    process.removeListener('exit', onExit);
    release();
  }
}
