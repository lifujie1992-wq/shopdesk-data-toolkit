// 把 Electron 伪装成原生 Chrome。
//
// 平台（抖店、拼多多等）会看两样东西：
//   1) User-Agent：Electron 默认 UA 里带 `店铺工作台/0.11.5 ... Electron/44.2.0`，
//      这是最直接的风控特征，容易被判为"非浏览器客户端" → 会话被踢。
//   2) User-Agent Client Hints（Sec-CH-UA / navigator.userAgentData）：
//      Electron 的品牌列表是 Chromium + Not?A_Brand，没有 Google Chrome。
//
// 做法：
//   - app.userAgentFallback + 每个 session 的 setUserAgent（页面里 navigator.userAgent 也变成 Chrome）
//   - session.webRequest 改写 UA / Sec-CH-UA 请求头（服务端看到的也是 Chrome）
//   - 给每个 session 注册 preload，在页面主世界改 navigator.userAgentData.brands
//     （平台的前端风控脚本查的是这个）
//
// 注意：UA 一变，之前按 Electron UA 下发的登录票据（ttwid/msToken 之类）可能要重新登录一次。

const { app, session } = require('electron');
const path = require('node:path');

const CHROME_VERSION = String(process.versions.chrome || '152.0.7977.76');
const CHROME_MAJOR = CHROME_VERSION.split('.')[0];
const PLATFORM = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux';
const ACCEPT_LANGUAGES = 'zh-CN,zh,en';
// 浏览器实际发出去的 Accept-Language 形如：zh-CN,zh;q=0.9,en;q=0.8
const ACCEPT_LANGUAGE_HEADER = 'zh-CN,zh;q=0.9,en;q=0.8';

const USER_AGENT = (() => {
  const chrome = `Chrome/${CHROME_MAJOR}.0.0.0`;
  if (process.platform === 'win32') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
  }
  if (process.platform === 'darwin') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ${chrome} Safari/537.36`;
})();

const SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not_A Brand";v="99"`;
const SEC_CH_UA_FULL = `"Chromium";v="${CHROME_VERSION}", "Google Chrome";v="${CHROME_VERSION}", "Not_A Brand";v="99.0.0.0"`;

const fs = require('node:fs');
const PRELOAD_FILE = (() => {
  // 沙箱 preload 不能从 asar 里加载，所以打包后放在 Contents/Resources/ 下
  const candidates = [
    path.join(process.resourcesPath || '', 'stealth-preload.js'),
    path.join(__dirname, 'stealth-preload.js'),
    path.join(__dirname, '..', 'stealth-preload.js'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {}
  }
  return candidates[0];
})();
const hardened = new WeakSet();
let installed = false;

function shapeHeaders(raw) {
  const headers = Object.assign({}, raw);
  // 先删掉所有大小写变体，避免出现两份 UA
  for (const key of Object.keys(headers)) {
    const k = key.toLowerCase();
    if (
      k === 'user-agent' ||
      k === 'accept-language' ||
      k === 'sec-ch-ua' ||
      k === 'sec-ch-ua-full-version' ||
      k === 'sec-ch-ua-full-version-list' ||
      k === 'sec-ch-ua-platform'
    ) {
      delete headers[key];
    }
  }
  headers['User-Agent'] = USER_AGENT;
  headers['Accept-Language'] = ACCEPT_LANGUAGE_HEADER;
  headers['sec-ch-ua'] = SEC_CH_UA;
  headers['sec-ch-ua-platform'] = JSON.stringify(PLATFORM);
  // Electron 不会自己发这两组；只有站点通过 Accept-CH 索要时才补上，避免和无害的默认行为不一致
  if ('sec-ch-ua-full-version' in raw || 'Sec-CH-UA-Full-Version' in raw) headers['sec-ch-ua-full-version'] = `"${CHROME_VERSION}"`;
  if ('sec-ch-ua-full-version-list' in raw || 'Sec-CH-UA-Full-Version-List' in raw) headers['sec-ch-ua-full-version-list'] = SEC_CH_UA_FULL;
  return headers;
}

function hardenSession(ses) {
  if (!ses || hardened.has(ses)) return;
  hardened.add(ses);
  try {
    ses.setUserAgent(USER_AGENT, ACCEPT_LANGUAGES);
  } catch {}
  try {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: shapeHeaders(details.requestHeaders) });
    });
  } catch {}
  try {
    ses.registerPreloadScript({ id: 'shopdesk-chrome-stealth', type: 'frame', filePath: PRELOAD_FILE });
  } catch {}
}

function install() {
  if (installed) return;
  installed = true;

  // 全局兜底：任何还没来得及 setUserAgent 的 session/webContents 也不会露出 Electron
  app.userAgentFallback = USER_AGENT;
  try {
    app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
  } catch {}

  try {
    app.on('session-created', (ses) => hardenSession(ses));
  } catch {}

  app.on('web-contents-created', (_event, webContents) => {
    try {
      webContents.setUserAgent(USER_AGENT);
    } catch {}
    try {
      hardenSession(webContents.session);
    } catch {}
  });

  try {
    hardenSession(session.defaultSession);
  } catch {}
}

module.exports = {
  install,
  hardenSession,
  USER_AGENT,
  CHROME_VERSION,
  CHROME_MAJOR,
  PLATFORM,
  ACCEPT_LANGUAGES,
};
