// 聚水潭售后明细同步核心逻辑：通过 OpenBridge 驱动售后页，抓取指定日期售后数据，落库 SQLite。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const BASE = 'http://127.0.0.1:10088';
const AFTER_SALE_URL = 'https://innerorder.scm121.com/afterSales?m=n&f=erp&ffrom=erp_menu_after_sale&tabAllow=clipboard-read%3B%20clipboard-write';
const LIST_API = 'https://innerapi.scm121.com/api/inner/after-sale/page/list';
const PAGE_SIZE = 500;
const BATCH_PAGES = 5;

// ---------- 日期 ----------
export function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
}
export function yesterdayShanghai(now = new Date()) {
  return shanghaiDate(new Date(now.getTime() - 86_400_000));
}

// ---------- OpenBridge 客户端 ----------
export class Bridge {
  constructor({ task = 'jst-aftersale-sync' } = {}) {
    this.task = task;
    let port = 10088;
    try { port = JSON.parse(readFileSync(homedir() + '/.openbridge/repo/.openbridge-data/runtime.json')).apiPort || port; } catch {}
    this.base = `http://127.0.0.1:${port}`;
    this.sessionId = null;
  }
  async health() { return (await fetch(this.base + '/health')).json(); }
  async command(tool, args, sid) {
    const body = { toolName: tool, args: { ...(this.tabId ? { tabId: this.tabId } : {}), ...args, sessionId: this.task }, sessionId: sid };
    const r = await fetch(this.base + '/command', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
    });
    const j = await r.json();
    if (j.error) throw Object.assign(new Error(`${j.error.code}: ${j.error.message}`), { code: j.error.code });
    const data = j.data ?? j;
    if (['browser_select_tab', 'browser_new_tab', 'browser_navigate'].includes(tool) && data.tabId != null) this.tabId = data.tabId;
    return data;
  }
  // 优先已打开 ERP 业务页的会话。标签数量不能代表登录态，登录页也不能
  // 算作可用 ERP；否则会选中标签很多但已退出登录的浏览器，漏掉已登录会话。
  async findSession() {
    this.tabId = undefined;
    const h = await this.health();
    const candidates = [];
    let unsupported = false;
    for (const s of h.connectedSessions || []) {
      try {
        const r = await this.command('browser_list_tabs', {}, s);
        if (r.capabilities?.tabRouting !== 1) { unsupported = true; continue; }
        const tabs = r.tabs || [];
        let score = 0;
        for (const tab of tabs) {
          let url;
          try { url = new URL(tab.url); } catch { continue; }
          if (url.hostname === 'www.erp321.com' && !/login/i.test(url.pathname)) {
            score = Math.max(score, url.pathname.startsWith('/epaas') ? 30 : 20);
          } else if (url.hostname === 'innerorder.scm121.com') {
            score = Math.max(score, 10);
          }
        }
        // 保留只有登录页的会话作为最后兜底；有业务页的会话优先。
        if (score || tabs.some(t => /^https:\/\/www\.erp321\.com\//.test(t.url || ''))) {
          candidates.push({ sessionId: s, score });
        }
      } catch {}
    }
    candidates.sort((a, b) => b.score - a.score);
    this._sessionCandidates = candidates.map(c => c.sessionId);
    if (candidates.length) {
      this.sessionId = candidates[0].sessionId;
      return this.sessionId;
    }
    if (unsupported) throw Object.assign(new Error('OpenBridge 扩展需要更新并重新加载，才能安全隔离任务页面'), { code: 'tab_routing_required' });
    throw new Error('未找到承载聚水潭 ERP 的浏览器会话（OpenBridge 未连接或未登录）');
  }
  // 返回 CDP 命令的原始结果（如 Runtime.evaluate 的 {result,...} 或 DOM 域的 {root,...}）
  async cdp(method, params, targetId) {
    const args = { method, params };
    if (targetId) args.targetId = targetId;
    return this.command('browser_cdp', args, this.sessionId);
  }
  // 探测当前扩展支持哪种求值工具：browser_cdp（旧版，支持 awaitPromise/targetId）或 browser_evaluate（新版）
  async _pickEvalTool() {
    if (this._evalTool) return this._evalTool;
    try {
      await this.command('browser_cdp', { method: 'Runtime.evaluate', params: { expression: '0', returnByValue: true } }, this.sessionId);
      this._evalTool = 'browser_cdp';
    } catch {
      this._evalTool = 'browser_evaluate';
    }
    return this._evalTool;
  }

  async _evalViaCdp(expression, targetId) {
    const r = await this.cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, targetId);
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + (r.exceptionDetails.text || r.exceptionDetails.exception?.description));
    return r.result?.value;
  }

  async evaljs(expression, targetId) {
    // 带 targetId（跨域 OOPIF）只能走 browser_cdp
    if (targetId) return this._evalViaCdp(expression, targetId);
    const tool = await this._pickEvalTool();
    if (tool === 'browser_cdp') return this._evalViaCdp(expression);
    // 新版扩展兜底：browser_evaluate（仅支持同步表达式，无 awaitPromise）
    const r = await this.command('browser_evaluate', { expression }, this.sessionId);
    if (r.error) throw new Error(r.error.message);
    return r.result;
  }
  // 让标签会话发现并自动附着子帧（OOPIF）。不做这一步，browser_cdp 带
  // targetId（=DOM.describeNode 返回的 frameId）会报 "No target with given id"。
  // 必须在每次 select_tab / 重新 attach 之后调用。
  async enableChildTargets() {
    try {
      await this.cdp('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
      return true;
    } catch {
      return false;
    }
  }
  async _listEpaasTabs() {
    const r = await this.command('browser_list_tabs', {}, this.sessionId);
    return (r.tabs || []).filter(t => (!t.ownerSessionId || t.ownerSessionId === this.task) && (t.url || '').startsWith('https://www.erp321.com/epaas'));
  }
  // 浏览器里没有可用的 epaas 壳页时，自己开一个（复用 ERP 登录态），
  // 否则定时任务会直接失败在「未找到 epaas 标签页」。
  async openEpaasTab() {
    const r = await this.command('browser_navigate', {
      url: 'https://www.erp321.com/epaas',
      newTab: true,
      waitUntil: 'domcontentloaded',
      timeoutMs: 30000,
      groupTitle: 'JST售后同步',
    }, this.sessionId);
    // SPA 初始化（iframe-welcome-page 挂载）需要时间
    await new Promise(res => setTimeout(res, 8000));
    return r.tabId;
  }
  async findEpaasTab() {
    const errs = [];
    // 一个浏览器已登出时继续尝试其他连接，不能让首次匹配锁死整轮同步。
    for (const sid of this._sessionCandidates || [this.sessionId]) {
      this.sessionId = sid;
      try {
        return await this._findEpaasTabInSession();
      } catch (e) {
        errs.push(e.message);
      }
    }
    throw new Error('所有浏览器会话均无可用 ERP 售后页 → ' + errs.join(' | '));
  }
  async _findEpaasTabInSession() {
    let candidates = await this._listEpaasTabs();
    const errs = [];
    // 优先已激活的标签；逐个尝试，跳过卡死（daemon 侧 30s 超时）的标签
    for (let round = 0; round < 2; round += 1) {
      candidates.sort((a, b) => Number(!!b.active) - Number(!!a.active));
      for (const tab of candidates) {
        try {
          await this.command('browser_select_tab', { tabId: tab.tabId }, this.sessionId);
          const childTargets = await this.enableChildTargets();
          return { tab, childTargets };
        } catch (e) {
          errs.push(`${tab.tabId}: ${e.message}`);
        }
      }
      // 没有存量标签、或存量标签全部卡死 → 新开一个再试
      if (round === 0) {
        await this.openEpaasTab().catch(e => errs.push(`open: ${e.message}`));
        candidates = await this._listEpaasTabs();
        if (!candidates.length) errs.push('打开 ERP 后未出现 epaas 页（可能已退出登录）');
      }
    }
    throw new Error('未找到可用的 epaas 标签页 → ' + errs.join(' | '));
  }
}

