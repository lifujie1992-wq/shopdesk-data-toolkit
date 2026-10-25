// 只做一件事：在页面主世界里把 navigator.userAgentData 伪装成 Chrome。
// （UA 本身已经由 session.setUserAgent 处理成原生 Chrome 字符串，不需要在这里改）
//
// 为什么要在主世界改：preload 默认跑在隔离世界，页面脚本看不到其中的修改。
// webFrame.executeJavaScript 会把代码注入页面主世界的全局上下文，且执行时机早于页面自己的脚本。

const { webFrame } = require('electron');

// 这个函数会被 toString() 序列化后注入页面，不能引用外部变量
function injectUserAgentData() {
  try {
    const native = navigator.userAgentData;
    if (!native) return;

    const ua = String(navigator.userAgent || '');
    let major = (ua.match(/Chrome\/(\d+)/) || [])[1] || '';
    try {
      const chromium = (native.brands || []).filter((b) => b && b.brand === 'Chromium')[0];
      if (chromium && chromium.version) major = String(chromium.version).split('.')[0];
    } catch (e) {}
    if (!major) return;

    const brandList = () => [
      { brand: 'Google Chrome', version: String(major) },
      { brand: 'Chromium', version: String(major) },
      { brand: 'Not_A Brand', version: '99' },
    ];
    const copy = (list) => list.map((b) => ({ brand: b.brand, version: b.version }));

    // Chromium 的完整版本（152.0.7977.76 这种）只出现在高熵值里
    let fullVersion = '';
    const nativeHEV = native.getHighEntropyValues ? native.getHighEntropyValues.bind(native) : null;
    if (nativeHEV) {
      try {
        nativeHEV(['fullVersionList']).then((v) => {
          const list = (v && v.fullVersionList) || [];
          const chromium = list.filter((b) => b && b.brand === 'Chromium')[0];
          if (chromium && chromium.version) fullVersion = String(chromium.version);
        }).catch(() => {});
      } catch (e) {}
    }
    const fullVersionNow = () => fullVersion || major + '.0.0.0';
    const fullList = () => [
      { brand: 'Google Chrome', version: fullVersionNow() },
      { brand: 'Chromium', version: fullVersionNow() },
      { brand: 'Not_A Brand', version: '99.0.0.0' },
    ];

    const fake = {
      get brands() {
        return copy(brandList());
      },
      get mobile() {
        return !!native.mobile;
      },
      get platform() {
        return native.platform;
      },
      getHighEntropyValues(hints) {
        if (!nativeHEV) {
          return Promise.resolve({ brands: copy(brandList()), mobile: !!native.mobile, platform: native.platform });
        }
        return nativeHEV(hints).then((values) => {
          const out = Object.assign({}, values);
          out.brands = copy(brandList());
          if (out.fullVersionList) out.fullVersionList = copy(fullList());
          if (out.uaFullVersion) out.uaFullVersion = fullVersionNow();
          return out;
        });
      },
      toJSON() {
        return { brands: copy(brandList()), mobile: !!native.mobile, platform: native.platform };
      },
    };
    Object.defineProperty(fake, Symbol.toStringTag, { value: 'NavigatorUAData' });

    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      enumerable: true,
      get: () => fake,
    });
  } catch (e) {}
}

try {
  webFrame.executeJavaScript('(' + injectUserAgentData.toString() + ')()').catch(() => {});
} catch (e) {}
