import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { flatten, coreMetrics, formatDuration } from './common.mjs';

export function openStore(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, 'feige-customer.sqlite');
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,stat_date TEXT NOT NULL,started_at TEXT NOT NULL,
      completed_at TEXT,status TEXT NOT NULL,total_shops INTEGER,success_shops INTEGER,failed_shops INTEGER,staff_rows INTEGER);
    CREATE TABLE IF NOT EXISTS shop_runs(run_id TEXT NOT NULL,shop_id TEXT NOT NULL,shop_name TEXT NOT NULL,
      status TEXT NOT NULL,row_count INTEGER,error_code TEXT,error_message TEXT,PRIMARY KEY(run_id,shop_id));
    CREATE TABLE IF NOT EXISTS staff_daily(stat_date TEXT NOT NULL,shop_id TEXT NOT NULL,shop_name TEXT NOT NULL,
      staff_id TEXT NOT NULL,staff_name TEXT,staff_account TEXT,rank INTEGER,reception_sessions INTEGER,
      received_users INTEGER,valid_reviews INTEGER,metrics_json TEXT NOT NULL,raw_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(stat_date,shop_id,staff_id));
    CREATE TABLE IF NOT EXISTS shop_daily(stat_date TEXT NOT NULL,shop_id TEXT NOT NULL,shop_name TEXT NOT NULL,
      row_kind TEXT NOT NULL,metrics_json TEXT NOT NULL,raw_json TEXT NOT NULL,fetched_at TEXT NOT NULL,
      run_id TEXT NOT NULL,PRIMARY KEY(stat_date,shop_id,row_kind));
    CREATE TABLE IF NOT EXISTS shop_snapshots(stat_date TEXT NOT NULL,shop_id TEXT NOT NULL,shop_name TEXT NOT NULL,
      total_staff INTEGER NOT NULL,core_json TEXT NOT NULL,fetched_at TEXT NOT NULL,run_id TEXT NOT NULL,
      PRIMARY KEY(stat_date,shop_id));`);
  return db;
}
export function saveShop(db, snapshot, runId) {
  const {shop, date, rows, fetchedAt} = snapshot;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM staff_daily WHERE stat_date=? AND shop_id=?').run(date, shop.id);
    const insert = db.prepare('INSERT INTO staff_daily VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (const row of rows) {
      const user = row.staffUserInfo;
      const metric = flatten(row);
      metric.staffAccountStatus = user.staffAccountStatus ?? null;
      const count = key => Number.isSafeInteger(metric[key]) ? metric[key] : null;
      insert.run(date, shop.id, shop.name, user.staffId, row.staffName || user.staffNickName || '', user.staffAccountName || '',
        Number.isSafeInteger(row.rank) ? row.rank : null, count('servConvCnt'), count('servUserCnt'), count('validCommentCnt'),
        JSON.stringify(metric), JSON.stringify(row), fetchedAt, runId);
    }
    const summary = db.prepare('INSERT OR REPLACE INTO shop_daily VALUES(?,?,?,?,?,?,?,?)');
    for (const [kind, raw] of [['sum', snapshot.sum], ['average', snapshot.average]]) {
      summary.run(date, shop.id, shop.name, kind, JSON.stringify(flatten(raw)), JSON.stringify(raw), fetchedAt, runId);
    }
    db.prepare('INSERT OR REPLACE INTO shop_snapshots VALUES(?,?,?,?,?,?,?)')
      .run(date, shop.id, shop.name, snapshot.total, JSON.stringify(snapshot.core), fetchedAt, runId);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function atomicFile(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, content, {mode: 0o600}); fs.renameSync(tmp, file);
}
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  if (/^[=+@\-]/.test(text) && text !== '-' && !/^[+-]?\d+(?:\.\d+)?%?$/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function exportDate(db, date, dir, fields, activeIds = null) {
  const folder = path.join(dir, date);
  const active = rows => activeIds ? rows.filter(row => activeIds.has(row.shop_id)) : rows;
  const staff = active(db.prepare('SELECT * FROM staff_daily WHERE stat_date=? ORDER BY shop_name,rank,staff_id').all(date));
  const summaries = active(db.prepare('SELECT * FROM shop_daily WHERE stat_date=? ORDER BY shop_name,row_kind').all(date));
  const snapshots = active(db.prepare('SELECT * FROM shop_snapshots WHERE stat_date=? ORDER BY shop_name').all(date));
  const metricKeys = new Set(fields.map(field => field.key));
  for (const row of [...staff, ...summaries]) for (const key of Object.keys(JSON.parse(row.metrics_json))) metricKeys.add(key);
  metricKeys.delete('staffName'); metricKeys.delete('rank');
  const keys = [...metricKeys];
  const labels = {staffAccountStatus: '账号在线状态码（原始）', ...Object.fromEntries(fields.map(f => [f.key, f.label]))};
  const label = key => key.endsWith('__isAlert') ? (labels[key.slice(0, -9)] || key.slice(0, -9)) + '（预警）' : labels[key] || key;
  const writeCsv = (name, headers, rows) => atomicFile(path.join(folder, name), '\ufeff' +
    [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n');
  const common = row => [date, row.shop_name, row.shop_id, row.fetched_at];
  writeCsv('customer-performance.csv', ['统计日期', '店铺名称', '店铺ID', '采集时间', '客服ID（文本）', '客服昵称', '客服账号', '排名', ...keys.map(label)],
    staff.map(row => { const m = JSON.parse(row.metrics_json); return [...common(row), "'" + row.staff_id, row.staff_name, row.staff_account, row.rank, ...keys.map(k => m[k])]; }));
  writeCsv('shop-summary.csv', ['统计日期', '店铺名称', '店铺ID', '采集时间', '类型', ...keys.map(label)],
    summaries.map(row => { const m = JSON.parse(row.metrics_json); return [...common(row), row.row_kind === 'sum' ? '店铺汇总值' : '店铺平均值', ...keys.map(k => m[k])]; }));
  writeCsv('top-indicators.csv', ['统计日期', '店铺名称', '店铺ID', '采集时间', '客服账号总数', '登录客服数', '在线客服数', '接待客服数', '达标客服数', '平均在线时长（秒）', '平均小休时长（秒）', '平均在线时长', '平均小休时长'],
    snapshots.map(row => { const core = coreMetrics(JSON.parse(row.core_json)); return [...common(row), row.total_staff,
      core.loginStaffCnt, core.onlineStaffCnt, core.servStaffCnt, core.targetHitCnt, core.avgOnlineDuration, core.avgNapDuration,
      formatDuration(core.avgOnlineDuration), formatDuration(core.avgNapDuration)]; }));
  return {folder, staffRows: staff.length, shops: snapshots.length};
}
