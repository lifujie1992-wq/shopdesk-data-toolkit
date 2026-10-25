import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactUrl, redactMessage, sanitizeLog } from '../redact.mjs';

test('redactUrl 去 query 和 hash', () => {
  const u = 'https://host/path/file.pdf?lk3s=abc&x-signature=XYZ#frag';
  assert.equal(redactUrl(u), 'https://host/path/file.pdf');
});

test('redactMessage 去掉内嵌 URL 的签名 query 并截断', () => {
  const s = '失败 url=https://host/k?x-signature=SECRET 详情';
  const out = redactMessage(s);
  assert.ok(!out.includes('x-signature=SECRET'));
  assert.ok(out.includes('https://host/k'));
});

test('sanitizeLog 丢弃敏感字段名', () => {
  const rec = { token: 'abc', workerToken: 'xyz', a_bogus: 'sign', shop_order_id: '123', msg: 'ok' };
  const out = sanitizeLog(rec);
  assert.equal(out.token, undefined);
  assert.equal(out.workerToken, undefined);
  assert.equal(out.a_bogus, undefined);
  assert.equal(out.shop_order_id, '123');
  assert.equal(out.msg, 'ok');
});
