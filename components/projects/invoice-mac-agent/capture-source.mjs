// 只读抖店接口；每店每业务独立、失败丢弃该单元全部明细。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const BASE = 'https://fxg.jinritemai.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const SCENES = {PLATFORM_COUPON_YZJ: '平台补贴', DOUYIN_PAY_COUPON: '抖音支付补贴', DOUYIN_MONTH_PAY_COUPON: '抖音月付营销补贴', DOU_INSTALLMENT_COUPON_ZT: '抖音月付营销补贴', PLATFORM_SERVICE_FEE: '平台服务费', DOUYIN_AD_COUPON: '广告补贴'};
export class CaptureSourceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new CaptureSourceError(code, message); };

// Node 24 reviver context.source 保留 JSON 数值型 19 位订单号原始字面量。
export function parseSourceJson(text) {
  return JSON.parse(text, (_key, value, context) =>
    typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) ? context.source : value);
}
export function identifier(value) {
  if (value == null || value === '' || (typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'number' && !Number.isSafeInteger(value))) fail('PARSE_FAILED', '业务标识缺失或精度不安全');
  return String(value);
}
export function toNumber(value, nullable = false) {
  if (value == null || value === '') {
    if (nullable) return null;
    fail('PARSE_FAILED', '金额缺失');
  }
  const text = String(value).replace(/[,，￥¥元\s]/g, '');
  if (!/^-?\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text))) fail('PARSE_FAILED', '金额格式无效');
  return Number(text);
}
const optionalId = v => v == null || v === '' ? null : identifier(v);
const bool = v => v === true || v === 1 || v === '1' || v === 'true';
const unknownSubject = () => ({companyName: null, creditCode: null});
const hasSubjectIdentity = sub => typeof sub?.CompanyName === 'string' && sub.CompanyName.trim() &&
  typeof sub.CreditCode === 'string' && sub.CreditCode.trim();
// 用户确认的业务规则：消费者待开票统一使用采集时店铺最新主体。
// 只采用来源明确标记的唯一当前主体，不按数组顺序或历史到期时间推断。
export function latestConsumerSubject(subjects) {
  const current = subjects.filter(sub => bool(sub?.IsNewSubject));
  if (current.length !== 1 || bool(current[0].IsSubjectCancelled) || !hasSubjectIdentity(current[0])) return unknownSubject();
  return {companyName: current[0].CompanyName, creditCode: current[0].CreditCode};
}

export function normalizeConsumer(it, shop, subject = unknownSubject()) {
  if (!it || typeof it !== 'object') fail('PARSE_FAILED', '消费者明细格式无效');
  const status = it.invoice_status_info?.invoice_status_text || '待开票';
  if (status !== '待开票') fail('PARSE_FAILED', 'wait_blue 返回非待开票记录');
  return {businessType: 'consumer_order', shopId: identifier(shop.id), shopName: shop.name,
    orderId: identifier(it.shop_order_id), subOrderNo: optionalId(it.sub_order_no),
    registrationId: optionalId(it.registation_id), title: it.title ?? null, taxNo: it.tax_no ?? null,
    invoiceType: it.invoice_type_text ?? null, amount: toNumber(it.invoice_amount),
    applyTime: it.apply_time ?? null, orderStatus: it.order_status_text ?? null, invoiceStatus: status,
    deadlineTime: it.latest_invoice_time_info?.deadline_time ?? null,
    deadlineText: it.latest_invoice_time_info?.description_text ?? null,
    companyName: subject.companyName, creditCode: subject.creditCode};
}
export function normalizePlatform(b, shop, creditCode, companyName) {
  if (!b || typeof b !== 'object') fail('PARSE_FAILED', '平台账单格式无效');
  const raw = b.bill_amount ?? '0';
  const cents = toNumber(raw);
  if (!Number.isSafeInteger(cents)) fail('PARSE_FAILED', '平台分金额必须是安全整数');
  if (typeof companyName !== 'string' || !companyName.trim() || typeof creditCode !== 'string' || !creditCode.trim()) fail('PARSE_FAILED', '账单主体公司名称或信用代码缺失');
  return {businessType: 'platform_bill', shopId: identifier(shop.id), shopName: shop.name,
    billId: identifier(b.id), creditCode, companyName,
    scene: b.scene || '', sceneText: SCENES[b.scene] || b.scene || '',
    billAmountYuan: Math.round(cents) / 100, billAmountRaw: String(raw), orderCount: b.order_count ?? null,
    billPeriod: `${b.bill_date_begin || ''} ~ ${b.bill_date_end || ''}`, createTime: b.create_time ?? null,
    corpTitle: b.CorporationInfo?.Title ?? null, corpTaxNo: b.CorporationInfo?.TaxCode ?? null,
    isFrozen: bool(b.IsFrozen), payStatus: b.PayStatus ?? null, unpayAmount: toNumber(b.UnpayAmount, true)};
}

