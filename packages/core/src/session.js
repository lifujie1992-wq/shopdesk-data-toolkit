/**
 * 认证抽象。这是本次重构的核心收益之一。
 *
 * 现状：4 套实现各写一遍，导致任何工具都不能复用别的工具的登录态。
 *   - Keychain          jst-orders / jst-sales / jst-inventory
 *   - Chrome Cookie     jst-inventory（AES 解密 Local State）
 *   - OpenBridge 标签页 jst-order-page / jst-aftersales
 *   - shopdesk 分区     doudian-daily（Electron Cookies SQLite，Python 侧）
 *
 * 之后：一个 loadSession()，provider 可插拔。业务代码只认
 *   { cookies: [{name, value}] }
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CliError } from "./errors.js";

/** 聚水潭 ERP 需要的三个核心 cookie；其余（u_ssi 等）为可选。 */
export const JST_COOKIE_NAMES = Object.freeze(["u_sso_token", "u_id", "u_co_id"]);

export const JST_KEYCHAIN_ACCOUNT = "erp321.com";

/**
 * 已知的 Keychain service 前缀。新工具在这里登记即可共享登录态。
 * 顺序即优先级：越靠前越优先。
 */
export const JST_KEYCHAIN_PREFIXES = Object.freeze([
  "com.xx-cli.jst-inventory",
  "com.xx-cli.jst-orders",
  "com.xx-cli.jst-sales",
  "com.xx-cli.jst-order-page",
  "com.xx-cli.jst-aftersales",
]);

/** 读一条 Keychain 明文。失败返回 null，不抛错（用于「逐个前缀探测」）。 */
export function readKeychainSecret(service, account = JST_KEYCHAIN_ACCOUNT) {
  if (process.platform !== "darwin") return null;
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", account, "-s", service, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

export function writeKeychainSecret(service, value, account = JST_KEYCHAIN_ACCOUNT) {
  const result = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-a", account, "-s", service, "-w", value],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    throw new CliError("keychain_write_failed", `Could not write ${service} to Keychain.`);
  }
}

/**
 * Keychain provider。
 * @param {{account?: string, prefixes?: string[], names?: string[]}} [options]
 */
export function keychainProvider({
  account = JST_KEYCHAIN_ACCOUNT,
  prefixes = JST_KEYCHAIN_PREFIXES,
  names = JST_COOKIE_NAMES,
} = {}) {
  return () => {
    for (const prefix of prefixes) {
      const cookies = names.map((name) => ({
        name,
        value: readKeychainSecret(`${prefix}.cookie.${name}`, account),
      }));
      if (cookies.every((cookie) => cookie.value)) {
        return { source: `keychain:${prefix}`, cookies };
      }
    }
    return null;
  };
}

/**
 * 外部 JSON provider。兼容三种落盘格式：
 *   1. [{name, value}, ...]
 *   2. { cookies: [{name, value}, ...] }
 *   3. "a=1; b=2" 或 { a: "1", b: "2" }
 * @param {string} path
 */
export function jsonProvider(path) {
  const file = resolve(path);
  return () => {
    if (!existsSync(file)) return null;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    let list;
    if (Array.isArray(raw)) list = raw;
    else if (Array.isArray(raw.cookies)) list = raw.cookies;
    else if (typeof raw === "string") list = parseCookieHeader(raw);
    else list = Object.entries(raw).map(([name, value]) => ({ name, value: String(value) }));
    const cookies = list
      .map(({ name, value }) => ({ name, value: value == null ? null : String(value) }))
      .filter(({ name }) => Boolean(name));
    return cookies.length ? { source: `json:${file}`, cookies } : null;
  };
}

export function parseCookieHeader(header) {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      return index === -1
        ? { name: part, value: "" }
        : { name: part.slice(0, index).trim(), value: part.slice(index + 1).trim() };
    });
}

/** 进程内 provider 注册表，供各数据源自行扩展（chrome / openbridge 在阶段 2 接入）。 */
const registry = new Map([
  ["keychain", keychainProvider()],
  ["json", null], // 需要显式传 jsonPath
]);

export function registerProvider(name, factory) {
  registry.set(name, factory);
}

/**
 * 装载会话。
 * @param {{provider?: string, jsonPath?: string, required?: string[]}} [options]
 * @returns {{source: string, cookies: {name: string, value: string}[]}}
 */
export function loadSession(options = {}) {
  const { provider = "keychain", required = JST_COOKIE_NAMES } = options;
  const factory = provider === "json" && options.jsonPath
    ? jsonProvider(options.jsonPath)
    : registry.get(provider);
  if (!factory) {
    throw new CliError("unknown_provider", `Unknown session provider: ${provider}`);
  }
  const session = factory();
  if (!session) {
    throw new CliError(
      "auth_required",
      `No saved 聚水潭 session (provider=${provider}). Run: jst auth import`,
    );
  }
  const missing = required.filter(
    (name) => !session.cookies.find((c) => c.name === name)?.value,
  );
  if (missing.length) {
    throw new CliError(
      "auth_incomplete",
      `Session is missing cookie(s): ${missing.join(", ")}. Run: jst auth import`,
    );
  }
  return session;
}

export function cookieHeader(session) {
  return session.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

export function cookieValue(session, name) {
  return session.cookies.find((cookie) => cookie.name === name)?.value ?? "";
}

/** 只返回可安全打印的摘要，绝不输出 cookie 值。 */
export function describeSession(session) {
  return {
    source: session.source,
    cookie_names: session.cookies.map((cookie) => cookie.name),
    present: Object.fromEntries(
      session.cookies.map((cookie) => [cookie.name, Boolean(cookie.value)]),
    ),
  };
}
