import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { prepareAfterSale, closeAfterSale, fetchAfterSales, recoverBrowserSession } from '../src/session.js';
import { scrapeDate } from '../src/sync.js';

function fixture(sessions = ['first']) {
  const events = [];
  const bridge = {
    sessionId: sessions[0], _sessionCandidates: sessions,
    findSession: async () => {},
  };
  return { events, dependencies: {
    bridge,
    prepare: async b => { events.push(['open', b.sessionId]); b.tabId = 'fresh'; return 'frame'; },
    capture: async () => ({ Authorization: 'private-test-token' }),
    scrape: async () => ({ total: 1, rows: [{ afterSaleOrderNo: 'test' }] }),
    close: async b => { events.push(['close', b.sessionId]); b.tabId = undefined; },
    recover: async sid => events.push(['recover', sid]),
    log: text => events.push(['log', text]),
  } };
}
const expired = () => Object.assign(new Error('登录失效'), { code: 'session_expired' });

test('新建 ERP 专用页初始化售后，不复用或关闭已有页面', async () => {
  const calls = [];
  const frame = { src: 'https://www.erp321.com/welcome' };
  const bridge = {
    sessionId: 'chrome', tabId: undefined,
    command: async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'browser_navigate') return { tabId: 123 };
      return {};
    },
    enableChildTargets: async () => {},
    cdp: async method => method === 'DOM.getDocument' ? { root: { nodeId: 1 } }
      : method === 'DOM.querySelectorAll' ? { nodeIds: [2] }
        : { node: { attributes: ['id', 'iframe-welcome-page'], frameId: 'frame' } },
    evaljs: async (expression, target) => {
      assert.equal(bridge.tabId, 123);
      return vm.runInNewContext(expression, target ? {
        location: { pathname: '/afterSales' }, document: { body: { innerText: '售后单号' } },
      } : {
        location: { origin: 'https://www.erp321.com', pathname: '/epaas' },
        document: { getElementById: () => frame },
      });
    },
  };
  assert.equal(await prepareAfterSale(bridge, { sleep: async () => {} }), 'frame');
  assert.equal(calls[0][0], 'browser_navigate');
  assert.equal(calls[0][1].newTab, true);
  assert.match(frame.src, /^https:\/\/innerorder.scm121.com\/afterSales/);
  await closeAfterSale(bridge);
  assert.deepEqual(calls.at(-1), ['browser_close_tab', { tabId: 123 }]);
  assert.equal(bridge.tabId, undefined);
});

test('新页面跳转登录页立即识别失效，不等待渲染超时', async () => {
  const bridge = {
    command: async () => ({ tabId: 123 }), enableChildTargets: async () => {},
    evaljs: async () => JSON.stringify({ login: true, frame: false }),
  };
  await assert.rejects(prepareAfterSale(bridge, { sleep: async () => assert.fail('不应盲等') }), { code: 'session_expired' });
});

test('新页面解决旧 Token 问题时不触发登录，日志不含鉴权头', async () => {
  const f = fixture();
  assert.equal((await fetchAfterSales('2026-10-17', f.dependencies)).total, 1);
  assert.deepEqual(f.events.filter(([name]) => name !== 'log'), [['open', 'first'], ['close', 'first']]);
  assert(!JSON.stringify(f.events).includes('private-test-token'));
});

test('实际售后接口失效才切换浏览器，另一会话成功无需重新登录', async () => {
  const f = fixture(['stale', 'working']);
  f.dependencies.scrape = async bridge => {
    if (bridge.sessionId === 'stale') throw expired();
    return { total: 0, rows: [] };
  };
  assert.deepEqual(await fetchAfterSales('2026-10-17', f.dependencies), { total: 0, rows: [] });
  assert.deepEqual(f.events.filter(([name]) => name !== 'log'), [
    ['open', 'stale'], ['close', 'stale'], ['open', 'working'], ['close', 'working'],
  ]);
});

