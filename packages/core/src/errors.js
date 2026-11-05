/**
 * 统一错误类型。
 *
 * 所有 CLI 的失败都必须抛 CliError，带机器可读的 code。
 * 输出契约与旧脚本保持一致：{"ok":false,"error":{"code","message"}}
 *
 * 第三个参数有两种形态，按需自动识别：
 *   1. 选项对象  { exitCode, cause, details, diagnostic }
 *   2. 诊断对象  { api_code, http_status, page_num, ... }
 *      —— 兼容 jushuitan-inventory-warning 的历史调用方式。
 */
export class CliError extends Error {
  constructor(code, message, extra = undefined) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = 1;

    if (!extra || typeof extra !== "object") return;

    const isOptions = ["exitCode", "cause", "details", "diagnostic"].some((key) => key in extra);
    if (isOptions) {
      if (extra.exitCode !== undefined) this.exitCode = extra.exitCode;
      if (extra.details) this.details = extra.details;
      if (extra.diagnostic) this.diagnostic = safeDiagnostic(extra.diagnostic);
      if (extra.cause !== undefined) this.cause = extra.cause;
      return;
    }
    this.diagnostic = safeDiagnostic(extra);
  }
}

/** 退出码约定（旧脚本一律返回 1，此处保持兼容默认值）。 */
export const EXIT = Object.freeze({
  ok: 0,
  failure: 1,
  usage: 2,
  auth: 3,
  network: 4,
  api: 5,
});

export function isCliError(error) {
  return error instanceof CliError;
}

/** 脱敏：任何形似凭据的片段都替换掉，并截断长度。 */
export function safeText(value) {
  return String(value ?? "").replace(/\bBearer\s+[^\s"']+/gi, "[已隐藏]")
    .replace(/\b(?:Cookie|Authorization|password|secret|(?:access[_-]?|refresh[_-]?)?token|api[_-]?key)\b["']?\s*[:=]\s*[^\r\n]+/gi, "[已隐藏]")
    .slice(0, 1200);
}

/** 只保留白名单字段，避免把请求体/cookie 写进日志。 */
export function safeDiagnostic(value) {
  const result = {};
  if (typeof value.api_code === "string" && /^[a-zA-Z0-9_]{1,100}$/.test(value.api_code)) {
    result.api_code = value.api_code;
  }
  for (const field of ["http_status", "page_num", "page_size", "attempts"]) {
    if (Number.isInteger(value[field])) result[field] = value[field];
  }
  if (value.request) {
    const request = {};
    for (const field of ["viewType", "hasSkuInfo"]) {
      const item = value.request[field];
      if (typeof item === "number" || (typeof item === "string" && /^[a-zA-Z0-9_]{1,40}$/.test(item))) {
        request[field] = item;
      }
    }
    for (const field of ["sortMap", "childrenSortMap"]) {
      if (value.request[field] && typeof value.request[field] === "object") {
        request[field] = Object.fromEntries(
          Object.entries(value.request[field]).filter(([key, item]) =>
            /^[a-zA-Z0-9_]{1,64}$/.test(key) && ["ASC", "DESC"].includes(item)),
        );
      }
    }
    result.request = request;
  }
  if (value.response) {
    result.response = {
      code: typeof value.response.code === "number"
        ? value.response.code
        : safeText(value.response.code).slice(0, 80),
      success: typeof value.response.success === "boolean" ? value.response.success : null,
      message: safeText(value.response.message),
    };
  }
  return result;
}

/** 把任意异常归一化成输出用的 payload（含脱敏后的 diagnostic）。 */
export function toErrorPayload(error) {
  const known = error instanceof CliError;
  const payload = {
    code: known ? error.code : "internal_error",
    message: safeText(error instanceof Error ? error.message : error),
    exitCode: known ? error.exitCode : EXIT.failure,
  };
  if (known && error.diagnostic) payload.diagnostic = safeDiagnostic(error.diagnostic);
  if (known && error.details) payload.details = error.details;
  return payload;
}

/** 与旧脚本的 errorResult 完全一致的输出结构。 */
export function errorResult(error) {
  const payload = toErrorPayload(error);
  const result = { code: payload.code, message: payload.message };
  if (payload.diagnostic) result.diagnostic = payload.diagnostic;
  return { ok: false, error: result };
}