// 在售后 OOPIF 里执行的 JS（字符串），用于设置日期并返回 targetId / 抓数据
export const pageScripts = {
  // 确保 epaas 页的 iframe-welcome-page 指向售后页
  navigateAfterSale: `(function(){
    var f = document.getElementById('iframe-welcome-page');
    if(!f) return JSON.stringify({err:'no iframe-welcome-page'});
    var want = ${JSON.stringify(AFTER_SALE_URL)};
    if(f.src !== want){ f.src = want; return JSON.stringify({navigated:true}); }
    return JSON.stringify({already:true});
  })()`,
  // 获取 iframe-welcome-page 的 frameId（即 OOPIF targetId）
  getFrameId: `(function(){
    var f = document.getElementById('iframe-welcome-page');
    if(!f) return null;
    // 通过 contentWindow 拿不到 frameId，用 DOM 描述在调用方做
    return null;
  })()`,
};

// 获取 iframe-welcome-page 的 frameId（targetId），走 DOM 域
export async function getAfterSaleTargetId(bridge) {
  const doc = await bridge.cdp('DOM.getDocument', { depth: 0 });
  const q = await bridge.cdp('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: 'iframe' });
  for (const nid of q.nodeIds || []) {
    const d = await bridge.cdp('DOM.describeNode', { nodeId: nid });
    const attrs = d.node.attributes || [];
    const i = attrs.indexOf('id');
    if (i >= 0 && attrs[i + 1] === 'iframe-welcome-page') return d.node.frameId;
  }
  throw new Error('未找到售后页 iframe 的 frameId');
}

// 捕获列表请求的完整 headers（含 Authorization / gwfp 等风控头）
export async function captureHeaders(bridge, targetId) {
  await bridge.evaljs(`(function(){
    window.__capH = [];
    var of = window.fetch;
    window.fetch = function(url, opt){
      if(typeof url === 'string' && url.indexOf('after-sale/page/list') >= 0){
        var h = {};
        try {
          if(opt && opt.headers){
            if(opt.headers.forEach){ opt.headers.forEach(function(v,k){ h[k]=v; }); }
            else { h = Object.assign({}, opt.headers); }
          }
        } catch(e){}
        window.__capH.push({headers: h, body: opt ? String(opt.body||'') : ''});
      }
      return of.apply(this, arguments);
    };
    return 'hooked';
  })()`, targetId);
  // 触发页面自己发一次列表请求（点搜索），拿到完整 headers
  await bridge.evaljs(`(function(){
    var b = [...document.querySelectorAll('button')].find(function(x){ return (x.innerText||x.textContent||'').trim()==='搜 索'; });
    if(b){ b.click(); return 'clicked'; }
    return 'no-search-btn';
  })()`, targetId);
  await new Promise(r => setTimeout(r, 3500));
  const cap = await bridge.evaljs(`(function(){ return JSON.stringify(window.__capH || []); })()`, targetId);
  const arr = JSON.parse(cap);
  const last = arr[arr.length - 1];
  if (!last || !last.headers) throw new Error('未能捕获售后列表请求的鉴权头');
  return last.headers;
}

// 在 OOPIF 里抓取指定日期全部数据（分批），返回 { total, count }
export async function scrapeDate(bridge, targetId, headers, date) {
  const startTime = `${date} 00:00:00`;
  const endTime = `${date} 23:59:59`;
  // 计数
  const countJs = `(async function(){
    var H = ${JSON.stringify(headers)};
    var x = new XMLHttpRequest();
    x.open('POST', ${JSON.stringify(LIST_API)});
    for(var k in H){ try{ x.setRequestHeader(k, H[k]); }catch(e){} }
    var body = {searchType:2, afterApplicationStartTime:${JSON.stringify(startTime)}, afterApplicationEndTime:${JSON.stringify(endTime)}, querySortDTO:{shopEndDate:false}, isWhite:1, afterSaleStatus:['WaitConfirm','Confirmed'], pageNum:1, pageSize:${PAGE_SIZE}};
    var txt = await new Promise(function(res){ x.onload=function(){res(x.responseText);}; x.onerror=function(){res('ERR');}; x.send(JSON.stringify(body)); });
    var j = JSON.parse(txt);
    return JSON.stringify({code:j.code, total:j.total, message:j.message});
  })()`;
  const countRes = JSON.parse(await bridge.evaljs(countJs, targetId));
  assertApiSuccess(countRes.code, '计数');
  const total = Number(countRes.total);
  if (!Number.isFinite(total) || total < 0) throw new Error(`计数异常: ${countRes.total}`);
  if (total === 0) return { total: 0, rows: [] };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const all = [];
  // 分批抓（每批 BATCH_PAGES 页），避免单次 evaluate 超时
  for (let startPage = 1; startPage <= totalPages; startPage += BATCH_PAGES) {
    const endPage = Math.min(startPage + BATCH_PAGES - 1, totalPages);
    const batchJs = `(async function(){
      var H = ${JSON.stringify(headers)};
      function req(pn){
        return new Promise(function(res){
          var x = new XMLHttpRequest();
          x.open('POST', ${JSON.stringify(LIST_API)});
          for(var k in H){ try{ x.setRequestHeader(k, H[k]); }catch(e){} }
          var body = {searchType:1, afterApplicationStartTime:${JSON.stringify(startTime)}, afterApplicationEndTime:${JSON.stringify(endTime)}, querySortDTO:{shopEndDate:false}, isWhite:1, afterSaleStatus:['WaitConfirm','Confirmed'], pageNum:pn, pageSize:${PAGE_SIZE}};
          x.onload=function(){ try{ res(JSON.parse(x.responseText)); }catch(e){ res({__err:'parse'}); } };
          x.onerror=function(){ res({__err:'network'}); };
          x.send(JSON.stringify(body));
        });
      }
      var acc = [];
      for(var p=${startPage}; p<=${endPage}; p++){
        var r = await req(p);
        if(r.__err) return JSON.stringify({err:r.__err, atPage:p, acc:acc.length});
        if(r.code !== '0000') return JSON.stringify({err:'api', code:r.code, atPage:p, acc:acc.length});
        acc = acc.concat(r.data || []);
      }
      return JSON.stringify({ok:true, rows:acc});
    })()`;
    const batchRes = JSON.parse(await bridge.evaljs(batchJs, targetId));
    if (batchRes.err === 'api') assertApiSuccess(batchRes.code, `第${batchRes.atPage}页`);
    if (batchRes.err) throw new Error(`抓取第${startPage}页附近失败: ${batchRes.err}`);
    all.push(...batchRes.rows);
  }
  return { total, rows: all };
}

export function assertApiSuccess(code, phase) {
  if (code === '0000') return;
  const expired = String(code) === '1006';
  throw Object.assign(new Error(`${phase}接口失败: ${code}${expired ? ' 登录状态已失效，请重新登录。' : ''}`), {
    code: expired ? 'session_expired' : 'aftersales_api_failed',
  });
}

// 解析商品属性（颜色/尺码）
function parseProps(p) {
  if (!p) return { color: null, size: null };
  const segs = p.split(';').map(s => s.trim()).filter(Boolean);
  let color = null, size = null;
  for (const s of segs) {
    const kv = s.split(':');
    if (s.startsWith('颜色')) color = (kv[1] || s).replace(/[（(].*$/, '').trim();
    else if (s.startsWith('尺码')) size = (kv[1] || s).replace(/[（(].*$/, '').trim();
  }
  if (!color && segs.length >= 1) color = segs[0];
  if (!size && segs.length >= 2) size = segs[1];
  return { color, size };
}

export const COLUMNS_MAIN = [
  '售后单号','关联订单号','关联原始订单号','平台售后单号','店铺名称','所属平台','售后类型',
  'ERP售后状态','平台售后状态','售后申请时间','ERP售后创建时间','售后更新时间',
  '商家处理截止时间','商家剩余处理时长','商家同意退货时间','买家寄回截止时间','买家实际寄出时间',
  '售后确认时间','退款成功时间','售后关闭时间','售后撤销时间','售后拒绝时间',
  '售后申请原因','退款金额','是否仅退款','是否需要退回实物',
  '原订单下单时间','原订单付款时间','原订单实际发货时间','原订单付款件数','原订单实际发货件数',
  '售后申请件数','买家实际寄回件数','仓库实际收到件数','销退实际入库件数','质检合格件数','可再次销售件数',
  '次品件数','报废件数','拒收件数','尚未退回件数','已收货但尚未入库件数','已入库但尚未完成质检件数','部分退回标记',
  '退回仓库名称','退回仓库类型','原订单当前状态','原订单是否付款','原订单是否发货',
  '发货前取消时间','发货前取消件数','发货前取消原因','订单承诺发货时间','订单最晚发货时间','订单来源渠道',
  '订单物流签收时间','买家确认收货时间','退货物流公司','退货物流单号','退货物流状态',
  '退货物流最新更新时间','退货物流签收时间','仓库实际收货时间','销退入库时间','质检完成时间','实际可再次销售时间',
  '原订单仓库','原订单类型','线上类型','业务类型','仲裁状态','退款阶段','售后标签','原订单标签',
  '实际退款金额','运费','换货金额','线上申请金额','是否拆分','是否合并','问题原因','备注',
];
export const COLUMNS_ITEM = [
  '售后单号','商品编码','SKU编码','颜色','尺码','原订单商品明细编号','售后商品明细编号',
  '是否套装或组合商品','套装或组合商品编码','套装包含的组件SKU','每套对应的组件件数',
  '商品名称','售后申请件数','买家实际寄回件数','次品件数','退款金额','单价','原价','售后商品类型',
];

export function ensureSchema(db) {
  const cols = COLUMNS_MAIN.map(c => `"${c}" TEXT`).join(', ');
  // 主键用售后单号
  db.exec(`CREATE TABLE IF NOT EXISTS aftersale_details (${cols}, PRIMARY KEY("售后单号"))`);
  const icols = COLUMNS_ITEM.map(c => `"${c}" TEXT`).join(', ');
  db.exec(`CREATE TABLE IF NOT EXISTS aftersale_item_details (${icols})`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_item_asno ON aftersale_item_details("售后单号")`);
  db.exec(`CREATE TABLE IF NOT EXISTS sync_info (
    date TEXT PRIMARY KEY, started_at TEXT, completed_at TEXT,
    duration_ms INTEGER, total_rows INTEGER, item_rows INTEGER
  )`);
}

export function loadRows(db, rows) {
  const mainCols = COLUMNS_MAIN;
  const itemCols = COLUMNS_ITEM;
  const insMain = db.prepare(`INSERT OR REPLACE INTO aftersale_details (${mainCols.map(c => `"${c}"`).join(',')}) VALUES (${mainCols.map(() => '?').join(',')})`);
  const insItem = db.prepare(`INSERT OR REPLACE INTO aftersale_item_details (${itemCols.map(c => `"${c}"`).join(',')}) VALUES (${itemCols.map(() => '?').join(',')})`);
  let itemRows = 0;
  db.exec('BEGIN');
  // 幂等：先删除这批售后单号的商品明细，再重插
  const asNos = [...new Set(rows.map(r => r.afterSaleOrderNo))];
  for (let i = 0; i < asNos.length; i += 500) {
    const chunk = asNos.slice(i, i + 500);
    const ph = chunk.map(() => '?').join(',');
    db.prepare(`DELETE FROM aftersale_item_details WHERE "售后单号" IN (${ph})`).run(...chunk);
  }
  for (const x of rows) {
    const gvo = x.afterSaleOrderGoodsVO || {};
    const ds = gvo.details || [];
    let applyNum = 0, backNum = 0, defectiveNum = 0;
    for (const d of ds) {
      applyNum += Number(d.refundNum) || 0;
      backNum += Number(d.realNumberBack) || 0;
      defectiveNum += Number(d.defectiveQty) || 0;
      const pp = parseProps(d.properties);
      const isCombined = d.combineSkuId ? 1 : 0;
      insItem.run(
        x.afterSaleOrderNo, d.designCode, d.skuCode, pp.color, pp.size, null, d.asiId,
        isCombined, d.combineSkuId, null, null, d.productName, d.refundNum, d.realNumberBack,
        d.defectiveQty, d.refundAmount, d.price, d.grossAmount, d.type
      );
      itemRows++;
    }
    const afterType = x.afterType || '';
    const isOnlyRefund = afterType === '仅退款' ? 1 : 0;
    const needReturn = ['退货退款', '换货', '拒收退货'].includes(afterType) ? 1 : 0;
    insMain.run(
      x.afterSaleOrderNo, x.orderNo, x.rawSoId, x.outerAsId, x.shopName, x.shopSite, afterType,
      x.afterState, x.onlineState, x.applicationTime, x.created, x.modified,
      x.shopEndDate, x.timeoutTimeLeft, null, null, null, x.confirmDate, null, null, null, null,
      x.afterSalesProblemType, x.backAmount, isOnlyRefund, needReturn,
      x.orderDate, x.payDate, x.sendDate, null, null,
      applyNum, backNum, x.totalRealReturn, null, null, null, defectiveNum, null, null, null, null, null, null,
      x.warehouse, x.whId != null ? String(x.whId) : null,
      x.orderStatus, x.upayment, x.sendDate ? 1 : 0,
      null, null, null, null, null, x.orderFrom, x.receiveDate, null,
      x.returnLogisticsCompany, null, x.logisticsStatus, null, null, null, null, null, null,
      x.orderWmsName, x.orderType, x.onlineType, x.businessType, x.arbitrationStatus, x.refundPhase,
      x.labels, x.orderLabels, x.actualReturnAmount, x.freight, x.exChangeAmount, x.onlineApplicationAmount,
      x.split ? 1 : 0, x.merge ? 1 : 0, x.questionReason, x.remark
    );
  }
  db.exec('COMMIT');
  return itemRows;
}