test('全部会话失效后仅恢复一次同一浏览器，重新建页及抓取后才能成功', async () => {
  const f = fixture(['first', 'second']);
  let restored = false;
  f.dependencies.recover = async sid => { assert.equal(sid, 'first'); restored = true; f.events.push(['recover', sid]); };
  f.dependencies.scrape = async () => { if (!restored) throw expired(); return { total: 1, rows: ['complete'] }; };
  assert.deepEqual(await fetchAfterSales('2026-10-17', f.dependencies), { total: 1, rows: ['complete'] });
  assert.deepEqual(f.events.filter(([name]) => name !== 'log'), [
    ['open', 'first'], ['close', 'first'], ['open', 'second'], ['close', 'second'],
    ['recover', 'first'], ['open', 'first'], ['close', 'first'],
  ]);
});

test('登录后仍失效则失败退出，不循环登录、不返回半份结果', async () => {
  const f = fixture();
  f.dependencies.scrape = async () => { throw expired(); };
  await assert.rejects(fetchAfterSales('2026-10-17', f.dependencies), { code: 'session_expired' });
  assert.equal(f.events.filter(([name]) => name === 'recover').length, 1);
  assert.equal(f.events.filter(([name]) => name === 'close').length, 2);
});

test('网络及页面超时不触发自动登录，仍关闭专用页', async () => {
  for (const code of ['bridge_unavailable', 'aftersales_page_timeout']) {
    const f = fixture();
    f.dependencies.prepare = async b => { b.tabId = 123; throw Object.assign(new Error('timeout'), { code }); };
    await assert.rejects(fetchAfterSales('2026-10-17', f.dependencies), { code });
    assert(!f.events.some(([name]) => name === 'recover'));
    assert(f.events.some(([name]) => name === 'close'));
  }
});

test('验证码/缺少自动填入时保留具体原因，不尝试其他账号登录', async () => {
  const f = fixture();
  f.dependencies.scrape = async () => { throw expired(); };
  f.dependencies.recover = async () => { throw Object.assign(new Error('sensitive page text'), { code: 'login_verification_required' }); };
  await assert.rejects(fetchAfterSales('2026-10-17', f.dependencies), error =>
    error.code === 'login_verification_required' && !error.message.includes('sensitive'));
});

test('计数及分页中途的1006都识别为登录失效，丢弃已抓取部分', async () => {
  for (const responses of [
    [{ code: '1006', message: '失效' }],
    [{ code: '0000', total: 1000 }, { err: 'api', code: 1006, atPage: 2, acc: 500 }],
  ]) {
    const bridge = { evaljs: async () => JSON.stringify(responses.shift()) };
    await assert.rejects(scrapeDate(bridge, 'frame', {}, '2026-10-17'), { code: 'session_expired' });
  }
});

test('恢复登录和Keychain校验限定失败浏览器，不能用其他正常会话替代', async () => {
  const events = [];
  const dependencies = {
    createBridge: () => ({ sessions: async () => [{ id: 'other' }, { id: 'failed' }] }),
    login: async ({ bridge }) => { assert.deepEqual(await bridge.sessions(), [{ id: 'failed' }]); events.push('login'); },
    refresh: async ({ bridge, recover }) => {
      assert.deepEqual(await bridge.sessions(), [{ id: 'failed' }]); events.push('validate');
      await assert.rejects(recover(), { code: 'aftersales_recovery_failed' });
    },
  };
  await recoverBrowserSession('failed', dependencies);
  assert.deepEqual(events, ['login', 'validate']);
});

test('售后页面中途刷新后丢弃该轮结果，新建自己的页面重采，不触发登录', async () => {
  const f=fixture();let runs=0;
  f.dependencies.sleep=async()=>{};
  f.dependencies.scrape=async()=>{
    if(++runs===1)throw Object.assign(new Error('Execution context was destroyed'),{code:'CDP_ERROR'});
    return {total:1,rows:['complete']};
  };
  assert.deepEqual(await fetchAfterSales('2026-10-17',f.dependencies),{total:1,rows:['complete']});
  assert.equal(runs,2);
  assert.deepEqual(f.events.filter(([name])=>name!=='log'),[['open','first'],['close','first'],['open','first'],['close','first']]);
});

test('售后页面连续丢失最多三次，不循环重试', async () => {
  const f=fixture();let runs=0;
  f.dependencies.sleep=async()=>{};
  f.dependencies.scrape=async()=>{runs++;throw Object.assign(new Error('changed'),{code:'page_changed'});};
  await assert.rejects(fetchAfterSales('2026-10-17',f.dependencies),{code:'page_changed'});
  assert.equal(runs,3);
  assert.equal(f.events.filter(([name])=>name==='close').length,3);
});
