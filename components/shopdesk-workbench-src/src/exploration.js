const {randomUUID} = require('node:crypto');
const {platforms} = require('./login');

// A bounded pool for this API only. Other ShopDesk windows retain their own lifecycle.
function createExploration({store, maxPages = 2, idleMs = 300000, electron = require('electron')}) {
  const {BrowserWindow, session, webContents, app} = electron;
  const pages = new Map();
  const finance = require('./finance-extension.cjs').createFinanceExtension({
    app, current: id => pages.get(id), safeURL, close: ({id}) => closeNow(id),
  });
  function fail(code, message) { throw Object.assign(new Error(message), {code}); }
  function safeURL(url, shop) {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.username || u.password || !platforms[shop.platform]?.hosts.includes(u.hostname))
      throw Error('仅能进入所选平台官方后台');
    return u.href;
  }
  function scrubURL(url) {
    try {
      const u = new URL(url);
      for (const key of [...u.searchParams.keys()]) if (/token|cookie|signature|bogus|verify|authorization/i.test(key)) u.searchParams.delete(key);
      return u.href;
    } catch { return ''; }
  }
  function scrub(value) {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !/cookie|token|authorization|password|signature|bogus/i.test(key)).map(([key, child]) => [key, scrub(child)]));
    return value;
  }
  function owned(id) {
    if (typeof id !== 'string' || !id) fail('EXPLORATION_ID_REQUIRED', '必须指定本任务的后台页面 id');
    const page = pages.get(id);
    if (!page) fail('EXPLORATION_NOT_FOUND', '后台探索已关闭或过期');
    return page;
  }
  function closeNow(id, destroy = true) {
    const page = pages.get(id);
    if (!page) return {id, closed: false};
    pages.delete(id);
    clearTimeout(page.timer);
    finance.cleanup(id);
    const w = page.window, ses = w.webContents.session;
    if (destroy && !w.isDestroyed()) w.destroy();
    const cleanup = setTimeout(() => {
      if (!webContents.getAllWebContents().some(wc => !wc.isDestroyed() && wc.session === ses))
        ses.clearStorageData({storages: ['serviceworkers']}).catch(() => {});
    }, 200);
    cleanup.unref?.();
    return {id, closed: true};
  }
  function touch(page) {
    clearTimeout(page.timer);
    page.timer = setTimeout(() => closeNow(page.id), idleMs);
    page.timer.unref?.();
  }
  function serial(id, work) {
    const page = owned(id);
    const pending = page.queue.catch(() => {}).then(() => {
      owned(id); touch(page); return work(page);
    });
    page.queue = pending;
    return pending;
  }
  function close({id} = {}) {
    // An absent ID must never mean 'close whichever task currently owns a page'.
    owned(id);
    return serial(id, () => closeNow(id));
  }
  function closeAll() { for (const id of [...pages.keys()]) closeNow(id); }
  function status() {
    return {version: 2, capacity: maxPages, active: pages.size,
      pages: [...pages.values()].map(p => ({id: p.id, owner: p.owner, shop_id: p.shop.id}))};
  }
  function start({shop_id, url, owner = 'legacy'} = {}) {
    if (pages.size >= maxPages) fail('EXPLORATION_BUSY', `后台探索页面名额已满（${maxPages}个），请等待重试`);
    const shop = store.get(shop_id), target = safeURL(url || shop.url, shop);
    const ses = session.fromPartition('persist:shop-' + shop_id);
    const w = new BrowserWindow({show: false, width: 1280, height: 900,
      webPreferences: {session: ses, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false}});
    try { w.webContents.debugger.attach('1.3'); }
    catch (error) { w.destroy(); throw error; }
    const id = randomUUID(), page = {id, owner: String(owner).slice(0, 80), shop, window: w, events: [], queue: Promise.resolve()};
    pages.set(id, page); touch(page);
    w.once('closed', () => closeNow(id, false));
    w.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    for (const event of ['will-navigate', 'will-redirect']) w.webContents.on(event, (e, u) => { try { safeURL(u, shop); } catch { e.preventDefault(); } });
    w.webContents.debugger.on('message', (_event, method, params) => {
      if (!pages.has(id)) return;
      let row;
      if (method === 'Network.requestWillBeSent') {
        const r = params.request; let body;
        try { body = scrub(JSON.parse(r.postData || 'null')); } catch { body = r.postData ? '[非 JSON 请求体]' : undefined; }
        row = {method, requestId: params.requestId, url: scrubURL(r.url), httpMethod: r.method, body};
      } else if (method === 'Network.responseReceived') row = {method, requestId: params.requestId,
        url: scrubURL(params.response.url), status: params.response.status, mimeType: params.response.mimeType};
      else if (method === 'Network.loadingFinished') row = {method, requestId: params.requestId};
      if (row) { page.events.push(row); page.events = page.events.slice(-200); }
    });
    w.loadURL('about:blank').then(() => w.webContents.debugger.sendCommand('Network.enable'))
      .then(() => { if (pages.has(id)) return w.loadURL(target); }).catch(() => {});
    return {id, shop_id, status: 'loading', pool_version: 2, content_is_untrusted: true};
  }
  function command({id, method, params = {}} = {}) {
    return serial(id, async page => {
      const wc = page.window.webContents;
      if (method === 'events') return {events: page.events.splice(0), loading: wc.isLoading(), url: scrubURL(wc.getURL()), content_is_untrusted: true};
      if (typeof method === 'string' && method.startsWith('finance_')) return finance.command(id, method, params);
      const allowed = ['Page.navigate', 'Page.reload', 'Runtime.evaluate', 'DOM.getDocument', 'DOM.querySelector',
        'DOM.querySelectorAll', 'DOM.getOuterHTML', 'Network.getResponseBody'];
      if (!allowed.includes(method)) throw Error('该 CDP 能力未开放');
      if (method === 'Page.navigate') params = {url: safeURL(params.url, page.shop)};
      if (method === 'Runtime.evaluate') params = {expression: params.expression, returnByValue: true, awaitPromise: true, timeout: 10000};
      let deadline;
      const result = await Promise.race([wc.debugger.sendCommand(method, params), new Promise((_, reject) => {
        deadline = setTimeout(() => reject(Error('后台探索命令超时，请等待页面加载后重试')), 15000);
      })]).finally(() => clearTimeout(deadline));
      if (method === 'Network.getResponseBody' && !result.base64Encoded) { try { result.body = JSON.stringify(scrub(JSON.parse(result.body))); } catch {} }
      if (JSON.stringify(result).length > 2e6) throw Error('返回内容过大，请缩小查询');
      return {result, content_is_untrusted: true};
    });
  }
  return {start, command, close, closeAll, status};
}
module.exports = {createExploration};
