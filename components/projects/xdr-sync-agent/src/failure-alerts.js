import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { enqueueIncident, scrub } from './failure-incidents.js';

export const ALERT_CONFIG = join(homedir(), 'Library/Application Support/shopdesk/alert-webhook.json');
export const ALERT_STATE = join(homedir(), 'Library/Application Support/xdr-sync-agent/failure-alerts');
export const TASK_NAMES = {
  sync_orders: '聚水潭订单明细', finalize_sales: '昨日销售定稿', sync_sales: '销售业绩',
  sync_profit_analysis: '商品利润分析', sync_purple_orders: '紫旗刷单', sync_shop_products: '店铺商品',
  sync_profit_facts: '利润事实回算', sync_hourly: '库存与销售刷新', sync_inventory: '库存刷新',
  sync_paid_orders: '今日已付订单', sync_unshipped_orders: '待发货订单', sync_spu_live: 'SPU/SKU快照',
  sync_doudian: '抖店指标', sync_doudian_client: '客户店铺指标',
  'com.xdr.refund-daily': '退款导出', 'com.xdr.jst-purple-orders-sync': '本机紫旗刷单',
  'com.xdr.jst-aftersales-sync': '售后明细同步', 'com.xdr.jst-auth-refresh': '聚水潭登录态刷新',
  'local.invoice-capture-sync': '发票采集', 'local.invoice-mac-agent': '发票PDF回传',
  'com.xdr.failure-watch': '任务失败监控',
  'local.shopdesk.aftersale-counts': '抖店待审核售后数量',
  'local.douyin-settle-recon.monthly': '抖音月度账单采集与核对',
  'com.xdr.failure-repair': 'Codex故障自动处理',
};

