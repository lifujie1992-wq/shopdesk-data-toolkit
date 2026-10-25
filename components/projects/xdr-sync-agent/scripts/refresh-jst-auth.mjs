import { pathToFileURL } from 'node:url';
import { Bridge, readPage, sessionFromCookieHeader, saveSession, loadSession, callApi, summaryParams } from '../shared/jst-tools.js';
import { loginWithSavedCredentials } from './login-jst-saved.mjs';

export async function refreshAuth({
  bridge = new Bridge(),
  validate = session => callApi(session, 'purchase_alarm_sku_summary', summaryParams()),
  save = saveSession,
  load = loadSession,
  recover = loginWithSavedCredentials,
} = {}) {
  async function readValidatedSession() {
    await bridge.refresh();
    const order = await bridge.run(readPage, { command: 'login-status', limit: 1, page: 1 });
    if (!order?.logged_in) throw Object.assign(new Error('order_check_failed'), { code: 'order_check_failed' });
    // 从刚验证成功的同一浏览器取 API 域 Cookie，不再硬编码 Default 配置。
    // 凭据只在内存与系统 Keychain 中流转，不打印、不写临时文件。
    const { cookies = [] } = await bridge.command('browser_cdp', {
      method: 'Network.getCookies', params: { urls: ['https://api.erp321.com/'] },
    });
    const session = sessionFromCookieHeader(cookies.map(c => `${c.name}=${c.value}`).join('; '));
    session.profile = 'OpenBridge';
    session.cookies = session.cookies.map(c => {
      const original = cookies.find(x => x.name === c.name);
      return { ...c, expiresAt: original?.expires > 0 ? original.expires * 1000 : null };
    });
    await validate(session);
    return session;
  }
  let session, autoLogin = false;
  try { session = await readValidatedSession(); }
  catch (error) {
    if (!['not_logged_in', 'session_expired', 'order_check_failed'].includes(error.code)) throw error;
    const recovered = await recover();
    autoLogin = !!recovered?.submitted;
    session = await readValidatedSession();
  }
  save(session);
  // 验证真正持久保存后的凭据，不能只证明浏览器登录正常。
  const stored = load();
  await validate(stored);
  const expiresAt = stored.cookies.find(c => c.name === 'u_sso_token')?.expiresAt;
  return { inventory: true, order_page: true, source: 'OpenBridge', auto_login: autoLogin, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  refreshAuth().then(result => console.log(JSON.stringify(result))).catch(error => {
    // 只输出错误类别，避免 API/浏览器错误文本意外夹带凭据。
    console.error(JSON.stringify({ ok: false, code: error.code || error.name || 'refresh_failed' }));
    process.exitCode = 1;
  });
}