export function listCaptureShops(dir) {
  const shops = parseSourceJson(fs.readFileSync(path.join(dir, 'shops.json'), 'utf8'));
  if (!Array.isArray(shops)) fail('PARSE_FAILED', 'shops.json 必须是数组');
  const selected = shops.filter(s => s.platform === '抖店').map(s => ({id: identifier(s.id), name: String(s.name || ''), platform: s.platform}));
  if (new Set(selected.map(s => s.id)).size !== selected.length) fail('PARSE_FAILED', 'shops.json 店铺 ID 重复');
  return selected;
}
export function readShopCookies(dir, shopId) {
  if (!/^[A-Za-z0-9_-]+$/.test(shopId)) fail('PARSE_FAILED', '店铺分区标识非法');
  const source = path.join(dir, 'Partitions', `shop-${shopId}`, 'Cookies');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'invoice-cookies-'));
  let db;
  try {
    for (const suffix of ['', '-wal', '-journal']) {
      try { fs.copyFileSync(source + suffix, path.join(temp, 'Cookies') + suffix); fs.chmodSync(path.join(temp, 'Cookies') + suffix, 0o600); }
      catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    }
    db = new DatabaseSync(path.join(temp, 'Cookies'), {readOnly: true});
    const now = BigInt(Date.now() + 11644473600000) * 1000n;
    const statement = db.prepare('SELECT host_key,name,value,path,is_secure,expires_utc FROM cookies');
    // Chromium 微秒时间戳超过 JS 安全整数范围，必须以 BigInt 读取。
    statement.setReadBigInts(true);
    const rows = statement.all();
    return rows.filter(c => c.value && (c.host_key === 'jinritemai.com' || c.host_key.endsWith('.jinritemai.com')) &&
      (!c.expires_utc || c.expires_utc > now));
  } catch { fail('LOGIN_EXPIRED', '无法读取店铺登录分区，请在店铺工作台重新登录'); }
  finally { db?.close(); fs.rmSync(temp, {recursive: true, force: true}); }
}
function cookieHeader(cookies, url) {
  return cookies.filter(c => {
    const domain = c.host_key.replace(/^\./, '');
    const domainOK = c.host_key.startsWith('.') ? url.hostname === domain || url.hostname.endsWith('.' + domain) : url.hostname === domain;
    const p = c.path || '/';
    return domainOK && (url.pathname === p || url.pathname.startsWith(p.endsWith('/') ? p : p + '/')) && (!c.is_secure || url.protocol === 'https:');
  }).sort((a, b) => (b.path || '/').length - (a.path || '/').length).map(c => `${c.name}=${c.value}`).join('; ');
}
function validateEnvelope(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) fail('PARSE_FAILED', '接口响应不是对象');
  if (['msg', 'message', 'ret_message'].some(k => /登录已失效|请重新登录|未登录|安全验证/.test(String(j[k] || '')))) fail('LOGIN_EXPIRED', '抖店登录失效或需要安全验证');
  if ((j.code != null && ![0, '0'].includes(j.code)) || (j.ret_code != null && !['0000', 0, '0'].includes(j.ret_code))) fail('PARSE_FAILED', '抖店接口拒绝请求');
}
function totalValue(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) fail('PARSE_FAILED', '分页 total 无效');
  return n;
}

