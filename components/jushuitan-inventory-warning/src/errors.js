export class CliError extends Error {
  constructor(code, message, diagnostic) {
    super(message);
    this.name = "CliError";
    this.code = code;
    if (diagnostic) this.diagnostic = safeDiagnostic(diagnostic);
  }
}

function safeText(value) {
  return String(value ?? '').replace(/\bBearer\s+[^\s"']+/gi, '[已隐藏]')
    .replace(/\b(?:Cookie|Authorization|password|secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key)\b["']?\s*[:=]\s*[^\r\n]+/gi, '[已隐藏]')
    .slice(0, 1200);
}

function safeDiagnostic(value) {
  const result = {};
  if (typeof value.api_code === 'string' && /^[a-zA-Z0-9_]{1,100}$/.test(value.api_code)) result.api_code = value.api_code;
  for (const field of ['http_status', 'page_num', 'page_size', 'attempts']) {
    if (Number.isInteger(value[field])) result[field] = value[field];
  }
  if (value.request) {
    const request = {};
    for (const field of ['viewType', 'hasSkuInfo']) {
      const item = value.request[field];
      if (typeof item === 'number' || typeof item === 'string' && /^[a-zA-Z0-9_]{1,40}$/.test(item)) request[field] = item;
    }
    for (const field of ['sortMap', 'childrenSortMap']) {
      if (value.request[field] && typeof value.request[field] === 'object') request[field] = Object.fromEntries(
        Object.entries(value.request[field]).filter(([key, item]) => /^[a-zA-Z0-9_]{1,64}$/.test(key) && ['ASC', 'DESC'].includes(item)));
    }
    result.request = request;
  }
  if (value.response) result.response = {
    code: typeof value.response.code === 'number' ? value.response.code : safeText(value.response.code).slice(0, 80),
    success: typeof value.response.success === 'boolean' ? value.response.success : null,
    message: safeText(value.response.message),
  };
  return result;
}

export function errorResult(error) {
  const known = error instanceof CliError;
  const result = {code: known ? error.code : 'internal_error', message: safeText(error instanceof Error ? error.message : error)};
  if (known && error.diagnostic) result.diagnostic = safeDiagnostic(error.diagnostic);
  return {ok: false, error: result};
}
