import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAuth } from '../refresh-jst-auth.mjs';

function fixture() {
  let stored;
  const events = [];
  return {
    events,
    dependencies: {
      bridge: {
        refresh: async () => events.push('refresh'),
        run: async () => ({ logged_in: true }),
        command: async (tool, args) => {
          assert.equal(tool, 'browser_cdp');
          assert.deepEqual(args.params.urls, ['https://api.erp321.com/']);
          return { cookies: [
            { name: 'u_sso_token', value: 'test-token', expires: 1900000000 },
            { name: 'u_id', value: 'test-user', expires: 1900000000 },
            { name: 'u_co_id', value: 'test-company', expires: 1900000000 },
            { name: 'unrelated', value: 'must-not-save', expires: 1900000000 },
          ] };
        },
      },
      validate: async () => events.push('validate'),
      save: session => { events.push('save'); stored = session; },
      load: () => { events.push('load'); return stored; },
      recover: async () => { events.push('recover'); return { submitted: true }; },
    },
    stored: () => stored,
  };
}

test('验证浏览器及 API 后保存，再读取 Keychain 复查；保留真实到期时间', async () => {
  const f = fixture();
  const result = await refreshAuth(f.dependencies);
  assert.deepEqual(f.events, ['refresh', 'validate', 'save', 'load', 'validate']);
  assert.equal(result.inventory, true);
  assert.equal(result.order_page, true);
  assert.equal(result.expires_at, new Date(1900000000000).toISOString());
  assert.equal(f.stored().cookies.length, 3);
  assert(!JSON.stringify(result).includes('test-token'));
});

test('无效浏览器凭据不能覆盖已存 Keychain', async () => {
  const f = fixture();
  f.dependencies.validate = async () => { throw new Error('expired'); };
  await assert.rejects(refreshAuth(f.dependencies), /expired/);
  assert.equal(f.stored(), undefined);
});

test('持久化后体检失败不能返回刷新成功', async () => {
  const f = fixture();
  let count = 0;
  f.dependencies.validate = async () => { if (++count === 2) throw new Error('stored-session-invalid'); };
  await assert.rejects(refreshAuth(f.dependencies), /stored-session-invalid/);
});

test('订单读取失败时不能回灌 Keychain', async () => {
  const f = fixture();
  f.dependencies.bridge.run = async () => ({ logged_in: false });
  await assert.rejects(refreshAuth(f.dependencies), /order_check_failed/);
  assert.equal(f.stored(), undefined);
});

test('登录失效后自动登录一次，重新验证后才回灌Keychain', async () => {
  const f = fixture();
  let attempts = 0;
  f.dependencies.bridge.refresh = async () => {
    f.events.push('refresh');
    if (++attempts === 1) throw Object.assign(new Error('expired'), { code: 'not_logged_in' });
  };
  const result = await refreshAuth(f.dependencies);
  assert.equal(result.auto_login, true);
  assert.deepEqual(f.events, ['refresh', 'recover', 'refresh', 'validate', 'save', 'load', 'validate']);
});

test('网络故障不触发自动登录，额外验证失败不覆盖Keychain', async () => {
  const f = fixture();
  f.dependencies.bridge.refresh = async () => { throw Object.assign(new Error('offline'), { code: 'bridge_unavailable' }); };
  await assert.rejects(refreshAuth(f.dependencies), /offline/);
  assert(!f.events.includes('recover'));
  f.dependencies.bridge.refresh = async () => { throw Object.assign(new Error('expired'), { code: 'not_logged_in' }); };
  f.dependencies.recover = async () => { throw Object.assign(new Error('verify'), { code: 'login_verification_required' }); };
  await assert.rejects(refreshAuth(f.dependencies), /verify/);
  assert.equal(f.stored(), undefined);
});
