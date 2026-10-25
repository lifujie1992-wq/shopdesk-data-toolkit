const {test} = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/exploration.js'), 'utf8');
function fixture(t, idleMs = 300000) {
  const windows = [], root = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-pool-'));
  const sessions = new Map(); let hook = async () => ({});
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.destroyed = false; this.url = ''; windows.push(this);
      const wc = this.webContents = new EventEmitter();
      wc.session = options.webPreferences.session; wc.id = windows.length;
      wc.debugger = new EventEmitter(); wc.debugger.attach = () => {};
      wc.debugger.sendCommand = (method, params) => hook(wc, method, params);
      wc.getURL = () => this.url; wc.isLoading = () => false; wc.isDestroyed = () => this.destroyed;
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
  }
  Window.prototype.webContents = null;
  // Install this method on each created webContents via a lightweight constructor wrapper.
  class BrowserWindow extends Window { constructor(opts) { super(opts); this.webContents.setWindowOpenHandler = () => {}; } }
  const module = {exports: {}};
  const electron = {app: {getPath: () => root}, BrowserWindow,
    session: {fromPartition: id => { if (!sessions.has(id)) { const s = new EventEmitter(); s.clearStorageData = async () => {}; sessions.set(id, s); } return sessions.get(id); }},
    webContents: {getAllWebContents: () => windows.map(w => w.webContents)}};
  vm.runInNewContext(source, {module, exports: module.exports, URL, Promise, setTimeout, clearTimeout,
    require: name => name === './login' ? {platforms: {'抖店': {hosts: ['fxg.jinritemai.com']}}}
      : name === './finance-extension.cjs' ? require('../src/finance-extension.cjs') : require(name)});
  const pool = module.exports.createExploration({store: {get: id => ({id, platform: '抖店', url: 'https://fxg.jinritemai.com/'})}, electron, idleMs});
  t.after(() => { pool.closeAll(); fs.rmSync(root, {recursive: true, force: true}); });
  return {pool, windows, setHook: value => {hook = value;}};
}
const gate = () => { let release; const promise = new Promise(r => release = r); return {promise, release}; };

test('two independent pages; third fails busy without disturbing either owner', async t => {
  const {pool, windows} = fixture(t);
  const a = pool.start({shop_id: 'a', owner: 'counts'}), b = pool.start({shop_id: 'b', owner: 'finance'});
  assert.notEqual(a.id, b.id); assert.equal(pool.status().active, 2);
  assert.throws(() => pool.start({shop_id: 'c'}), e => e.code === 'EXPLORATION_BUSY');
  assert.throws(() => pool.close(), e => e.code === 'EXPLORATION_ID_REQUIRED');
  assert.throws(() => pool.close({id: 'wrong'}), e => e.code === 'EXPLORATION_NOT_FOUND');
  await pool.close({id: a.id}); assert.equal(windows[0].destroyed, true); assert.equal(windows[1].destroyed, false);
  const c = pool.start({shop_id: 'c'}); assert.equal(pool.status().active, 2);
  await pool.close({id: c.id}); await pool.close({id: b.id}); assert.equal(pool.status().active, 0);
});

test('slow page does not block another; same-page commands and close serialize', async t => {
  const {pool, windows, setHook} = fixture(t); const entered = gate(), resume = gate(); const events = [];
  const a = pool.start({shop_id: 'a'}), b = pool.start({shop_id: 'b'});
  setHook(async (wc, method, params) => {
    if (method !== 'Runtime.evaluate') return {};
    events.push(params.expression);
    if (params.expression === 'slow') { entered.release(); await resume.promise; }
    return {result: {value: wc.id}};
  });
  const slow = pool.command({id: a.id, method: 'Runtime.evaluate', params: {expression: 'slow'}}); await entered.promise;
  const second = pool.command({id: a.id, method: 'Runtime.evaluate', params: {expression: 'second'}});
  const closing = pool.close({id: a.id});
  assert.equal((await pool.command({id: b.id, method: 'Runtime.evaluate', params: {expression: 'other'}})).result.result.value, 2);
  assert.equal(events.includes('second'), false); assert.equal(windows[0].destroyed, false);
  resume.release(); await Promise.all([slow, second, closing]);
  assert.deepEqual(events, ['slow', 'other', 'second']); assert.equal(windows[1].destroyed, false);
});

test('events and finance commands resolve exactly their page id', async t => {
  const {pool, windows} = fixture(t);
  const a = pool.start({shop_id: 'a'}), b = pool.start({shop_id: 'b'});
  windows[0].webContents.debugger.emit('message', {}, 'Network.loadingFinished', {requestId: 'a-only'});
  assert.equal((await pool.command({id: b.id, method: 'events'})).events.length, 0);
  assert.equal((await pool.command({id: a.id, method: 'events'})).events[0].requestId, 'a-only');
  assert.equal((await pool.command({id: a.id, method: 'finance_capabilities'})).owned_close, true);
  await pool.command({id: a.id, method: 'finance_close'});
  assert.equal(pool.status().active, 1); assert.equal(windows[1].destroyed, false);
  assert.equal((await pool.command({id: b.id, method: 'finance_capabilities'})).owned_close, true);
});

test('renderer closure releases only its own slot', async t => {
  const {pool, windows} = fixture(t, 1000);
  const a = pool.start({shop_id: 'a'}), b = pool.start({shop_id: 'b'});
  windows[0].destroy(); assert.equal(pool.status().active, 1);
  assert.equal(pool.status().pages[0].id, b.id);
  assert.throws(() => pool.command({id: a.id, method: 'events'}), e => e.code === 'EXPLORATION_NOT_FOUND');
});

 test('idle expiry only releases the expired page', t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const {pool} = fixture(t, 1000);
  pool.start({shop_id: 'a'}); t.mock.timers.tick(600);
  const b = pool.start({shop_id: 'b'}); t.mock.timers.tick(401);
  assert.equal(pool.status().active, 1); assert.equal(pool.status().pages[0].id, b.id);
 });
 test('HTTP exploration requests bypass unrelated slow calls and preserve busy error codes', async t => {
  const {startAgentAPI} = require('../src/agent-api');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exploration-api-'));
  const stateFile = path.join(root, 'bridge.json'), entered = gate(), resume = gate();
  const api = await startAgentAPI({stateFile, dispatch: async method => {
    if (method === 'slow') {entered.release(); await resume.promise; return 'done';}
    if (method === 'start_exploration') throw Object.assign(Error('full'), {code: 'EXPLORATION_BUSY'});
    return 'available';
  }});
  t.after(() => {resume.release(); api.close(); fs.rmSync(root, {recursive:true, force:true});});
  const {port,token} = JSON.parse(fs.readFileSync(stateFile));
  const call = async method => (await fetch(`http://127.0.0.1:${port}/call`, {
    method:'POST', headers:{Authorization:'Bearer '+token}, body:JSON.stringify({method}), signal:AbortSignal.timeout(2000)
  })).json();
  const slow = call('slow'); await entered.promise;
  assert.equal((await call('exploration_status')).result, 'available');
  assert.equal((await call('start_exploration')).code, 'EXPLORATION_BUSY');
  resume.release(); await slow;
 });
