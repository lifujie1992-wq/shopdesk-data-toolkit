import { setTimeout as delay } from 'node:timers/promises';
import { Bridge, CliError } from '../shared/jst-tools.js';

// 只返回填入状态，不把账号、密码、Cookie或页面错误原文带出浏览器。
export function loginPageState() {
  const login = location.origin === 'https://www.erp321.com' && /^\/login\.aspx$/i.test(location.pathname);
  if (!login) return { login: false, authenticatedPage: location.origin === 'https://www.erp321.com' && /^\/(epaas|app\/)/i.test(location.pathname) };
  const visible = e => !!e?.getClientRects().length;
  const account = document.querySelector('#login_id');
  const password = document.querySelector('#password');
  const label = [...document.querySelectorAll('label')].find(e => visible(e) && e.textContent.includes('我已阅读并同意'));
  const agreement = label?.querySelector('input[type="checkbox"]');
  const submit = [...document.querySelectorAll('button')].find(e => visible(e) && e.textContent.trim() === '立即登录');
  agreement?.setAttribute('data-xdr-login-agreement', '1');
  submit?.setAttribute('data-xdr-login-submit', '1');
  const challenge = [...document.querySelectorAll('iframe')].some(e => visible(e) && /captcha|geetest/i.test(e.src)) ||
    /拖动滑块|请完成验证|请输入验证码|请输入短信验证码/.test(document.body?.innerText || '');
  const reminder = [...document.querySelectorAll('[role="dialog"]')].find(e => visible(e) &&
    /密码已经超过\d+个月未修改/.test(e.textContent) && e.textContent.includes('请您尽快修改密码'));
  const confirm = reminder && [...reminder.querySelectorAll('button')].find(e => e.textContent.replace(/\s/g, '') === '确定');
  confirm?.setAttribute('data-xdr-password-reminder', '1');
  return { login: true, accountPresent: visible(account), accountFilled: !!account?.value,
    passwordFilled: !!password?.value, agreementPresent: !!agreement, agreementChecked: !!agreement?.checked,
    submitPresent: !!submit && !submit.disabled, challenge, passwordReminder: !!confirm };
}

export async function loginWithSavedCredentials({ bridge = new Bridge(), sleep = delay,
  now = Date.now, autofillTimeoutMs = 8000, loginTimeoutMs = 25000 } = {}) {
  bridge.session = 'jst-login-recovery';
  const sessions = (await bridge.sessions()).filter(s => s.tabs.some(t => /^https:\/\/www\.erp321\.com\//.test(t.url || '')));
  let failure = new CliError('saved_login_unavailable', '已连接浏览器中无聚水潭登录页。');
  const state = () => bridge.evaluate(`(${loginPageState.toString()})()`);
  for (const session of sessions) {
    bridge.browserSessionId = session.id; bridge.tabId = undefined;
    let created;
    try {
      const result = await bridge.command('browser_navigate', { url: 'https://www.erp321.com/login.aspx',
        newTab: true, groupTitle: bridge.session, waitUntil: 'domcontentloaded', timeoutMs: 30000 });
      created = result.tabId; bridge.tabId = created;
      if (!created) throw new CliError('saved_login_navigation_failed', '登录页未返回标签页标识。');
      let current = await state();
      if (current.authenticatedPage) return { submitted: false };
      if (!current.login) throw new CliError('saved_login_origin_mismatch', '登录页地址不匹配，未执行登录。');
      // Chrome可能直到用户手势后才向DOM填入已保存密码。
      if (current.accountPresent && (!current.accountFilled || !current.passwordFilled)) {
        await bridge.command('browser_click', { selector: '#login_id' });
      }
      const autofillDeadline = now() + autofillTimeoutMs;
      do {
        current = await state();
        if (current.challenge) throw new CliError('login_verification_required', '登录需要额外验证。');
        if (current.accountFilled && current.passwordFilled) break;
        if (!current.login) throw new CliError('saved_login_page_changed', '登录页已变化。');
        await sleep(250);
      } while (now() < autofillDeadline);
      if (!current.accountFilled || !current.passwordFilled) throw new CliError('saved_login_autofill_missing', '浏览器未自动填入已保存账号密码。');
      if (!current.agreementPresent || !current.submitPresent) throw new CliError('saved_login_controls_missing', '未找到协议勾选框或立即登录按钮。');
      if (!current.agreementChecked) await bridge.command('browser_click', { selector: '[data-xdr-login-agreement="1"]' });
      current = await state();
      if (!current.login || current.challenge || !current.accountFilled || !current.passwordFilled || !current.agreementChecked) {
        throw new CliError('saved_login_not_ready', '登录条件未满足，未提交登录。');
      }
      await bridge.command('browser_click', { selector: '[data-xdr-login-submit="1"]' });
      const deadline = now() + loginTimeoutMs;
      let reminderConfirmed = false;
      do {
        try { current = await state(); }
        catch { await sleep(250); continue; } // 页面跳转期间上下文可能短暂消失。
        if (current.authenticatedPage) return { submitted: true };
        if (current.challenge) throw new CliError('login_verification_required', '登录需要额外验证。');
        if (current.passwordReminder && !reminderConfirmed) {
          await bridge.command('browser_click', { selector: '[data-xdr-password-reminder="1"]' });
          reminderConfirmed = true;
        }
        if (!current.login) throw new CliError('saved_login_page_changed', '登录后未到达预期聚水潭页面。');
        await sleep(250);
      } while (now() < deadline);
      throw new CliError('saved_login_failed', '已提交登录但尚未恢复会话。');
    } catch (error) {
      failure = error;
      if (error.code === 'login_verification_required') throw error;
    } finally {
      // 只关闭本次新建页，保留用户及其他采集任务的标签页。
      if (created) await bridge.command('browser_close_tab', { tabId: created }).catch(() => {});
    }
  }
  throw failure;
}