export function createCaptureSource({cfg, log = console, fetchImpl = globalThis.fetch, getCookies = readShopCookies, shops: suppliedShops, now = () => Date.now()}) {
  async function get(cookies, pathname, params = {}) {
    const url = new URL(pathname, BASE);
    url.search = new URLSearchParams(params).toString();
    let response;
    try {
      response = await fetchImpl(url, {redirect: 'manual', headers: {'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: BASE + '/ffa/m-invoice/merchant-invoice', Cookie: cookieHeader(cookies, url)}, signal: AbortSignal.timeout(cfg.captureRequestTimeoutMs || 30000)});
      if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) fail('LOGIN_EXPIRED', '抖店登录失效或请求被拦截');
      if (!response.ok) fail('OTHER', `抖店 HTTP ${response.status}`);
      const text = await response.text();
      let j;
      try { j = parseSourceJson(text); } catch { fail('PARSE_FAILED', '抖店返回非 JSON'); }
      validateEnvelope(j);
      return j;
    } catch (error) {
      if (error instanceof CaptureSourceError) throw error;
      fail(/timeout|abort/i.test(error.name) ? 'PAGE_TIMEOUT' : 'OTHER', '抖店请求超时或网络异常');
    }
  }
  async function consumers(shop, cookies, subject) {
    const rows = [], seenPages = new Set();
    const timestamp = Math.floor(now() / 1000);
    let expected = null, fetchedCount = 0;
    const finish = () => {
      log.info?.({event: 'capture_consumer_order_filter', shopId: shop.id, orderStatus: '已完成',
        fetchedCount, rowCount: rows.length, skippedCount: fetchedCount - rows.length});
      return rows;
    };
    for (let page = 0; page < 50; page++) {
      const j = await get(cookies, '/order/invoice/list', {page, pageSize: 100, create_time_start: timestamp - 730 * 86400, create_time_end: timestamp + 7 * 86400, invoice_status_desc: 'wait_blue', appid: 1, _bid: 'ffa_order', aid: 4272});
      if (!Array.isArray(j.data)) fail('PARSE_FAILED', '消费者列表缺少 data 数组（不能判为空店）');
      if (!j.data.length && ![0, '0'].includes(j.code)) fail('PARSE_FAILED', '空消费者列表缺少明确成功码');
      const fingerprint = JSON.stringify(j.data);
      if (j.data.length && seenPages.has(fingerprint)) fail('PAGINATION_FAILED', '消费者接口重复返回同一页');
      seenPages.add(fingerprint);
      const total = totalValue(j.total);
      if (page && expected !== total) fail('PAGINATION_FAILED', '消费者分页 total 变化，放弃部分明细');
      expected = total;
      // total 是来源列表总数；筛选后的行数不能用于判断分页是否完整。
      fetchedCount += j.data.length;
      for (const it of j.data) {
        if (!it || typeof it !== 'object' || Array.isArray(it)) fail('PARSE_FAILED', '消费者明细格式无效');
        // 只采集页面明确显示“已完成”的订单，其他状态（含缺失/未知）不入快照。
        if (it.order_status_text === '已完成') rows.push(normalizeConsumer(it, shop, subject));
      }
      if (total !== null) {
        if (fetchedCount > total) fail('PAGINATION_FAILED', '消费者行数超过 total');
        if (fetchedCount === total) return finish();
        if (!j.data.length) fail('PAGINATION_FAILED', '消费者分页提前为空');
      } else {
        // 无 total 时必须有明确成功码；短页/空页才可确认结束。
        if (![0, '0'].includes(j.code)) fail('PARSE_FAILED', '消费者无 total 且无明确成功码');
        if (j.data.length < 100) return finish();
      }
    }
    fail('PAGINATION_FAILED', '消费者超过 50 页，不能上报完整成功');
  }
  async function platforms(shop, cookies, subjects) {
    const rows = [];
    for (const sub of subjects) {
      if (!Object.hasOwn(sub, 'HasPendingPlatformInvoiceBill') || ![true, false, 0, 1, '0', '1', 'true', 'false'].includes(sub.HasPendingPlatformInvoiceBill)) fail('PARSE_FAILED', '主体缺少明确待开票标志');
      if (!bool(sub.HasPendingPlatformInvoiceBill)) continue;
      // 部分店铺返回名称、税号均显式为空的条目，且待开票标志仍为true。
      // 不猜测税号、不直接跳过：只读查询此空范围，明确成功且total=0才能确认无账单。
      const emptySubject = sub.CreditCode === '' && sub.CompanyName === '';
      if (!sub.CreditCode && !emptySubject) fail('PARSE_FAILED', '待开票主体缺少信用代码，不能确认平台账单完整');
      const creditCode = emptySubject ? '' : identifier(sub.CreditCode);
      const j = await get(cookies, '/api/ecomfinance/uninvoicebill/getPage', {InvoiceVersion: 'v1', credit_code: creditCode, is_asc: 'true', page_number: 1, page_size: 50});
      if (!Array.isArray(j.invoice_bills)) fail('PARSE_FAILED', '平台账单缺少 invoice_bills 数组');
      if (!j.invoice_bills.length && !['0000', 0, '0'].includes(j.ret_code)) fail('PARSE_FAILED', '空平台账单缺少明确成功码');
      const total = totalValue(j.total_counts ?? j.total ?? j.total_count ?? j.totalCount);
      if (emptySubject) {
        if (!['0000', 0, '0'].includes(j.ret_code) || total !== 0 || j.invoice_bills.length !== 0) {
          fail('PARSE_FAILED', '空名称及信用代码主体未被明确确认为0条账单，不能确认平台账单完整');
        }
        log.info?.({event: 'capture_empty_subject_confirmed', shopId: shop.id, rowCount: 0});
        continue;
      }
      // 保持只取第一页，但发现有后续页时不能谎报完整成功。
      if ((total !== null && total !== j.invoice_bills.length) || (total === null && j.invoice_bills.length >= 50)) fail('PAGINATION_FAILED', '平台账单第一页不足以证明完整');
      rows.push(...j.invoice_bills.map(b => normalizePlatform(b, shop, creditCode, sub.CompanyName)));
    }
    return rows;
  }
  async function collect({shopId} = {}) {
    let shops = suppliedShops || listCaptureShops(cfg.captureShopdeskDir);
    if (shopId) shops = shops.filter(s => s.id === shopId);
    if (!shops.length) throw Error('没有匹配的抖店店铺');
    const businessTypes = ['consumer_order', 'platform_bill'];
    if (shops.length * businessTypes.length > 2000) throw Error('店铺数量超过 shopResults 上限');
    const rows = [], shopResults = [];
    for (const shop of shops) {
      let cookies, cookieError, subjects, subjectError;
      try {
        cookies = await getCookies(cfg.captureShopdeskDir, shop.id);
        if (!cookies.some(c => ['sessionid', 'sid_guard', 'sid_tt'].includes(c.name))) fail('LOGIN_EXPIRED', '店铺分区未找到登录凭据');
      } catch (error) { cookieError = error; }
      if (!cookieError) {
        try {
          const j = await get(cookies, '/api/ecomfinance/subject/list');
          subjects = j.ret_data?.subject_list;
          if (!Array.isArray(subjects)) fail('PARSE_FAILED', '主体列表缺少 subject_list 数组');
          if (!subjects.length && !['0000', 0, '0'].includes(j.ret_code)) fail('PARSE_FAILED', '空主体列表缺少明确成功码');
        } catch (error) { subjectError = error; }
      }
      const consumerSubject = subjectError || cookieError ? unknownSubject() : latestConsumerSubject(subjects);
      if (!consumerSubject.creditCode) log.warn?.({event: 'capture_consumer_subject_unavailable', shopId: shop.id,
        reason: subjectError ? 'subject_request_failed' : cookieError ? 'login_unavailable' : 'latest_subject_not_unique_or_incomplete'});
      for (const businessType of businessTypes) {
        let result;
        try {
          if (cookieError) throw cookieError;
          if (businessType === 'platform_bill' && subjectError) throw subjectError;
          const unitRows = businessType === 'consumer_order' ? await consumers(shop, cookies, consumerSubject)
            : await platforms(shop, cookies, subjects);
          rows.push(...unitRows);
          result = {shopId: shop.id, businessType, status: 'success', isComplete: true, rowCount: unitRows.length, errorCode: null, errorMessage: null};
        } catch (error) {
          result = {shopId: shop.id, businessType, status: 'failed', isComplete: false, rowCount: null,
            errorCode: error instanceof CaptureSourceError ? error.code : 'OTHER',
            errorMessage: error instanceof CaptureSourceError ? error.message.slice(0, 1000) : '店铺采集异常'};
        }
        shopResults.push(result);
        log.info?.({event: 'capture_shop_result', ...result});
      }
    }
    return {rows, shopResults};
  }
  return {collect};
}
