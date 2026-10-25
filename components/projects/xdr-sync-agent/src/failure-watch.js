import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, closeSync, readSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ALERT_STATE, queueFailure, flushAlerts, macFailureId } from './failure-alerts.js';
import { loadConfig } from './config.js';
import { createHash } from 'node:crypto';

const BOARD = join(homedir(), 'projects/about/data/inventory.json');
const PDF_LOG = join(homedir(), '.local/share/invoice-mac-agent/logs/launchd.out.log');
const MONTHLY_ROOT = join(homedir(), 'projects/douyin-settle-recon');
export const MONTHLY_TASK = { id: 'local.douyin-settle-recon.monthly', host: 'mac', installed: true,
  workdir: MONTHLY_ROOT, log: join(MONTHLY_ROOT, 'data/monthly/logs/launchd.out.log'),
  errlog: join(MONTHLY_ROOT, 'data/monthly/logs/launchd.err.log') };

export function monthlyFailureEvents(batch, manifestPath) {
  return (batch.shops || []).filter(s => ['failed', 'retry_collection', 'retry_upload', 'verify_cloud'].includes(s.state) && s.last_error).map(s => {
    const reason = `${s.shop_name || s.shopdesk_shop_uuid}：${s.last_error.message || s.last_error.code || JSON.stringify(s.last_error)}`;
    const signature = createHash('sha256').update(JSON.stringify([s.state, s.collection_attempts, s.last_error])).digest('hex').slice(0, 20);
    return { id: `monthly:${batch.month}:${s.shopdesk_shop_uuid}:${signature}`, task: MONTHLY_TASK.id,
      job_id: `${batch.month}:${s.shopdesk_shop_uuid}`, business_date: batch.month, failed_at: batch.updated_at,
      phase: s.last_error.phase || s.state, reason, log: manifestPath };
  });
}
function collectMonthly(state, folder) {
  const events = [], current = {};
  if (existsSync(folder)) for (const name of readdirSync(folder).filter(n => /^\d{4}-\d{2}$/.test(n))) {
    const path = join(folder, name, 'batch.json');
    if (!existsSync(path)) continue;
    try {
      for (const event of monthlyFailureEvents(JSON.parse(readFileSync(path, 'utf8')), path)) {
        current[event.id] = true;
        if (state.monthly && !state.monthly[event.id]) events.push(event);
      }
    } catch {
      const id = `monthly-unreadable:${name}:${statSync(path).mtimeMs}`;
      current[id] = true;
      if (state.monthly && !state.monthly[id]) events.push({ id, task: MONTHLY_TASK.id, reason: '月度账单状态文件无法读取，需要检查文件完整性', log: path });
    }
  }
  state.monthly = current;
  return events;
}

