import test from 'node:test';
import assert from 'node:assert/strict';
import { loginWithSavedCredentials } from '../login-jst-saved.mjs';

function fixture(options = {}) {
  let time = 0, focused = false, checked = !!options.checked, submitted = false, reminderConfirmed = false;
  const calls = [];
  const bridge = {
    sessions: async () => [{ id: 'chrome', tabs: [{ url: 'https://www.erp321.com/login.aspx' }] }],
    command: async (tool, args) => {
      calls.push([tool, args]);
      if (tool === 'browser_navigate') return { tabId: 123 };
      if (tool === 'browser_click') {
        if (args.selector === '#login_id') focused = true;
        if (args.selector.includes('agreement')) checked = true;
        if (args.selector.includes('submit')) submitted = true;
        if (args.selector.includes('password-reminder')) reminderConfirmed = true;
      }
      return {};
    },
    evaluate: async () => {
      if (options.wrongOrigin) return { login: false, authenticatedPage: false };
      if (submitted && options.passwordReminder && !reminderConfirmed) return { login: true, passwordReminder: true };
      if (submitted && !options.rejected) return { login: false, authenticatedPage: true };
      return { login: true, accountPresent: true, accountFilled: focused && !options.missingAutofill,
        passwordFilled: focused && !options.missingAutofill, agreementPresent: true,
        agreementChecked: checked, submitPresent: true, challenge: !!options.challenge };
    },
  };
  return { calls, dependencies: { bridge, sleep: async ms => { time += ms; }, now: () => time,
    autofillTimeoutMs: 500, loginTimeoutMs: 500 } };
}

test('触发浏览器自动填入后勾选协议，提交一次并关闭专用页', async () => {
  const f = fixture();
  assert.deepEqual(await loginWithSavedCredentials(f.dependencies), { submitted: true });
  assert.deepEqual(f.calls.filter(([tool]) => tool === 'browser_click').map(([, args]) => args.selector),
    ['#login_id', '[data-xdr-login-agreement="1"]', '[data-xdr-login-submit="1"]']);
  assert.deepEqual(f.calls.at(-1), ['browser_close_tab', { tabId: 123 }]);
});

test('协议已勾选时不重复点击取消勾选', async () => {
  const f = fixture({ checked: true });
  await loginWithSavedCredentials(f.dependencies);
  assert(!f.calls.some(([, args]) => args.selector?.includes('agreement')));
});

test('浏览器未填入密码时不提交空表单', async () => {
  const f = fixture({ missingAutofill: true });
  await assert.rejects(loginWithSavedCredentials(f.dependencies), { code: 'saved_login_autofill_missing' });
  assert(!f.calls.some(([, args]) => args.selector?.includes('submit')));
  assert.equal(f.calls.at(-1)[0], 'browser_close_tab');
});

test('验证码或额外验证阻止自动提交', async () => {
  const f = fixture({ challenge: true });
  await assert.rejects(loginWithSavedCredentials(f.dependencies), { code: 'login_verification_required' });
  assert(!f.calls.some(([, args]) => args.selector?.includes('submit')));
});

test('不在聚水潭指定登录域时不点击表单', async () => {
  const f = fixture({ wrongOrigin: true });
  await assert.rejects(loginWithSavedCredentials(f.dependencies), { code: 'saved_login_origin_mismatch' });
  assert(!f.calls.some(([tool]) => tool === 'browser_click'));
});

test('登录按钮接受点击仍停留登录页时不能判成功，也不重复提交', async () => {
  const f = fixture({ rejected: true });
  await assert.rejects(loginWithSavedCredentials(f.dependencies), { code: 'saved_login_failed' });
  assert.equal(f.calls.filter(([, args]) => args.selector?.includes('submit')).length, 1);
});

test('确认已观察到的密码长期未修改提醒后继续验证跳转，不修改密码', async () => {
  const f = fixture({ passwordReminder: true });
  assert.deepEqual(await loginWithSavedCredentials(f.dependencies), { submitted: true });
  assert.equal(f.calls.filter(([, args]) => args.selector?.includes('password-reminder')).length, 1);
});
