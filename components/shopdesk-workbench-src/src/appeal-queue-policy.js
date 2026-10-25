const fs = require('node:fs');
const path = require('node:path');

const TERMINAL = /不可举报|不可申诉|无需举报|举报成功|举报失败/;
const CLOSED = new Set(['gone', 'submitted', 'rejected']);
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function loadMaster(dataDir, reportsDir) {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(dataDir).sort(); } catch { return map; }
  // 全量品退的最新核查结果覆盖历史候选；不能用旧 worklist 复活已排除订单。
  for (const prefix of ['appeal-worklist-quality_returns-', 'appeal-worklist-negative_reviews-', 'reviews-all-', 'quality-all-']) {
    for (const file of files.filter(f => f.startsWith(prefix) && f.endsWith('.json'))) {
      for (const row of readJson(path.join(dataDir, file), [])) {
        if (!row.order_id) continue;
        const oid = String(row.order_id);
        map.set(oid, {...map.get(oid), ...row, kind: /quality/.test(prefix) ? 'quality' : 'review'});
      }
    }
  }
  if (reportsDir) {
    const latest = new Map();
    for (const file of fs.readdirSync(reportsDir).filter(f => /^appeal-.*\.json$/.test(f)).sort()) {
      for (const e of readJson(path.join(reportsDir, file), {}).log || []) {
        if (e.order && (!latest.has(String(e.order)) || String(e.at || '') >= String(latest.get(String(e.order)).at || ''))) latest.set(String(e.order), e);
      }
    }
    const skips = readJson(path.join(reportsDir, 'skipped.json'), {});
    const results = readJson(path.join(reportsDir, 'results.json'), {}).map || {};
    for (const oid of new Set([...map.keys(), ...latest.keys(), ...Object.keys(skips), ...Object.keys(results)])) {
      const row = {...map.get(oid)}, e = latest.get(oid), sk = skips[oid];
      if (sk && TERMINAL.test(sk.reason || '')) row.status = sk.reason;
      if (e && TERMINAL.test(e.reason || '')) row.status = e.reason;
      const result = results[oid];
      if (result && Number(result.auditStatus) === 6) row.status = '举报成功';
      if (result && Number(result.auditStatus) === 3) row.status = '举报失败';
      map.set(oid, row);
    }
  }
  return map;
}
function candidateDate(row) {
  return row.kind === 'quality'
    ? row.apply_time || row.apply_date || row.date || ''
    : row.comment_time || row.comment_date || row.date || '';
}
function dateMillis(value) {
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value); return n < 1e12 ? n * 1000 : n;
  }
  const s = String(value || '').replace(/\//g, '-');
  // 平台业务日期按北京时间，不受运行机器时区影响。
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00+08:00' : s);
}
function eligibility(row, maxAgeDays, now = Date.now()) {
  if (TERMINAL.test(String(row.status || ''))) return String(row.status);
  if (row.appealable === false || row.appealable === 0) return '不可申诉';
  const ts = dateMillis(candidateDate(row));
  if (!Number.isFinite(ts)) return '缺少有效业务日期，待补查';
  if (ts > now + 86400000) return '业务日期异常，待补查';
  if (maxAgeDays > 0 && now - ts >= maxAgeDays * 86400000) return `超过队列时间上限（${maxAgeDays}天）`;
  return '';
}
function reconcilePending(queue, master, maxAgeDays, now = Date.now()) {
  let changed = 0;
  for (const [oid, it] of Object.entries(queue.items || {})) {
    if (it.status !== 'pending') continue;
    const row = {...it, ...master.get(String(oid))};
    const date = candidateDate(row);
    if (date && it.date !== date) { it.date = date; changed++; }
    const reason = eligibility(row, maxAgeDays, now);
    if (reason) {
      it.status = 'gone'; it.goneReason = reason; it.goneAt = new Date(now).toISOString();
      delete it.execPending; changed++;
    }
  }
  return changed;
}
function priority(a, b) {
  const rank = r => r.kind === 'review' ? (/差评/.test(r.level || r.rank) && !/中差评/.test(r.level || r.rank) ? 0 : 1) : 2;
  return rank(a) - rank(b) || dateMillis(candidateDate(b)) - dateMillis(candidateDate(a)) || String(a.order_id).localeCompare(String(b.order_id));
}
function selectBatch(candidates, queue, master, {maxAgeDays, maxNew = 50, maxPerShop = 0}, now = Date.now()) {
  const confirmed = [], fresh = [], seen = new Set(), counts = new Map();
  for (const c of candidates.map(c => ({...c, ...master.get(String(c.order_id))})).sort(priority)) {
    const oid = String(c.order_id), old = queue.items[oid];
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (old && CLOSED.has(old.status)) continue;
    if (eligibility(c, maxAgeDays, now)) continue;
    if (old && old.status === 'confirmed') { confirmed.push(c); continue; }
    // 已有待核对稿不重复补写，也不挤占新单额度。
    if (old && old.status === 'pending') continue;
    if (fresh.length >= maxNew) continue;
    const count = counts.get(c.shop_id) || 0;
    if (maxPerShop > 0 && count >= maxPerShop) continue;
    counts.set(c.shop_id, count + 1); fresh.push(c);
  }
  return [...confirmed, ...fresh];
}
module.exports = {loadMaster, candidateDate, eligibility, reconcilePending, selectBatch, priority};
