import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const ORDER_PAGE_URL = 'https://www.erp321.com/app/order/order/list.aspx';
const pageState = `(()=>{function find(w){try{if(w.location.pathname.toLowerCase()==='/app/order/order/list.aspx'&&w.jTable&&w.$?.createPostData)return true;for(let i=0;i<w.frames.length;i++)if(find(w.frames[i]))return true;}catch{}return false;}return {ready:find(window),login:/\\/login\\.aspx/i.test(location.pathname)};})()`;
function erpTab(tab) {
  try { const u = new URL(tab.url); return u.hostname === 'www.erp321.com' && !/login/i.test(u.pathname); } catch { return false; }
}
function orderTab(tab) {
  try { const u = new URL(tab.url); return u.origin + u.pathname === ORDER_PAGE_URL; } catch { return false; }
}

export class CliError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class Bridge {
  constructor({ session = 'jst-order-page' } = {}) {
    let port = 10088;
    try { port = JSON.parse(readFileSync(join(homedir(), '.openbridge/repo/.openbridge-data/runtime.json'))).apiPort || port; } catch {}
    this.url = process.env.OPENBRIDGE_URL || `http://127.0.0.1:${port}`;
    this.session = session;
  }
  async request(path, body) {
    let response;
    try {
      response = await fetch(this.url + path, {
        ...(body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(45000),
      });
    } catch { throw new CliError('bridge_unavailable', 'OpenBridge 不可用，请检查本地守护进程和 Chrome 扩展。'); }
    const value = await response.json();
    if (!response.ok || value.error) throw new CliError(value.error?.code || 'bridge_error', value.error?.message || `HTTP ${response.status}`);
    return value.data ?? value;
  }
  command(toolName, args = {}) {
    return this.request('/command', { toolName, sessionId: this.browserSessionId, args: { sessionId: this.session, ...(this.tabId ? { tabId: this.tabId } : {}), ...args } });
  }
  async sessions() {
    const h = await this.request('/health');
    if (!h.ok || !h.connectedSessions?.length) throw new CliError('browser_disconnected', '请连接已授权的 Chrome OpenBridge 扩展。');
    if (!h.enabledTools?.includes('browser_evaluate')) throw new CliError('evaluate_disabled', '请在 OpenBridge 扩展中启用 browser_evaluate。');
    const sessions = [];
    for (const id of h.connectedSessions) {
      this.browserSessionId = id;
      this.tabId = undefined;
      try { const { tabs = [], capabilities } = await this.command('browser_list_tabs');
        if (capabilities?.tabRouting === 1) sessions.push({ id, tabs }); } catch {}
    }
    if (!sessions.length) throw new CliError('tab_routing_required', '已连接的 OpenBridge 扩展需要更新并重新加载，才能安全隔离任务页面。');
    return sessions;
  }
  async connect({ dedicated = false } = {}) {
    if (dedicated) return this.refresh();
    const sessions = await this.sessions();
    for (const { id, tabs } of sessions) {
      this.browserSessionId = id;
      const candidates = tabs.filter(t => (!t.ownerSessionId || t.ownerSessionId === this.session) && erpTab(t) && (orderTab(t) || new URL(t.url).pathname.startsWith('/epaas')));
      candidates.sort((a, b) => Number(orderTab(b)) - Number(orderTab(a)));
      for (const tab of candidates) {
        this.tabId = tab.tabId;
        try {
          await this.command('browser_select_tab', { tabId: this.tabId, activate: false });
          if ((await this.evaluate(pageState))?.ready) return;
        } catch {}
      }
    }
    throw new CliError('order_page_required', '已连接的浏览器均无可用订单页，请重新登录或运行聚水潭登录态刷新任务。');
  }
  async refresh({ browserSessionId } = {}) {
    const sessions = (await this.sessions()).filter(s => !browserSessionId || s.id === browserSessionId);
    const score = tabs => tabs.some(t => erpTab(t) && new URL(t.url).pathname.startsWith('/epaas')) ? 2 : Number(tabs.some(erpTab));
    sessions.sort((a, b) => score(b.tabs) - score(a.tabs));
    for (const { id, tabs } of sessions) {
      if (!tabs.some(t => /^https:\/\/www\.erp321\.com\//.test(t.url || ''))) continue;
      this.browserSessionId = id;
      // 只刷新订单工具自己的页面，避免改动用户的 ERP 页或售后任务页面。
      const own = tabs.find(t => orderTab(t) && (t.ownerSessionId === this.session ||
        (!t.ownerSessionId && (t.groupTitle === this.session || (this.session === 'jst-order-page' && t.groupTitle === 'agent:jst-orde'))))); 
      this.tabId = own?.tabId;
      let created;
      try {
        if (own) await this.command('browser_select_tab', { tabId: own.tabId, activate: false });
        const result = await this.command('browser_navigate', { url: ORDER_PAGE_URL, newTab: !own, activate: false, groupTitle: this.session, waitUntil: 'domcontentloaded', timeoutMs: 30000 });
        this.tabId = result.tabId || own?.tabId;
        if (!own) created = this.tabId;
        if (!this.tabId) throw new CliError('navigation_failed', '导航未返回订单标签页');
        const deadline = Date.now() + 20000;
        do {
          const state = await this.evaluate(pageState);
          if (state?.ready) return;
          if (state?.login) break;
          await delay(500);
        } while (Date.now() < deadline);
      } catch {}
      if (created) await this.command('browser_close_tab', { tabId: created }).catch(() => {});
    }
    throw new CliError('not_logged_in', '所有浏览器均无法加载订单页，请在 Chrome 重新登录聚水潭。');
  }
  async withPageRecovery(operation, { attempts = 3, sleep = delay, onRetry = event =>
    process.stderr.write(`[page-recovery] ${JSON.stringify(event)}\n`) } = {}) {
    for (let attempt = 1; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        const recoverable = ['page_changed', 'TAB_NOT_FOUND', 'TARGET_NOT_IN_TAB'].includes(error.code) ||
          /No tab with (?:given )?id|Tab not found|No target with given id|Cannot find context|Execution context was destroyed|No frame with given id/i.test(error.message);
        if (!recoverable || attempt >= attempts) throw error;
        const browser = this.browserSessionId;
        onRetry({ task: this.session, browser, tabId: this.tabId, attempt, code: error.code });
        await sleep(500 * attempt);
        await this.refresh({ browserSessionId: browser });
      }
    }
  }

  async evaluate(expression) {
    const result = await this.command('browser_evaluate', { expression });
    if (result.type === 'error') throw new CliError('browser_script_error', String(result.result));
    return result.result;
  }
  async run(fn, input) {
    const key = '__jst_' + randomUUID().replaceAll('-', '');
    const start = `(()=>{globalThis[${JSON.stringify(key)}]={state:'pending'};Promise.resolve().then(()=>(${fn.toString()})(${JSON.stringify(input)})).then(value=>globalThis[${JSON.stringify(key)}]={state:'done',value},e=>globalThis[${JSON.stringify(key)}]={state:'error',code:e.code||'page_error',message:e.message});return true})()`;
    await this.evaluate(start);
    const deadline = Date.now() + 90000;
    try {
      while (Date.now() < deadline) {
        const result = await this.evaluate(`globalThis[${JSON.stringify(key)}]`);
        if (result?.state === 'done') return result.value;
        if (result?.state === 'error') throw new CliError(result.code, result.message);
        if (!result) throw new CliError('page_changed', '浏览器页面已切换或刷新，请重试。');
        await delay(250);
      }
      throw new CliError('page_timeout', '页面请求超时。');
    } finally { await this.evaluate(`delete globalThis[${JSON.stringify(key)}]`).catch(() => {}); }
  }
}
