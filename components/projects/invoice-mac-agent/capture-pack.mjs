import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const TYPES = ['consumer_order', 'platform_bill'];
const rowId = row => row.businessType === 'consumer_order' ? row.orderId : row.billId;
const key = (shopId, businessType) => JSON.stringify([shopId, businessType]);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function shanghaiDate(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
  const v = Object.fromEntries(p.map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort(cmp).map(k => [k, canonical(value[k])]));
  if (typeof value === 'number' && !Number.isFinite(value)) throw Error('明细含非有限数字');
  if (value === undefined) throw Error('明细不能包含 undefined');
  return value;
}
export function captureCreateBody(m) {
  return Object.fromEntries(['captureRunId', 'statDate', 'capturedAt', 'consumerRowCount', 'platformRowCount',
    'fileSize', 'fileSha256', 'shopResults'].map(k => [k, m[k]]));
}
export function validateCapture(rows, shopResults) {
  if (!Array.isArray(shopResults) || !shopResults.length || shopResults.length > 2000) throw Error('shopResults 必须为 1~2000 条');
  if (!Array.isArray(rows) || rows.length > 1_000_000) throw Error('明细超过上限');
  const units = new Map(), counts = new Map();
  for (const r of shopResults) {
    if (typeof r.shopId !== 'string' || !r.shopId || !TYPES.includes(r.businessType)) throw Error('shopResults 业务标识非法');
    const k = key(r.shopId, r.businessType);
    if (units.has(k)) throw Error('shopResults 重复单元');
    if (r.status === 'success') {
      if (r.isComplete !== true || !Number.isSafeInteger(r.rowCount) || r.rowCount < 0 || r.rowCount > 1_000_000 || r.errorCode !== null || r.errorMessage !== null) throw Error('shopResults success 字段非法');
    } else if (r.status === 'failed') {
      if (r.isComplete !== false || r.rowCount !== null || typeof r.errorCode !== 'string' || !r.errorCode.trim() || r.errorCode.length > 64 || typeof r.errorMessage !== 'string' || !r.errorMessage.trim() || r.errorMessage.length > 1000) throw Error('shopResults failed 字段非法');
    } else throw Error('shopResults status 非法');
    units.set(k, r);
  }
  for (const row of rows) {
    if (!row || !TYPES.includes(row.businessType) || typeof row.shopId !== 'string' || !row.shopId) throw Error('明细业务标识非法');
    const id = rowId(row);
    if (typeof id !== 'string' || !id.trim()) throw Error('订单号/账单号必须是非空字符串');
    if (row.businessType === 'consumer_order' && row.subOrderNo != null && typeof row.subOrderNo !== 'string') throw Error('子订单号必须为字符串');
    const amount = row.businessType === 'consumer_order' ? row.amount : row.billAmountYuan;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw Error('金额必须为有限数字');
    // 兼容旧消费者不带两个字段、旧平台仅带 creditCode；新格式必须成对。
    if (Object.hasOwn(row, 'companyName') || (row.businessType === 'consumer_order' && Object.hasOwn(row, 'creditCode'))) {
      const complete = typeof row.companyName === 'string' && row.companyName.trim() &&
        typeof row.creditCode === 'string' && row.creditCode.trim();
      if (!complete && !(row.companyName === null && row.creditCode === null)) throw Error('公司名称和信用代码必须成对填写或同时为null');
    }
    const k = key(row.shopId, row.businessType);
    if (units.get(k)?.status !== 'success') throw Error('失败/未报告单元不能有明细');
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const [k, r] of units) if (r.status === 'success' && r.rowCount !== (counts.get(k) || 0)) throw Error('逐店行数与 shopResults 不一致');
}
export function saveManifest(file, manifest) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const partial = file + '.part';
  fs.writeFileSync(partial, JSON.stringify(manifest, null, 2) + '\n', {mode: 0o600});
  fs.chmodSync(partial, 0o600);
  fs.renameSync(partial, file);
}
export function packCapture({rows, shopResults, stateDir, capturedAt = new Date().toISOString(), sourceMachine = 'mac-invoice-agent'}) {
  validateCapture(rows, shopResults);
  const date = new Date(capturedAt);
  if (!Number.isFinite(date.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(capturedAt)) throw Error('capturedAt 必须含时区');
  const statDate = shanghaiDate(date);
  for (const row of rows) if (row.statDate != null && row.statDate !== statDate) throw Error('行 statDate 与批次不符');
  const lines = rows.map(r => {
    const line = JSON.stringify(canonical(r));
    if (Buffer.byteLength(line) > 1024 * 1024) throw Error('单行超过 1 MiB');
    return {row: r, line};
  }).sort((a, b) => cmp(a.row.businessType, b.row.businessType) || cmp(a.row.shopId, b.row.shopId) || cmp(rowId(a.row), rowId(b.row)) || cmp(a.row.subOrderNo || '', b.row.subOrderNo || '') || cmp(a.line, b.line));
  const jsonl = lines.map(x => x.line + '\n').join('');
  if (Buffer.byteLength(jsonl) > 1024 ** 3) throw Error('解压文件超过 1 GiB');
  const gzip = gzipSync(jsonl);
  if (gzip.length > 256 * 1024 ** 2) throw Error('gzip 超过 256 MiB');
  // 额外元数据哈希防止同一秒空批次/不同失败结果撞 ID；重试始终使用持久化原值。
  const metaHash = sha256(JSON.stringify({capturedAt, shopResults})).slice(0, 8);
  const time = new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'}).format(date).replaceAll(':', '');
  const captureRunId = `mac-${statDate.replaceAll('-', '')}-${time}-${sha256(jsonl).slice(0, 8)}-${metaHash}`;
  fs.mkdirSync(stateDir, {recursive: true, mode: 0o700});
  fs.chmodSync(stateDir, 0o700);
  const gzipPath = path.resolve(stateDir, `${captureRunId}.jsonl.gz`);
  fs.writeFileSync(gzipPath + '.part', gzip, {mode: 0o600});
  fs.renameSync(gzipPath + '.part', gzipPath);
  const manifest = {captureRunId, statDate, capturedAt,
    consumerRowCount: rows.filter(r => r.businessType === 'consumer_order').length,
    platformRowCount: rows.filter(r => r.businessType === 'platform_bill').length,
    fileSize: gzip.length, fileSha256: sha256(gzip), shopResults, gzipPath, sourceMachine, status: 'prepared'};
  if (Buffer.byteLength(JSON.stringify(captureCreateBody(manifest))) > 64 * 1024) throw Error('创建清单超过 64 KiB');
  const manifestPath = path.join(stateDir, `${statDate}-manifest.json`);
  saveManifest(manifestPath, manifest);
  // 保留每批不可变清单，按日期的清单是恢复入口。
  saveManifest(path.join(stateDir, `${captureRunId}-manifest.json`), manifest);
  return {manifest, manifestPath};
}
export function loadManifest(file) {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(m.captureRunId || '')) throw Error('manifest captureRunId 非法');
  const bytes = fs.readFileSync(m.gzipPath);
  if (bytes.length !== m.fileSize || sha256(bytes) !== m.fileSha256) throw Error('gzip 大小/SHA-256 与 manifest 不一致');
  const text = gunzipSync(bytes, {maxOutputLength: 1024 ** 3}).toString('utf8');
  const rows = text.split('\n').filter(x => x.trim()).map(x => JSON.parse(x));
  validateCapture(rows, m.shopResults);
  if (rows.filter(r => r.businessType === 'consumer_order').length !== m.consumerRowCount || rows.filter(r => r.businessType === 'platform_bill').length !== m.platformRowCount) throw Error('manifest 总行数不一致');
  return m;
}
