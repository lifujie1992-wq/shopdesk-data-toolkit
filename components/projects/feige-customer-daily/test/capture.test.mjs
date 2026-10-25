import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { yesterday, parseJson, flatten, formatDuration, CaptureError, safeError } from '../lib/common.mjs';
import { fetchShop, requestPage, cookieHeader } from '../lib/source.mjs';
import { openStore, saveShop, csvCell } from '../lib/store.mjs';
import { run, parseArgs, acquireLock } from '../collect.mjs';
import { DatabaseSync } from 'node:sqlite';

const shop = {id: 'shop-1', name: '测试店'};
const row = id => ({staffUserInfo: {staffId: id, staffNickName: '客服', staffAccountName: '账号'}, staffName: '客服', rank: 1,
  servConvCnt: 8, servUserCnt: 6, validCommentCnt: 2, workTimeAvgRespDuration: {fieldValue: '6秒', isAlert: true}});
const page = (ids, total) => ({total, staffDataModel: ids.map(row), shopSumDetailModel: {servConvCnt: 8},
  shopAvgDetailModel: {servConvCnt: '4.00'}, staffCoreDataModel: {avgOnlineInfo: {index_value: '28986'}}});
const snapshot = () => ({shop, date: '2026-10-16', rows: [row('7695647379231383083')], total: 1,
  sum: {servConvCnt: 8}, average: {servConvCnt: '4.00'}, core: {}, fetchedAt: '2026-10-18T00:00:00Z'});
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'feige-test-'));

test('昨天使用上海自然日，保留19位ID精度、百分比/时长/预警及原始缺失值', () => {
  assert.equal(yesterday(new Date('2026-10-17T16:05:00Z')), '2026-10-17');
  assert.equal(yesterday(new Date('2026-01-01T01:00:00Z')), '2025-12-31');
  assert.equal(parseJson('{"id":7695647379231383083}').id, '7695647379231383083');
  assert.deepEqual(flatten({rate: '22.22%', missing: '-', time: {fieldValue: '6秒', isAlert: true}}),
    {rate: '22.22%', missing: '-', time: '6秒', time__isAlert: true});
  assert.equal(formatDuration('28986'), '08时03分06秒');
  assert.equal(formatDuration('22808'), '06时20分08秒');
});

test('完整翻页而非只取前20条，空店必须明确total=0', async () => {
  const calls = [];
  const result = await fetchShop(shop, '2026-10-16', {getCookie: () => 'private', getPage: async (_c, date, p) => {
    calls.push([date, p]); return p === 1 ? page(Array.from({length: 20}, (_, i) => String(i)), 28) : page(Array.from({length: 8}, (_, i) => String(i + 20)), 28);
  }});
  assert.equal(result.rows.length, 28);
  assert.deepEqual(calls, [['2026-10-16', 1], ['2026-10-16', 2]]);
  const empty = await fetchShop(shop, '2026-10-16', {getCookie: () => 'private', getPage: async () => page([], 0)});
  assert.equal(empty.total, 0);
});

test('重复分页、总数变化、缺失总数均拒绝部分结果', async () => {
  for (const pages of [[page(['1'], 2), page(['1'], 2)], [page(['1'], 2), page(['2'], 3)], [{staffDataModel: []}]]) {
    let index = 0;
    await assert.rejects(fetchShop(shop, '2026-10-16', {getCookie: () => 'private', getPage: async () => pages[index++]}), CaptureError);
  }
});

test('读取接口按已验证日期/分页参数请求；403不重试，200业务失败不当成功', async () => {
  let calls = 0;
  await assert.rejects(requestPage('secret', '2026-10-16', 2, {sleep: async () => {}, fetchImpl: async (url, options) => {
    calls++; assert.equal(url.searchParams.get('startTime'), '20261016'); assert.equal(url.searchParams.get('page'), '2');
    assert.equal(options.redirect, 'manual'); return new Response('', {status: 403});
  }}), {code: 'login_or_permission'});
  assert.equal(calls, 1);
  await assert.rejects(requestPage('secret', '2026-10-16', 1, {fetchImpl: async () => Response.json({code: 1, msg: '无权限'})}), {code: 'permission_denied'});
});