let bootSession;
export function macFailureId(task, record) {
  if (!bootSession) {
    try { bootSession = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { bootSession = 'unknown-boot'; }
  }
  return `mac-run:${bootSession}:${task}:${record.coalition || 'unknown'}:${record.runs}`;
}
export function nativeRunId(task) {
  if (process.env.XPC_SERVICE_NAME !== task) return null;
  try {
    const raw = execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${task}`], { encoding: 'utf8', timeout: 3000 });
    return macFailureId(task, { runs: Number(/^\s*runs = (\d+)/m.exec(raw)?.[1] || 0),
      coalition: /resource coalition =\s*\{\s*ID = (\d+)/m.exec(raw)?.[1] });
  } catch { return null; }
}

export function redact(value, secrets = []) {
  return scrub(value, secrets).slice(0, 4500);
}
export function signedPayload(text, secret, now = Date.now()) {
  const timestamp = String(Math.floor(now / 1000));
  return { msg_type: 'text', content: { text }, timestamp,
    sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') };
}
export function failureText(event) {
  if (event.resolution) return event.summary;
  const stamp = new Date(event.failed_at || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const hint = /not_logged_in|session_expired/.test(event.reason || '') ? '处理建议：检查Chrome聚水潭登录，并执行登录态刷新任务。'
    : /order_page_required/.test(event.reason || '') ? '处理建议：检查聚水潭「常用 → 订单」页面是否可用。' : '';
  return [event.test ? '【任务执行失败通知·连接测试】' : '【任务执行失败】',
    `任务：${TASK_NAMES[event.task] ? `${TASK_NAMES[event.task]}（${event.task}）` : event.task}`,
    `${event.failed_at ? '失败时间' : '检测时间'}：${stamp}（北京时间）`, `执行位置：${event.host || hostname()}`,
    event.phase ? `阶段：${event.phase}` : '',
    event.job_id ? `执行编号：${event.job_id}` : '',
    event.business_date ? `业务日期：${event.business_date}` : '',
    `原因：${event.reason || '退出码非零，请查看任务日志'}`,
    hint,
    event.log ? `日志：${event.log}` : '',
  ].filter(Boolean).join('\n');
}
function eventPath(event, stateDir) {
  const key = createHash('sha256').update(event.id).digest('hex');
  return join(stateDir, 'outbox', key + '.json');
}
function atomicJson(path, data) {
  const tmp = path + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
function configFrom(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  if (!/^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[a-f0-9-]+$/i.test(config.url || '') || !config.secret) {
    throw new Error('invalid_alert_config');
  }
  return config;
}
export function queueFailure(event, { stateDir = ALERT_STATE, configPath = ALERT_CONFIG, autoRepair = !process.env.XDR_FAILURE_REPAIR_DISABLED && stateDir === ALERT_STATE, repairOptions = {} } = {}) {
  if (!event.id || !event.task) throw new Error('missing_alert_identity');
  mkdirSync(join(stateDir, 'outbox'), { recursive: true, mode: 0o700 });
  const path = eventPath(event, stateDir);
  if (existsSync(path)) return path;
  const config = configFrom(configPath);
  const text = redact(failureText(event), [config.url, config.secret]);
  let repairKey;
  if (autoRepair) {
    try { repairKey = enqueueIncident({ ...event, reason: scrub(event.reason, [config.url, config.secret]), phase: scrub(event.phase, [config.url, config.secret]) }, repairOptions); }
    catch { /* 无法入处理队列时保留原始飞书告警，不能让AI故障吞掉业务失败。 */ }
  }
  // outbox仅存脱敏后的通知，绝不持久化webhook或签名密钥。
  try { writeFileSync(path, JSON.stringify({ id: event.id, task: event.task, text, repair_key: repairKey || null, created_at: new Date().toISOString(), attempts: 0 }) + '\n', { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return path;
}
export async function deliverAlert(path, {
  configPath = ALERT_CONFIG, fetchImpl = fetch, sleep = delay, now = Date.now,
} = {}) {
  const lock = path + '.lock';
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (Date.now() - statSync(lock).st_mtimeMs < 120000) return { busy: true };
    rmSync(lock, { recursive: true, force: true });
    return { busy: true };
  }
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (record.sent_at || record.superseded_by) return { duplicate: true };
    if (record.repair_key && Date.now() - Date.parse(record.created_at) < 30 * 60 * 1000) return { queued_for_repair: true };
    const config = configFrom(configPath);
    for (let attempt = 0; attempt < 3; attempt++) {
      record.attempts++;
      try {
        const response = await fetchImpl(config.url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(signedPayload(record.text, config.secret, now())), signal: AbortSignal.timeout(8000) });
        const data = await response.json();
        const codes = [data.code, data.StatusCode].filter(value => value !== undefined);
        if (!response.ok || !codes.length || codes.some(code => Number(code) !== 0)) throw new Error('feishu_rejected');
        record.sent_at = new Date(now()).toISOString(); delete record.last_error;
        atomicJson(path, record);
        return { sent: true };
      } catch {
        record.last_error = 'delivery_failed';
        if (attempt < 2) await sleep(1000 * (attempt + 1));
      }
    }
    atomicJson(path, record);
    return { pending: true };
  } finally { rmSync(lock, { recursive: true, force: true }); }
}
export async function notifyTaskFailure(event, options = {}) {
  return deliverAlert(queueFailure(event, options), options);
}
export async function flushAlerts({ stateDir = ALERT_STATE, limit = 10, ...options } = {}) {
  const folder = join(stateDir, 'outbox');
  if (!existsSync(folder)) return [];
  const pending = readdirSync(folder).filter(name => name.endsWith('.json'))
    .map(name => join(folder, name)).filter(path => { const r = JSON.parse(readFileSync(path, 'utf8')); return !r.sent_at && !r.superseded_by && (!r.repair_key || Date.now() - Date.parse(r.created_at) >= 30 * 60 * 1000); }).slice(0, limit);
  const results = [];
  for (const path of pending) results.push(await deliverAlert(path, options));
  return results;
}
