const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {diagnose, LOGIN_TEXT} = require('../src/login');

const dashboard = {
  url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  shopNames: ['鹿小鸭香马儿女装专卖店'],
  // Real dashboard recommendation that used to match 选择.{0,4}店铺.
  text: '账号管理\n商品管理\n订单管理\n增加在架商品数量5个\n丰富的商品选择，提升店铺吸引力',
};

test('dashboard recommendations do not block a logged-in shop', () => {
  assert.equal(LOGIN_TEXT.test(dashboard.text), false);
  assert.equal(diagnose('抖店', dashboard, true).ok, true);
  for (const text of ['商品选择，提升店铺吸引力', '丰富的商品选择\n提升店铺吸引力', '选择优质主体，提升商品质量']) {
    assert.equal(LOGIN_TEXT.test(text), false, text);
  }
});

test('real selection, login and verification prompts still block saving', () => {
  for (const prompt of ['选择店铺', '请选择店铺', '请选择登录店铺', '选择要登录的店铺', '请选择您的店铺', '请选择主体', '请选择账号下的主体：', '扫码登录', '登录已失效', '安全验证']) {
    assert.equal(LOGIN_TEXT.test(prompt), true, prompt);
    assert.equal(diagnose('抖店', {...dashboard, text: dashboard.text + '\n' + prompt}, true).ok, false, prompt);
  }
  assert.equal(diagnose('抖店', dashboard, false).ok, false);
  assert.equal(diagnose('抖店', {...dashboard, url: 'https://fxg.jinritemai.com/login/common'}, true).ok, false);
  assert.equal(diagnose('抖店', {...dashboard, url: 'https://example.com/ffa/mshop/homepage/index'}, true).ok, false);
});

async function watcher(snapshot) {
  let tick, cleared = false;
  const saved = [], errors = [], context = {module: {exports: {}}, URL, Date,
    setInterval: fn => {tick = fn; return 1;}, clearInterval: () => {cleared = true;}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/login'), 'utf8'), context);
  const stop = context.module.exports.watchLogin({platform: '抖店',
    windows: () => [{id: 'test-tab', isDestroyed: () => false, webContents: {
      isLoadingMainFrame: () => false,
      executeJavaScript: async script => script.includes('async function shopIdentityApi')
        ? {name: dashboard.shopNames[0], shop_id: '299840356'} : snapshot,
    }}],
    ses: {cookies: {get: async () => [{value: 'test-only'}]}},
    onSuccess: identity => saved.push(identity.name), onError: error => errors.push(error),
  });
  await new Promise(resolve => setImmediate(resolve));
  return {tick, stop, saved, errors, cleared: () => cleared};
}

test('already-scanned dashboard is saved automatically once after three observations', async () => {
  const w = await watcher(dashboard);
  try {
    assert.equal(w.saved.length, 0);
    await w.tick();
    assert.equal(w.saved.length, 0);
    await w.tick();
    await w.tick();
    assert.deepEqual(w.saved, dashboard.shopNames);
    assert.equal(w.cleared(), true);
    assert.equal(w.errors.length, 0);
  } finally {w.stop();}
});

test('a shop selector with cached dashboard content is never saved', async () => {
  const w = await watcher({...dashboard, text: dashboard.text + '\n请选择店铺'});
  try {
    await w.tick(); await w.tick(); await w.tick();
    assert.equal(w.saved.length, 0);
  } finally {w.stop();}
});
