import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { CaptureError, parseJson } from './common.mjs';

export const SHOPDESK_DIR = path.join(os.homedir(), 'Library/Application Support/shopdesk');
export const REPORT_URL = 'https://pigeon.jinritemai.com/backstage/queryStaffData';
export const PAGE_URL = 'https://im.jinritemai.com/pc_seller_v2/main/data/customerService/index';
export function listShops(dir = SHOPDESK_DIR) {
  let shops;
  try { shops = JSON.parse(fs.readFileSync(path.join(dir, 'shops.json'), 'utf8')); }
  catch { throw new CaptureError('shops_unavailable', '无法读取店铺工作台店铺列表。'); }
  if (!Array.isArray(shops)) throw new CaptureError('invalid_shops', '店铺列表格式异常。');
  const selected = shops.filter(s => s.platform === '抖店').map(s => ({id: s.id, name: s.name}));
  if (!selected.length || new Set(selected.map(s => s.id)).size !== selected.length ||
    selected.some(s => typeof s.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(s.id) || typeof s.name !== 'string')) {
    throw new CaptureError('invalid_shops', '没有有效抖店，或店铺标识重复/格式异常。');
  }
  return selected;
}
export function cookieHeader(dir, shopId) {
  if (!/^[A-Za-z0-9_-]+$/.test(shopId)) throw new CaptureError('invalid_shop', '店铺标识无效。');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'feige-cookies-'));
  fs.chmodSync(temp, 0o700);
  let db;
  try {
    const source = path.join(dir, 'Partitions', `shop-${shopId}`, 'Cookies');
    for (const suffix of ['', '-wal', '-journal']) {
      try { fs.copyFileSync(source + suffix, path.join(temp, 'Cookies') + suffix); fs.chmodSync(path.join(temp, 'Cookies') + suffix, 0o600); }
      catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    }
    db = new DatabaseSync(path.join(temp, 'Cookies'), {readOnly: true});
    const stmt = db.prepare('SELECT host_key,name,value,path,is_secure,expires_utc FROM cookies');
    stmt.setReadBigInts(true);
    const now = BigInt(Date.now() + 11644473600000) * 1000n;
    const rows = stmt.all().filter(c => c.value && (!c.expires_utc || c.expires_utc > now) &&
      ['pigeon.jinritemai.com', '.pigeon.jinritemai.com', '.jinritemai.com'].includes(c.host_key) &&
      (new URL(REPORT_URL).pathname === c.path || new URL(REPORT_URL).pathname.startsWith(c.path.endsWith('/') ? c.path : c.path + '/')));
    if (!rows.some(c => ['sessionid', 'sid_guard', 'sid_tt'].includes(c.name))) {
      throw new CaptureError('login_expired', '店铺分区中没有可用登录凭据，请恢复该店铺登录。');
    }
    return rows.sort((a, b) => b.path.length - a.path.length).map(c => `${c.name}=${c.value}`).join('; ');
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('login_unavailable', '无法读取店铺工作台登录分区。');
  } finally { db?.close(); fs.rmSync(temp, {recursive: true, force: true}); }
}
export async function requestPage(cookie, date, page, {fetchImpl = fetch, sleep = delay, timeoutMs = 20000} = {}) {
  const url = new URL(REPORT_URL);
  const day = date.replaceAll('-', '');
  url.search = new URLSearchParams({_pms: '1', page: String(page), size: '20', startTime: day, endTime: day, queryType: '1'});
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, {redirect: 'manual', headers: {Cookie: cookie, Referer: PAGE_URL, Accept: 'application/json'},
        signal: AbortSignal.timeout(timeoutMs)});
    } catch {
      if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      throw new CaptureError('network_error', '飞鸽接口连接失败或超时。', {page, attempts: attempt + 1});
    }
    const details = {http_status: response.status, page, attempts: attempt + 1};
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const retryAfter = Number(response.headers?.get('retry-after'));
      await response.body?.cancel();
      await sleep(Math.min(10000, Math.max(1000 * (attempt + 1), Number.isFinite(retryAfter) ? retryAfter * 1000 : 0)));
      continue;
    }
    if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
      throw new CaptureError('login_or_permission', '飞鸽登录失效、需要验证或账号无权访问客服数据。', details);
    }
    if (!response.ok) throw new CaptureError('http_error', `飞鸽接口HTTP ${response.status}。`, details);
    let json;
    try { json = parseJson(await response.text()); }
    catch { throw new CaptureError('invalid_response', '飞鸽接口未返回有效JSON。', details); }
    if (json?.check_spam_resp?.decision && json.check_spam_resp.decision !== 'PASS') {
      throw new CaptureError('verification_required', '飞鸽需要额外安全验证。', details);
    }
    if (![0, '0'].includes(json?.code)) {
      const message = String(json?.msg || json?.message || '');
      const code = /登录|login|session|token|认证/i.test(message) ? 'login_expired' :
        /权限|permission|forbidden/i.test(message) ? 'permission_denied' :
        /验证|captcha|verification|风控/i.test(message) ? 'verification_required' : 'platform_error';
      // Only record a bounded business code, never raw response text or credentials.
      if (/^[A-Za-z0-9_.-]{1,40}$/.test(String(json?.code ?? ''))) details.platform_code = String(json.code);
      if (code === 'platform_error' && attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
      throw new CaptureError(code, code === 'login_expired' ? '飞鸽登录失效或需要重新认证。' :
        code === 'permission_denied' ? '店铺账号没有客服数据访问权限。' :
        code === 'verification_required' ? '飞鸽需要额外安全验证。' :
          `飞鸽业务接口返回失败（业务码 ${details.platform_code || '未提供'}，已尝试${attempt + 1}次）。`, details);
    }
    return json.data;
  }
}
export async function fetchShop(shop, date, {dir = SHOPDESK_DIR, getCookie = cookieHeader, getPage = requestPage} = {}) {
  const cookie = getCookie(dir, shop.id);
  let expected, first;
  const rows = [], seen = new Set();
  for (let page = 1; page <= 1000; page++) {
    const data = await getPage(cookie, date, page);
    if (!data || !Array.isArray(data.staffDataModel) || !Number.isSafeInteger(data.total) || data.total < 0) {
      throw new CaptureError('invalid_response', '客服列表结构或总数异常，不能当作成功0行。');
    }
    if (page === 1) {
      expected = data.total; first = data;
      if (!data.shopSumDetailModel || !data.shopAvgDetailModel || !data.staffCoreDataModel) {
        throw new CaptureError('missing_summary', '客服数据缺少店铺汇总、平均值或顶部指标。');
      }
    } else if (data.total !== expected || data.shopSumDetailModel?.servConvCnt !== first.shopSumDetailModel.servConvCnt) {
      throw new CaptureError('pagination_changed', '翻页期间客服总数或店铺汇总变化，本店数据未写入。');
    }
    for (const row of data.staffDataModel) {
      const id = row?.staffUserInfo?.staffId;
      if (typeof id !== 'string' || !id || seen.has(id)) throw new CaptureError('invalid_staff', '客服标识缺失、精度不安全或分页重复。');
      seen.add(id); rows.push(row);
    }
    if (rows.length > expected) throw new CaptureError('pagination_excess', '客服行数超过平台总数。');
    if (rows.length === expected) return {shop, date, rows, total: expected, sum: first.shopSumDetailModel,
      average: first.shopAvgDetailModel, core: first.staffCoreDataModel, fetchedAt: new Date().toISOString()};
    if (!data.staffDataModel.length) throw new CaptureError('pagination_incomplete', '客服分页提前为空，未写入不完整数据。');
  }
  throw new CaptureError('pagination_limit', '客服列表超过安全分页上限。');
}
