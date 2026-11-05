/**
 * 环境自检。只读，不发任何网络请求，不打印任何 cookie 值。
 */
import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { DATA_ROOT, LEGACY_PATHS, resolveDataPath } from "./paths.js";
import { loadSession, describeSession } from "./session.js";
import { JST_KEYCHAIN_PREFIXES, readKeychainSecret, JST_COOKIE_NAMES, JST_KEYCHAIN_ACCOUNT } from "./session.js";
import { CliError } from "./errors.js";

function check(name, ok, detail, { critical = true } = {}) {
  return { name, ok, critical, ...(detail === undefined ? {} : { detail }) };
}

export function checkRuntime() {
  const results = [];
  const major = Number(process.versions.node.split(".")[0]);
  results.push(check("node_version", major >= 22, process.versions.node));
  try {
    // node:sqlite 在 22.5+ 为实验特性，24 稳定。
    // eslint-disable-next-line no-new-func
    new Function('return import("node:sqlite")');
    results.push(check("node_sqlite", true));
  } catch (error) {
    results.push(check("node_sqlite", false, error.message));
  }
  results.push(check("platform", process.platform === "darwin", process.platform));
  return results;
}

export function checkDataDir() {
  try {
    mkdirSync(DATA_ROOT, { recursive: true });
    accessSync(DATA_ROOT, constants.W_OK);
    return [check("data_dir", true, DATA_ROOT)];
  } catch (error) {
    return [check("data_dir", false, `${DATA_ROOT}: ${error.message}`)];
  }
}

/** 逐个 Keychain 前缀探测，只报告「有几个 cookie 可读」。 */
export function checkKeychain() {
  const results = [];
  for (const prefix of JST_KEYCHAIN_PREFIXES) {
    const present = JST_COOKIE_NAMES.filter((name) =>
      Boolean(readKeychainSecret(`${prefix}.cookie.${name}`, JST_KEYCHAIN_ACCOUNT)),
    );
    // 每个前缀只是候选来源，缺一个不算故障；最终看 session 那一条。
    results.push(check(
      `keychain:${prefix}`,
      present.length === JST_COOKIE_NAMES.length,
      `${present.length}/${JST_COOKIE_NAMES.length} cookies`,
      { critical: false },
    ));
  }
  return results;
}

export function checkSession() {
  try {
    const session = loadSession();
    return [check("session", true, describeSession(session))];
  } catch (error) {
    return [check("session", false, error instanceof CliError ? error.message : String(error))];
  }
}

export function checkLegacyPaths() {
  const home = process.env.HOME ?? "";
  return Object.entries(LEGACY_PATHS).map(([legacyName, target]) => {
    const legacy = join(home, legacyName);
    const next = resolveDataPath(target);
    return {
      name: `data:${legacyName}`,
      legacy_exists: existsSync(legacy),
      new_exists: existsSync(next),
      legacy_size_bytes: existsSync(legacy) ? statSync(legacy).size : 0,
      target: next,
    };
  });
}

export function runDoctor() {
  const checks = [
    ...checkRuntime(),
    ...checkDataDir(),
    ...checkKeychain(),
    ...checkSession(),
  ];
  const failed = checks.filter((c) => c.ok === false && c.critical !== false);
  return {
    ok: failed.length === 0,
    checks,
    data: checkLegacyPaths(),
  };
}