function command(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { encoding: 'utf8', timeout: 25000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(new Error('status_collection_failed')) : resolve(stdout));
    if (input) child.stdin.end(input);
  });
}
export function cloudEvents(snapshot, activatedAt) {
  const result = [];
  for (const job of snapshot.jobs || []) {
    if (job.state !== 'failed' || Date.parse(job.completed_at) < Date.parse(activatedAt)) continue;
    result.push({ id: `cloud-job:${job.id}`, task: job.task, job_id: job.id, failed_at: job.completed_at,
      host: 'Mac采集 → 云端队列', phase: job.phase, reason: job.error || '作业失败' });
  }
  for (const unit of snapshot.units || []) {
    if ((unit.Result === 'success' && Number(unit.ExecMainStatus || 0) === 0) || !unit.ExecMainExitTimestamp) continue;
    // systemd在这台中国区服务器输出CST；JS默认会把CST解释为美国中部时区。
    const stamp = Date.parse(unit.ExecMainExitTimestamp.replace(/\bCST$/, 'GMT+0800'));
    if (!Number.isFinite(stamp) || stamp < Date.parse(activatedAt)) continue;
    result.push({ id: `cloud-unit:${unit.Id}:${unit.ExecMainExitTimestamp}:${unit.ExecMainStatus}`, task: unit.Id,
      host: '阿里云服务器', failed_at: new Date(stamp).toISOString(), reason: `${unit.Result}，退出码${unit.ExecMainStatus}` });
  }
  return result;
}
export function captureEvent(manifest, shopNames = {}) {
  const failed = (manifest.shopResults || []).filter(r => r.status === 'failed');
  if (!failed.length) return null;
  return { id: `invoice-capture:${manifest.captureRunId}`, task: 'local.invoice-capture-sync', job_id: manifest.captureRunId,
    business_date: manifest.statDate, failed_at: manifest.capturedAt, phase: '部分店铺采集失败',
    reason: `${failed.length}项失败：\n` + failed.map(r => `${shopNames[r.shopId] || r.shopId} / ${r.businessType}：${r.errorCode || ''} ${r.errorMessage || ''}`).join('\n') };
}
export function workerFailureEvent(status, activatedAt) {
  if (status.result !== 'failed' || !status.job_id || !status.completed_at || Date.parse(status.completed_at) < Date.parse(activatedAt)) return null;
  return { id: `cloud-job:${status.job_id}`, task: status.task, job_id: status.job_id,
    phase: status.phase, reason: status.error || 'Mac采集执行失败', failed_at: status.completed_at };
}
export function aftersaleFailureDetail(task, record, status) {
  if (task.id !== 'local.shopdesk.aftersale-counts' || record.exit !== 2 || !status?.retry_complete ||
      status.exit_code !== 2 || status.launchd_runs !== record.runs || !status.completed_at || !status.run_id) return null;
  const failed = status.errors || [];
  return { job_id: status.run_id, failed_at: status.completed_at, phase: '轮末补采已结束',
    reason: `共${status.shops_total}家，成功${status.shops_ok}家，最终失败${status.shops_failed}家：\n` +
      failed.map(row => `${row.shop}：${row.reason || '采集失败'}`).join('\n'),
    log: join(homedir(), 'projects/shopdesk-aftersale/logs/scrape.log') };
}
export async function collectCloud(since, units, config = loadConfig()) {
  const safeUnits = units.filter(u => /^[A-Za-z0-9._@-]+$/.test(u)).map(u => u.endsWith('.service') ? u : u + '.service');
  const script = `import sqlite3,json,subprocess,datetime\nc=sqlite3.connect('file:/var/lib/xdr-sync/state/control.sqlite?mode=ro',uri=True,timeout=5)\nc.row_factory=sqlite3.Row\ncaptured=datetime.datetime.now(datetime.timezone.utc).isoformat()\nrows=[dict(r) for r in c.execute("select id,task,state,phase,error,completed_at from jobs where state='failed' and datetime(completed_at)>=datetime(?)",(${JSON.stringify(since)},))]\nunits=${JSON.stringify(safeUnits)}\nrecords=[]\nif units:\n p=subprocess.run(['systemctl','show',*units,'-p','Id','-p','Result','-p','ExecMainStatus','-p','ExecMainExitTimestamp'],capture_output=True,text=True,timeout=12)\n for block in p.stdout.split('\\n\\n'):\n  d=dict(line.split('=',1) for line in block.splitlines() if '=' in line)\n  if d:records.append(d)\nprint(json.dumps({'jobs':rows,'units':records,'captured_at':captured}))\n`;
  return JSON.parse(await command('/usr/bin/ssh', ['-i', config.server.identity_file, '-p', String(config.server.port),
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `root@${config.server.host}`, 'python3', '-'], script));
}
async function macRecord(task) {
  try {
    const raw = await command('/bin/launchctl', ['print', `gui/${process.getuid()}/${task.id}`]);
    const runs = Number(/^\s*runs = (\d+)/m.exec(raw)?.[1] || 0);
    const exit = /^\s*last exit code = (-?\d+)/m.exec(raw);
    const running = /^\s*state = running\s*$/m.test(raw);
    return { loaded: true, runs, exit: exit ? Number(exit[1]) : null, running,
      coalition: /resource coalition =\s*\{\s*ID = (\d+)/m.exec(raw)?.[1] };
  } catch { return { loaded: false }; }
}
function namesFrom(value, out = {}) {
  if (Array.isArray(value)) for (const item of value) namesFrom(item, out);
  else if (value && typeof value === 'object') {
    if ((value.id || value.shopId) && (value.name || value.shopName)) out[value.id || value.shopId] = value.name || value.shopName;
    for (const child of Object.values(value)) if (child && typeof child === 'object') namesFrom(child, out);
  }
  return out;
}
function pdfEvents(state, initialize, logPath = PDF_LOG) {
  if (!existsSync(logPath)) return [];
  const size = statSync(logPath).size;
  if (initialize) { state.pdf_offset = size; state.pdf_carry = ''; return []; }
  let offset = state.pdf_offset || 0;
  if (size < offset) { offset = 0; state.pdf_carry = ''; }
  const length = Math.min(size - offset, 2 * 1024 * 1024);
  if (!length) return [];
  const buffer = Buffer.alloc(length); const fd = openSync(logPath, 'r');
  try { readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
  const lines = ((state.pdf_carry || '') + buffer.toString('utf8')).split('\n');
  state.pdf_carry = lines.pop(); state.pdf_offset = offset + length;
  const events = [];
  for (const line of lines) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.event !== 'job_decision' || !['failed', 'retryable'].includes(row.state)) continue;
    if (/dry-run|upload-only|租约剩余|租约剩余时间|上传前租约|提交前租约/i.test(row.message || '')) continue;
    events.push({ id: `invoice-pdf:${row.job_id}`, task: 'local.invoice-mac-agent', job_id: row.job_id,
      phase: row.state === 'retryable' ? 'PDF回传失败，等待重试' : 'PDF回传失败', reason: row.message, failed_at: row.ts, log: logPath });
  }
  return events;
}
export async function watchOnce({ stateDir = ALERT_STATE, collect = collectCloud, boardPath = BOARD,
  captureDir = join(homedir(), '.local/share/invoice-mac-agent/capture'), pdfLog = PDF_LOG,
  shopsPath = join(homedir(), 'Library/Application Support/shopdesk/shops.json'), alertOptions = {}, probeMac = macRecord,
  aftersaleStatusPath = join(homedir(), 'projects/shopdesk-aftersale/data/status.json'),
  monthlyDir = join(MONTHLY_ROOT, 'data/monthly'),
  workerStatusPaths = [join(loadConfig().state_dir, 'status.json'), join(homedir(), 'Library/Application Support/xdr-sync-agent-profit-facts/status.json')] } = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = join(stateDir, 'monitor.json');
  const initialize = !existsSync(path);
  const state = initialize ? { activated_at: new Date().toISOString(), mac: {}, captures: [], cloud_failures: 0 } : JSON.parse(readFileSync(path, 'utf8'));
  const inventory = JSON.parse(readFileSync(boardPath, 'utf8'));
  const tasks = [...(inventory.tasks || [])];
  if (boardPath === BOARD && !tasks.some(t => t.id === MONTHLY_TASK.id) && existsSync(join(homedir(), 'Library/LaunchAgents', MONTHLY_TASK.id + '.plist'))) tasks.push(MONTHLY_TASK);
  const baselineMac = initialize || state.mac_key_version !== 2;
  let events = [];
  // 即使Mac未能向云端报告失败，本机worker状态也能触发通知。
  for (const path of workerStatusPaths) {
    let status; try { status = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    const event = workerFailureEvent(status, state.activated_at);
    if (event) events.push({ ...event, log: path });
  }
  try {
    const snapshot = await collect(state.cloud_since || state.activated_at, tasks.filter(t => t.host === 'cloud').map(t => t.id));
    events.push(...cloudEvents(snapshot, state.activated_at));
    state.cloud_since = snapshot.captured_at; state.cloud_failures = 0; state.cloud_error = null;
  } catch {
    state.cloud_failures++;
    state.cloud_error = 'status_collection_failed';
    if (state.cloud_failures >= 3) events.push({ id: `monitor-offline:${state.activated_at}:${Math.floor(Date.now() / 3600000)}`,
      task: 'com.xdr.failure-watch', reason: '连续三轮无法读取云端任务结果，请检查Mac到服务器的连接。' });
  }
  const macTasks = tasks.filter(t => t.host === 'mac' && t.installed !== false && t.id !== 'com.xdr.failure-watch');
  const records = await Promise.all(macTasks.map(async t => [t, await probeMac(t)]));
  for (const [task, record] of records) {
    const key = JSON.stringify([record.loaded, record.coalition, record.runs, record.exit]);
    if (!baselineMac && Object.hasOwn(state.mac, task.id) && state.mac[task.id] !== key && !record.running) {
      if (!record.loaded || (record.exit !== null && record.exit !== 0)) {
        let detail;
        if (task.id === 'local.shopdesk.aftersale-counts') {
          try { detail = aftersaleFailureDetail(task, record, JSON.parse(readFileSync(aftersaleStatusPath, 'utf8'))); } catch {}
        }
        events.push({
          id: record.loaded ? macFailureId(task.id, record) : `mac-unloaded:${task.id}:${state.mac[task.id]}:${state.activated_at}`, task: task.id,
          reason: record.loaded ? `任务退出码${record.exit}` : '任务已卸载，后续排期不会执行', log: task.errlog || task.log,
          ...detail,
        });
      }
    }
    // 运行中可能仍显示上次退出码；等待本轮退出后再记录，避免漏掉本轮失败。
    if (!record.running) state.mac[task.id] = key;
  }
  state.mac_key_version = 2;
  let shopNames = {};
  try { shopNames = namesFrom(JSON.parse(readFileSync(shopsPath, 'utf8'))); } catch {}
  if (existsSync(captureDir)) for (const name of readdirSync(captureDir).filter(n => /^\d{4}-\d{2}-\d{2}-manifest\.json$/.test(n))) {
    let manifest; try { manifest = JSON.parse(readFileSync(join(captureDir, name), 'utf8')); } catch { continue; }
    if (!manifest.captureRunId || state.captures.includes(manifest.captureRunId)) continue;
    const event = captureEvent(manifest, shopNames);
    if (!initialize && event) events.push({ ...event, log: join(captureDir, name) });
    state.captures.push(manifest.captureRunId);
  }
  events.push(...pdfEvents(state, initialize, pdfLog));
  events.push(...collectMonthly(state, monthlyDir));
  for (const event of events) queueFailure(event, { stateDir, ...alertOptions });
  state.checked_at = new Date().toISOString(); state.last_detected_count = events.length;
  const temporary = path + '.tmp'; writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); renameSync(temporary, path);
  const delivery = await flushAlerts({ stateDir, ...alertOptions });
  return { initialized: initialize, detected: events.length, sent: delivery.filter(r => r.sent).length,
    pending: delivery.filter(r => r.pending).length, cloud_error: state.cloud_error };
}
