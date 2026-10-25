import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, getAfterSaleTargetId, captureHeaders, scrapeDate, pageScripts } from './sync.js';

function failure(code, message) { return Object.assign(new Error(message), { code }); }

// 每轮从全新的 ERP 壳页启动单点登录。长期驻留的跨域售后页即使 URL 和 DOM
// 看似正常，其 Authorization 也可能已过期；订单/库存 Cookie 有效不能证明售后有效。
export async function prepareAfterSale(bridge, { sleep = delay, attempts = 40 } = {}) {
  const opened = await bridge.command('browser_navigate', {
    url: 'https://www.erp321.com/epaas', newTab: true,
    activate: false,
    waitUntil: 'domcontentloaded', timeoutMs: 30000, groupTitle: 'JST售后同步',
  }, bridge.sessionId);
  if (!opened.tabId) throw failure('aftersales_navigation_failed', '新建 ERP 页未返回标签页标识');
  bridge.tabId = opened.tabId;
  await bridge.command('browser_select_tab', { tabId: bridge.tabId, activate: false }, bridge.sessionId);
  await bridge.enableChildTargets();
  let navigated = false;
  for (let i = 0; i < attempts; i++) {
    const shell = JSON.parse(await bridge.evaljs(`JSON.stringify({
      login: location.origin === 'https://www.erp321.com' && /\\/login\\.aspx/i.test(location.pathname),
      frame: !!document.getElementById('iframe-welcome-page')
    })`));
    if (shell.login) throw failure('session_expired', '新建 ERP 页跳转登录页，登录状态已失效');
    if (!navigated && shell.frame) {
      await bridge.evaljs(pageScripts.navigateAfterSale);
      navigated = true;
    }
    if (navigated) {
      try {
        const targetId = await getAfterSaleTargetId(bridge);
        const state = JSON.parse(await bridge.evaljs(`JSON.stringify({
          ready: (document.body?.innerText || '').includes('售后单号'),
          login: /\\/login\\.aspx/i.test(location.pathname) || /登录状态已失效|请重新登录/.test(document.body?.innerText || '')
        })`, targetId));
        if (state.login) throw failure('session_expired', '售后页提示登录状态失效');
        if (state.ready) return targetId;
      } catch (error) {
        if (!/No target with given id|未找到售后页 iframe|Cannot find context|Execution context was destroyed/.test(error.message)) throw error;
        await bridge.enableChildTargets();
      }
    }
    await sleep(1000);
  }
  throw failure('aftersales_page_timeout', '新建售后页加载超时（未确认登录失效）');
}

export async function closeAfterSale(bridge) {
  const tabId = bridge.tabId;
  bridge.tabId = undefined;
  if (tabId) await bridge.command('browser_close_tab', { tabId }, bridge.sessionId);
}

// 登录、订单体检及库存体检都绑定失败的同一浏览器，避免另一浏览器正常时
// 掩盖本次会话的失效。复用已授权的自动填入/协议/验证码处理与 Keychain 校验。
export async function recoverBrowserSession(sessionId, dependencies = {}) {
  const { Bridge: OrderBridge } = await import('../../jushuitan-order-page/src/bridge.js');
  const { loginWithSavedCredentials } = await import('../../xdr-sync-agent/scripts/login-jst-saved.mjs');
  const { refreshAuth } = await import('../../xdr-sync-agent/scripts/refresh-jst-auth.mjs');
  const { createBridge = () => new OrderBridge(), login = loginWithSavedCredentials, refresh = refreshAuth } = dependencies;
  function scopedBridge() {
    const bridge = createBridge();
    const sessions = bridge.sessions.bind(bridge);
    bridge.sessions = async () => (await sessions()).filter(s => s.id === sessionId);
    return bridge;
  }
  await login({ bridge: scopedBridge() });
  await refresh({ bridge: scopedBridge(), recover: async () => {
    throw failure('aftersales_recovery_failed', '自动登录后订单/库存体检仍失败');
  } });
}

export async function fetchAfterSales(date, {
  bridge = new Bridge(), prepare = prepareAfterSale, capture = captureHeaders,
  scrape = scrapeDate, close = closeAfterSale, recover = recoverBrowserSession,
  log = text => console.log('[sync] ' + text),
  sleep = delay,
} = {}) {
  await bridge.findSession();
  const failures = [];
  const expiredSessions = [];
  async function attemptOnce(sessionId) {
    bridge.sessionId = sessionId;
    bridge.tabId = undefined;
    try {
      const targetId = await prepare(bridge);
      const headers = await capture(bridge, targetId);
      log(`专用售后页已初始化，开始验证接口并抓取 browser=${sessionId} tab=${bridge.tabId}`);
      // 成功必须经过真实售后 API；页面已渲染或存在鉴权头都不足以证明有效。
      return await scrape(bridge, targetId, headers, date);
    } finally {
      await close(bridge).catch(() => log('专用售后页关闭失败，将由后续浏览器维护处理'));
    }
  }
  async function attempt(sessionId) {
    for (let n = 1; ; n++) {
      try { return await attemptOnce(sessionId); }
      catch (error) {
        const transient = ['page_changed', 'TAB_NOT_FOUND', 'TARGET_NOT_IN_TAB'].includes(error.code) ||
          /No tab with (?:given )?id|Tab not found|No target with given id|Cannot find context|Execution context was destroyed|No frame with given id/i.test(error.message);
        if (!transient || n >= 3) throw error;
        log(`售后页面丢失，重新建页并完整采集 ${n}/2 browser=${sessionId}`);
        await sleep(n * 500);
      }
    }
  }
  for (const sessionId of bridge._sessionCandidates || [bridge.sessionId]) {
    try { return await attempt(sessionId); }
    catch (error) {
      failures.push(error);
      if (error.code === 'session_expired') expiredSessions.push(sessionId);
      log(`当前浏览器售后读取失败（${error.code || 'browser_error'}），检查其他会话`);
    }
  }
  if (expiredSessions.length) {
    log('新建页面后仍确认登录失效，尝试自动登录一次并校验订单/库存');
    try {
      await recover(expiredSessions[0]);
      const result = await attempt(expiredSessions[0]);
      log('自动恢复完成，售后接口验证通过');
      return result;
    } catch (error) {
      throw failure(error.code || 'aftersales_recovery_failed', `售后登录恢复失败（${error.code || 'unknown'}）`);
    }
  }
  throw failure(failures.at(-1)?.code || 'aftersales_unavailable',
    '所有浏览器售后读取失败：' + failures.map(e => e.message).join(' | '));
}
