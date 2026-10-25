// 脱敏：默认拒绝敏感字段，白名单放行；URL 去 query/签名
const SENSITIVE_KEY = /(token|authorization|cookie|csrf|signature|secret|password|session|bogus|verifyfp|mstoken|a_bogus|ms_token)/i;

export function redactUrl(u) {
  try {
    const url = new URL(String(u));
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function redactMessage(s, max = 500) {
  let out = String(s ?? '');
  // 把内嵌 URL 的 query 去掉（含签名参数）
  out = out.replace(/https?:\/\/[^\s"'<>]+/g, (m) => redactUrl(m));
  return out.slice(0, max);
}

export function sanitizeLog(rec) {
  if (rec === null || typeof rec !== 'object') return rec;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (SENSITIVE_KEY.test(k)) continue; // 敏感字段名直接丢弃
    if (typeof v === 'string') out[k] = redactMessage(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => sanitizeLog(x));
    else if (v && typeof v === 'object') out[k] = sanitizeLog(v);
    else out[k] = v;
  }
  return out;
}
