/**
 * 聚水潭报表接口传输层（api.erp321.com/.../transportData）。
 *
 * 抽自三份重复实现：
 *   - jushuitan-order-details/src/api.js   （headers / 未登录判定）
 *   - jushuitan-sales-performance/src/api.js
 *   - jushuitan-inventory-warning/src/api.js （限流 / 访问上限 / 静默时段）
 *
 * 业务差异全部通过 profile 注入，本文件不认识任何具体报表。
 */
import { CliError } from "./errors.js";
import { assertAllowedHour } from "./date.js";
import { cookieHeader, cookieValue } from "./session.js";

export const JST_API_ROOT = "https://api.erp321.com/jst-data-report/getData/transportData";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * 串行限流器：保证同一账号的请求间隔不小于 intervalMs。
 * @param {number} intervalMs
 */
export function createRateLimiter(intervalMs = 0) {
  let nextSlotAt = 0;
  let queue = Promise.resolve();
  return function acquire() {
    const slot = queue.then(async () => {
      const wait = Math.max(0, nextSlotAt - Date.now());
      if (wait > 0) await sleep(wait);
      nextSlotAt = Date.now() + intervalMs;
    });
    queue = slot.catch(() => {});
    return slot;
  };
}

/** 账号级「访问上限」闸门：命中后所有请求一起等。 */
export function createAccessGate(waitMs = 600_000) {
  let until = 0;
  return {
    async wait() {
      const remaining = Math.max(0, until - Date.now());
      if (remaining > 0) await sleep(remaining);
    },
    trip() {
      until = Math.max(until, Date.now() + waitMs);
      return waitMs;
    },
    get pendingMs() {
      return Math.max(0, until - Date.now());
    },
  };
}

const ACCESS_LIMIT_RE = /访问(过于)?频繁|访问上限|请求(过于)?频繁|限流|每秒|too ?many/i;
const LOGGED_OUT_RE = /未登录|登录(状态)?(已)?失效|请重新登录/i;

/**
 * @param {object} options
 * @param {{cookies: {name:string,value:string}[]}} options.session
 * @param {object} [options.profile]          请求上下文（bizDomain/pageCode/referer/origin…）
 * @param {number} [options.intervalMs]       限流间隔，0 表示不限
 * @param {number} [options.accessLimitWaitMs] 命中上限后的等待时长
 * @param {number} [options.maxRetries]       访问上限自动重试次数
 * @param {boolean} [options.quietHours]      是否启用 23:00–06:59 静默
 * @param {typeof fetch} [options.fetchImpl]
 */
export function createJstTransport({
  session,
  profile = {},
  intervalMs = 0,
  accessLimitWaitMs = 600_000,
  maxRetries = 1,
  quietHours = true,
  fetchImpl = globalThis.fetch,
} = {}) {
  const acquire = createRateLimiter(intervalMs);
  const gate = createAccessGate(accessLimitWaitMs);

  const {
    origin = "https://src.erp321.com",
    referer = "https://src.erp321.com/erp-data/salesThemeAnalysis/order/home",
    pageParam = { bizDomain: "salesTheme", pageCode: "SALES_THEME_ORDER", dataRole: 1 },
    headers: extraHeaders = {},
  } = profile;

  function buildBody(apiCode, params, { extraData = {}, context = {} } = {}) {
    return {
      coid: "",
      uid: "",
      data: {
        apiCode,
        apiParams: params,
        ...extraData,
        ...context,
        sysEnv: "ERP",
      },
    };
  }

  function buildHeaders() {
    return {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json",
      cookie: cookieHeader(session),
      origin,
      referer,
      pageparam: JSON.stringify(pageParam),
      u_co_id: cookieValue(session, "u_co_id"),
      u_id: cookieValue(session, "u_id"),
      ...extraHeaders,
    };
  }

  function classify(payload, status) {
    const msg = String(payload?.msg ?? payload?.message ?? "");
    if (payload?.code === -1 && LOGGED_OUT_RE.test(msg || "未登录")) {
      return new CliError("not_logged_in", "聚水潭 session expired. Run: jst auth import");
    }
    if (ACCESS_LIMIT_RE.test(msg)) {
      return new CliError("rate_limited", msg || "聚水潭 rate limit hit.", { exitCode: 5 });
    }
    if (!(status >= 200 && status < 300) || payload?.code !== 0 || payload?.success !== true) {
      return new CliError(
        "api_error",
        msg || `Request failed (HTTP ${status}).`,
        { exitCode: 5 },
      );
    }
    return null;
  }

  /**
   * @param {string} apiCode
   * @param {object} params
   * @param {{extraData?: object, context?: object, query?: Record<string,string>}} [options]
   */
  async function request(apiCode, params, options = {}) {
    if (quietHours) assertAllowedHour();
    const url = new URL(JST_API_ROOT);
    url.searchParams.set("apiCode", apiCode);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt += 1) {
      await acquire();
      await gate.wait();

      let response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(buildBody(apiCode, params, options)),
        });
      } catch (error) {
        throw new CliError("network_error", `聚水潭 request failed: ${error.message}`, {
          exitCode: 4,
          cause: error,
        });
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new CliError(
          "invalid_response",
          `聚水潭 returned non-JSON (HTTP ${response.status}).`,
        );
      }

      const error = classify(payload, response.status);
      if (!error) return payload;

      if (error.code === "rate_limited" && attempt < maxRetries) {
        gate.trip();
        continue;
      }
      throw error;
    }
  }

  return { request, gate, session, profile };
}

/** 分页抓取全部页。调用方给 fetchPage(apiCode → payload)。 */
export async function paginate(request, { apiCode, params, pageSize, maxPages = 10_000, onPage }) {
  const rows = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const payload = await request(apiCode, {
      ...params,
      pageSize,
      pageNum: page,
    });
    total = Number(payload.total ?? total);
    const data = payload.data ?? [];
    rows.push(...data);
    onPage?.({ page, total, rows: data.length, accumulated: rows.length });
    if (data.length < pageSize) break;
  }
  return { total, rows, pages: Math.ceil(total / pageSize) || 1 };
}
