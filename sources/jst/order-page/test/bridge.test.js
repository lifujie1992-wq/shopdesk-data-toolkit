import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, ORDER_PAGE_URL } from '../src/bridge.js';

test('多浏览器中跳过失效页，后续命令固定在可用连接和标签页', async () => {
  const bridge = new Bridge();
  bridge.sessions = async () => [
    { id: 'stale', tabs: [{ tabId: 1, url: ORDER_PAGE_URL }] },
    { id: 'working', tabs: [{ tabId: 2, url: ORDER_PAGE_URL }] },
  ];
  bridge.evaluate = async () => ({ ready: bridge.browserSessionId === 'working' });
  const requests = [];
  bridge.request = async (path, body) => { requests.push(body); return {}; };
  await bridge.connect();
  assert.equal(bridge.browserSessionId, 'working');
  assert.equal(bridge.tabId, 2);
  await bridge.command('browser_evaluate', { expression: '0' });
  assert.equal(requests.at(-1).sessionId, 'working');
  assert.equal(requests.at(-1).args.sessionId, 'jst-order-page');
  assert.equal(requests.at(-1).args.tabId, 2);
});

test('登录页 refer 中包含订单地址也不能被当成有效订单页', async () => {
  const bridge = new Bridge();
  bridge.sessions = async () => [{ id: 'stale', tabs: [{ tabId: 1, url: 'https://www.erp321.com/login.aspx?refer=/app/order/order/list.aspx' }] }];
  bridge.command = async () => { throw new Error('不应尝试附着登录页'); };
  await assert.rejects(bridge.connect(), error => error.code === 'order_page_required');
});

test('刷新不导航用户的 ERP 页，失败时只关闭自己新建的页面', async () => {
  const bridge = new Bridge();
  bridge.sessions = async () => [
    { id: 'stale', tabs: [{ tabId: 11, url: ORDER_PAGE_URL }] },
    { id: 'working', tabs: [{ tabId: 12, url: ORDER_PAGE_URL }] },
  ];
  const navigations = [], closed = [];
  bridge.command = async (tool, args) => {
    if (tool === 'browser_navigate') {
      navigations.push(args);
      return { tabId: bridge.browserSessionId === 'stale' ? 101 : 102 };
    }
    if (tool === 'browser_close_tab') closed.push(args.tabId);
    return {};
  };
  bridge.evaluate = async () => ({ ready: bridge.browserSessionId === 'working', login: bridge.browserSessionId === 'stale' });
  await bridge.refresh();
  assert(navigations.every(args => args.newTab === true));
  assert.deepEqual(closed, [101]);
  assert.equal(bridge.tabId, 102);
});

test('专用任务只使用自己的页面，并在后台新建，不复用售后和用户页面', async () => {
  const bridge = new Bridge({ session: 'jst-paid-orders' });
  bridge.sessions = async () => [{ id:'working', tabs:[
    {tabId:1,url:ORDER_PAGE_URL,ownerSessionId:'jst-aftersale-sync'},
    {tabId:2,url:ORDER_PAGE_URL},
  ] }];
  const requests=[];
  bridge.command=async(tool,args)=>{requests.push([tool,args]);return {tabId:3};};
  bridge.evaluate=async()=>({ready:true});
  await bridge.connect({dedicated:true});
  assert.equal(bridge.tabId,3);
  assert.equal(requests[0][0],'browser_navigate');
  assert.equal(requests[0][1].newTab,true);
  assert.equal(requests[0][1].activate,false);
});

test('页面丢失后限定原浏览器恢复并重跑；超过三次或业务错误立即失败', async () => {
  const bridge=new Bridge({session:'jst-paid-orders'});bridge.browserSessionId='original';bridge.tabId=123;
  let refreshes=0,runs=0;const events=[];
  bridge.refresh=async options=>{assert.equal(options.browserSessionId,'original');refreshes++;};
  const opts={sleep:async()=>{},onRetry:e=>events.push(e)};
  assert.equal(await bridge.withPageRecovery(async()=>{if(++runs<3)throw Object.assign(new Error('changed'),{code:'page_changed'});return 'complete';},opts),'complete');
  assert.equal(refreshes,2);assert.equal(events[0].tabId,123);
  runs=0;
  await assert.rejects(bridge.withPageRecovery(async()=>{runs++;throw Object.assign(new Error('changed'),{code:'page_changed'});},opts),{code:'page_changed'});
  assert.equal(runs,3);
  runs=0;
  await assert.rejects(bridge.withPageRecovery(async()=>{runs++;throw Object.assign(new Error('expired'),{code:'session_expired'});},opts),{code:'session_expired'});
  assert.equal(runs,1);
});

test('忽略没有隔离能力的旧扩展，全部未更新时明确失败', async () => {
  const bridge=new Bridge();
  bridge.request=async(path,body)=>path==='/health'?{ok:true,connectedSessions:['old','new'],enabledTools:['browser_evaluate']}:
    {tabs:[{tabId:body.sessionId==='old'?1:2,url:ORDER_PAGE_URL}],...(body.sessionId==='new'?{capabilities:{tabRouting:1}}:{})};
  assert.deepEqual((await bridge.sessions()).map(x=>x.id),['new']);
  bridge.request=async(path)=>path==='/health'?{ok:true,connectedSessions:['old'],enabledTools:['browser_evaluate']}:{tabs:[]};
  await assert.rejects(bridge.sessions(),{code:'tab_routing_required'});
});
