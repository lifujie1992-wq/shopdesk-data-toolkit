#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CaptureError, yesterday, validateDate, safeError } from './lib/common.mjs';
import { SHOPDESK_DIR, listShops, fetchShop } from './lib/source.mjs';
import { openStore, saveShop, atomicFile, exportDate } from './lib/store.mjs';
import { publishWarehouse } from './lib/warehouse.mjs';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TASK = 'com.xdr.feige-customer-daily';
const HELP = `飞鸽客服表现每日采集（只读，默认全部已配置抖店、上海时区昨天）
用法：node collect.mjs [--date YYYY-MM-DD] [--shop-id ID] [--output-dir PATH] [--no-notify] [--local-only]
      node collect.mjs --list-shops
      node collect.mjs --help
每天10:30由launchd执行；输出SQLite及CSV后自动同步阿里云数仓。
仅补传已有数据：node upload.mjs；仅本地采集：添加--local-only。
手动补跑示例：node collect.mjs --date 2026-10-16
失败不会覆盖该店此前成功的数据；部分失败退出码为1，并发送飞书通知。`;
export function parseArgs(args) {
  const result = {date: yesterday(), outputDir: path.join(ROOT, 'data'), notify: true, publish: true};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--list-shops') result.list = true;
    else if (arg === '--no-notify') result.notify = false;
    else if (arg === '--local-only') result.publish = false;
    else if (['--date', '--shop-id', '--output-dir'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new CaptureError('missing_argument', '选项缺少参数。');
      if (arg === '--date') result.date = value;
      if (arg === '--shop-id') result.shopId = value;
      if (arg === '--output-dir') result.outputDir = path.resolve(value);
    } else throw new CaptureError('unknown_argument', '存在未知选项，请查看--help。');
  }
  validateDate(result.date);
  return result;
}
export function acquireLock(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const file = path.join(dir, 'capture.lock');
  const owner = JSON.stringify({pid: process.pid, started_at: new Date().toISOString(), nonce: randomUUID()});
  try { fs.writeFileSync(file, owner, {flag: 'wx', mode: 0o600}); }
  catch (error) {
    if (error.code === 'EEXIST') throw new CaptureError('already_running', '已有采集进程或遗留锁，未重复启动；请检查capture.lock对应PID。');
    throw error;
  }
  return () => { try { if (fs.readFileSync(file, 'utf8') === owner) fs.unlinkSync(file); } catch {} };
}
export async function alertFailure(event) {
  const module = pathToFileURL(path.join(os.homedir(), 'xdr-sync-agent/src/failure-alerts.js')).href;
  const {notifyTaskFailure, nativeRunId} = await import(module);
  return notifyTaskFailure({...event, id: nativeRunId(TASK) || event.id, task: TASK});
}
export async function run(options, {shops = listShops(), collectShop = fetchShop, alert = alertFailure, publish = publishWarehouse,
  logFile = path.join(ROOT, 'logs/run.jsonl'), log = value => console.log(JSON.stringify(value))} = {}) {
  const selected = options.shopId ? shops.filter(s => s.id === options.shopId) : shops;
  if (!selected.length) throw new CaptureError('shop_not_found', '没有匹配的已配置抖店。');
  const release = acquireLock(options.outputDir);
  process.once('exit', release);
  let db;
  try {
    db = openStore(options.outputDir);
    const runId = randomUUID(), startedAt = new Date().toISOString();
    const results = [];
    fs.mkdirSync(path.dirname(logFile), {recursive: true, mode: 0o700});
    const emit = value => { const record = {at: new Date().toISOString(), run_id: runId, ...value}; fs.appendFileSync(logFile, JSON.stringify(record) + '\n', {mode: 0o600}); log(record); };
    db.prepare('INSERT INTO runs(run_id,stat_date,started_at,status,total_shops) VALUES(?,?,?,?,?)')
      .run(runId, options.date, startedAt, 'running', selected.length);
    emit({event: 'start', date: options.date, shops: selected.length});
    for (const shop of selected) {
      let result;
      try {
        const snapshot = await collectShop(shop, options.date, {dir: SHOPDESK_DIR});
        saveShop(db, snapshot, runId);
        result = {shop_id: shop.id, shop_name: shop.name, status: 'success', rows: snapshot.rows.length};
      } catch (error) {
        result = {shop_id: shop.id, shop_name: shop.name, status: 'failed', rows: null, ...safeError(error)};
      }
      results.push(result);
      db.prepare('INSERT INTO shop_runs VALUES(?,?,?,?,?,?,?)').run(runId, shop.id, shop.name, result.status,
        result.rows, result.code || null, result.message || null);
      emit({event: 'shop_result', completed: results.length, total: selected.length, ...result});
    }
    const fields = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog/fields.json'), 'utf8')).fields;
    const exported = exportDate(db, options.date, options.outputDir, fields, new Set(shops.map(s => s.id)));
    const failed = results.filter(r => r.status === 'failed');
    const count = results.filter(r => r.status === 'success').reduce((sum, r) => sum + r.rows, 0);
    let status = failed.length ? 'partial_failed' : 'success';
    const completedAt = new Date().toISOString();
    const report = {run_id: runId, stat_date: options.date, started_at: startedAt, completed_at: completedAt,
      status, total_shops: selected.length, success_shops: selected.length - failed.length,
      failed_shops: failed.length, staff_rows_this_run: count, export: exported, results};
    db.prepare('UPDATE runs SET completed_at=?,status=?,success_shops=?,failed_shops=?,staff_rows=? WHERE run_id=?')
      .run(completedAt, status, report.success_shops, report.failed_shops, count, runId);
    atomicFile(path.join(exported.folder, 'run-status.json'), JSON.stringify(report, null, 2) + '\n');
    let cloudFailure;
    if (options.publish) {
      emit({event: 'cloud_sync_start'});
      try {
        report.cloud = await publish({source: path.join(options.outputDir, 'feige-customer.sqlite'), stateDir: options.outputDir});
        emit({event: 'cloud_sync_done', path: report.cloud.path, sha256: report.cloud.sha256});
      } catch (error) {
        cloudFailure = safeError(error);
        report.cloud = {status: 'failed', ...cloudFailure};
        status = failed.length ? 'partial_failed' : 'sync_failed'; report.status = status;
        db.prepare('UPDATE runs SET status=? WHERE run_id=?').run(status, runId);
        emit({event: 'cloud_sync_failed', ...cloudFailure});
      }
      report.completed_at = new Date().toISOString();
      db.prepare('UPDATE runs SET completed_at=? WHERE run_id=?').run(report.completed_at, runId);
      atomicFile(path.join(exported.folder, 'run-status.json'), JSON.stringify(report, null, 2) + '\n');
    }
    if ((failed.length || cloudFailure) && options.notify) {
      try {
        const reasons = failed.length ? [`${failed.length}/${selected.length}家店失败：`, ...failed.map(s => `${s.shop_name}：${s.message}`)] : [];
        if (cloudFailure) reasons.push('同步阿里云数仓失败：' + cloudFailure.message);
        report.notification = await alert({id: 'feige-run:' + runId, phase: cloudFailure ? '阿里云数仓同步' : '飞鸽客服表现采集', business_date: options.date,
          failed_at: report.completed_at, log: logFile, reason: reasons.join('\n')});
      } catch { report.notification = {pending: true}; }
      atomicFile(path.join(exported.folder, 'run-status.json'), JSON.stringify(report, null, 2) + '\n');
    }
    emit({event: 'finished', date: options.date, status, success_shops: report.success_shops, failed_shops: report.failed_shops,
      staff_rows: count, output: exported.folder});
    return report;
  } finally { db?.close(); process.removeListener('exit', release); release(); }
}
export async function main(args = process.argv.slice(2)) {
  process.umask(0o077);
  const options = parseArgs(args);
  if (options.help) { console.log(HELP); return; }
  if (options.list) { console.log(JSON.stringify({ok: true, data: listShops()}, null, 2)); return; }
  const interrupt = () => process.exit(130), terminate = () => process.exit(143);
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    const result = await run(options);
    if (result.failed_shops || result.cloud?.status === 'failed') process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(JSON.stringify({ok: false, error: safeError(error)})); process.exitCode = 1; });
}