test('HTTP 200业务临时失败有限重试，成功后仍校验完整客服分页', async () => {
  let calls = 0;
  const sleeps = [];
  const snapshot = await fetchShop(shop, '2026-10-16', {getCookie: () => 'secret',
    getPage: (cookie, date, p) => requestPage(cookie, date, p, {sleep: async ms => sleeps.push(ms),
      fetchImpl: async () => ++calls < 3 ? Response.json({code: 1001, msg: '系统繁忙'}) :
        Response.json({code: 0, data: page(['1'], 1)})})});
  assert.equal(snapshot.rows.length, 1);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('持久业务失败记录安全错误码、页号和次数；登录/权限/验证不重试', async () => {
  let calls = 0;
  await assert.rejects(requestPage('secret', '2026-10-16', 2, {sleep: async () => {},
    fetchImpl: async () => { calls++; return Response.json({code: 1001, msg: 'unknown secret', token: 'secret'}); }}), error => {
      const safe = safeError(error);
      assert.deepEqual({http_status: safe.http_status, platform_code: safe.platform_code, page: safe.page, attempts: safe.attempts},
        {http_status: 200, platform_code: '1001', page: 2, attempts: 3});
      assert(!JSON.stringify(safe).includes('secret'));
      return error.code === 'platform_error';
    });
  assert.equal(calls, 3);
  for (const [msg, code] of [['登录失效', 'login_expired'], ['无权限', 'permission_denied'], ['需要验证码', 'verification_required']]) {
    calls = 0;
    await assert.rejects(requestPage('secret', '2026-10-16', 1, {sleep: async () => assert.fail('must not retry'),
      fetchImpl: async () => { calls++; return Response.json({code: 1, msg}); }}), {code});
    assert.equal(calls, 1);
  }
});

test('429退避遵从有上限的Retry-After，重试耗尽保留HTTP错误', async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(requestPage('secret', '2026-10-16', 1, {sleep: async ms => sleeps.push(ms),
    fetchImpl: async () => { calls++; return new Response('', {status: 429, headers: {'retry-after': '120'}}); }}),
    error => error.code === 'http_error' && safeError(error).http_status === 429 && safeError(error).attempts === 3);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10000, 10000]);
});

test('只复制读取匹配域名和有效Cookie，不修改原店铺登录库', () => {
  const dir = temp();
  try {
    const part = path.join(dir, 'Partitions/shop-shop-1'); fs.mkdirSync(part, {recursive: true});
    const file = path.join(part, 'Cookies'), db = new DatabaseSync(file);
    db.exec('CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,path TEXT,is_secure INTEGER,expires_utc INTEGER)');
    const insert = db.prepare('INSERT INTO cookies VALUES(?,?,?,?,?,?)');
    insert.run('.jinritemai.com', 'sessionid', 'valid', '/', 1, 0);
    insert.run('eviljinritemai.com', 'wrong', 'wrong', '/', 1, 0);
    insert.run('.jinritemai.com', 'expired', 'wrong', '/', 1, 1);
    db.close(); const before = fs.readFileSync(file);
    assert.equal(cookieHeader(dir, 'shop-1'), 'sessionid=valid');
    assert.deepEqual(fs.readFileSync(file), before);
    assert.throws(() => cookieHeader(dir, '../bad'), {code: 'invalid_shop'});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('同日重跑不重复；单店失败保留旧数据，其他店成功并发一条汇总告警', async () => {
  const dir = temp();
  try {
    const db = openStore(dir);
    saveShop(db, snapshot(), 'old'); saveShop(db, snapshot(), 'old-again');
    assert.equal(db.prepare('SELECT count(*) AS n FROM staff_daily').get().n, 1); db.close();
    let alerts = 0;
    const other = {id: 'shop-2', name: '第二店'};
    const result = await run({outputDir: dir, date: '2026-10-16', notify: true}, {
      shops: [shop, other], collectShop: async s => {
        if (s.id === shop.id) throw new CaptureError('login_expired', '登录失效');
        return {...snapshot(), shop: s};
      }, alert: async event => { alerts++; assert.match(event.reason, /测试店/); return {sent: true}; },
      log: () => {}, logFile: path.join(dir, 'run.jsonl'),
    });
    assert.equal(result.status, 'partial_failed'); assert.equal(alerts, 1);
    const current = openStore(dir);
    assert.equal(current.prepare('SELECT run_id FROM staff_daily WHERE shop_id=?').get(shop.id).run_id, 'old-again');
    assert.equal(current.prepare('SELECT count(*) AS n FROM staff_daily').get().n, 2); current.close();
    assert(!fs.existsSync(path.join(dir, 'capture.lock')));
    assert(fs.readFileSync(path.join(dir, '2026-10-16/customer-performance.csv'), 'utf8').includes("'7695647379231383083"));
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('锁阻止重复运行；危险CSV文本被转为文本，日期和参数严格校验', () => {
  const dir = temp();
  try {
    const release = acquireLock(dir); assert.throws(() => acquireLock(dir), {code: 'already_running'}); release();
    assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell('-'), '"-"'); assert.equal(csvCell('22.22%'), '"22.22%"');
    assert.throws(() => parseArgs(['--date', '2026-02-30']), {code: 'invalid_date'});
    assert.throws(() => parseArgs(['--unknown']), {code: 'unknown_argument'});
    assert.equal(parseArgs(['--help']).help, true);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
