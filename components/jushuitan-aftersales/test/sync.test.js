import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/sync.js';

function bridgeWithTabs(sessions) {
  const bridge = new Bridge();
  bridge.health = async () => ({ connectedSessions: Object.keys(sessions) });
  bridge.command = async (tool, args, sessionId) => {
    assert.equal(tool, 'browser_list_tabs');
    return { tabs: sessions[sessionId], capabilities: { tabRouting: 1 } };
  };
  return bridge;
}

test('少量业务标签优先于大量登录页及残留售后页', async () => {
  const bridge = bridgeWithTabs({
    loggedOut: [
      ...Array.from({ length: 15 }, () => ({ url: 'https://www.erp321.com/login.aspx' })),
      { url: 'https://innerorder.scm121.com/afterSales' },
    ],
    loggedIn: [{ url: 'https://www.erp321.com/app/order/order/list.aspx' }],
  });
  assert.equal(await bridge.findSession(), 'loggedIn');
});

test('首选浏览器无法进入 ERP 时自动切换其他会话', async () => {
  const bridge = bridgeWithTabs({
    stale: [{ url: 'https://www.erp321.com/epaas' }],
    working: [{ url: 'https://www.erp321.com/app/order/order/list.aspx' }],
  });
  await bridge.findSession();
  const visited = [];
  bridge._findEpaasTabInSession = async () => {
    visited.push(bridge.sessionId);
    if (bridge.sessionId === 'stale') throw new Error('ERP 登录过期');
    return { tab: { tabId: 42 }, childTargets: true };
  };
  assert.equal((await bridge.findEpaasTab()).tab.tabId, 42);
  assert.equal(bridge.sessionId, 'working');
  assert.deepEqual(visited, ['stale', 'working']);
});

test('全部会话不可用时明确失败，保留各次错误', async () => {
  const bridge = bridgeWithTabs({
    first: [{ url: 'https://www.erp321.com/epaas' }],
    second: [{ url: 'https://www.erp321.com/app/order/order/list.aspx' }],
  });
  await bridge.findSession();
  bridge._findEpaasTabInSession = async () => { throw new Error(bridge.sessionId + ' 登录过期'); };
  await assert.rejects(bridge.findEpaasTab(), /first 登录过期.*second 登录过期/);
});

test('无 ERP 会话时不误选名称近似的网站', async () => {
  const bridge = bridgeWithTabs({
    unrelated: [{ url: 'https://www.erp321.com.example.org/epaas' }],
  });
  await assert.rejects(bridge.findSession(), /未找到承载聚水潭 ERP/);
});

test('选择页面后命令绑定该标签页，错误类别保留以便页面恢复', async t => {
  const bodies=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    return {json:async()=>body.toolName==='browser_select_tab'?{data:{tabId:42}}:
      body.args.method==='Page.reload'?{error:{code:'TARGET_NOT_IN_TAB',message:'stale frame'}}:{data:{}}};
  });
  const bridge=new Bridge({task:'jst-refund-daily'});
  await bridge.command('browser_select_tab',{tabId:42},'chrome');
  bridge.sessionId='chrome';await bridge.cdp('DOM.getDocument');
  assert.equal(bodies.at(-1).args.tabId,42);
  assert.equal(bodies.at(-1).args.sessionId,'jst-refund-daily');
  await assert.rejects(bridge.cdp('Page.reload'),{code:'TARGET_NOT_IN_TAB'});
});

test('旧扩展不会被作为售后采集的回退目标',async()=>{
  const bridge=new Bridge();bridge.health=async()=>({connectedSessions:['old']});
  bridge.command=async()=>({tabs:[{url:'https://www.erp321.com/epaas'}]});
  await assert.rejects(bridge.findSession(),{code:'tab_routing_required'});
});
