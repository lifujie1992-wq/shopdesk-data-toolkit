import { createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import { CliError } from "./errors.js";

const CHROME_ROOT = join(homedir(), "Library", "Application Support", "Google", "Chrome");
const KEYCHAIN_PREFIX = "com.xx-cli.jst-inventory";
const KEYCHAIN_ACCOUNT = "erp321.com";
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;
const REQUIRED_COOKIE_NAMES = new Set(["u_sso_token", "u_id", "u_co_id"]);
const ERP_COOKIE_NAMES = [
  "u_sso_token", "u_id", "u_co_id", "u_ssi", "u_cid", "u_json", "u_env",
  "u_env_next", "ss_u_env", "isLogin", "u_lid", "u_r", "u_drp", "u_shop",
  "u_env_xts", "u_name", "u_co_name", "u_lastLoginType", "u_isTPWS",
];
const ERP_COOKIE_NAME_SET = new Set(ERP_COOKIE_NAMES);

function runSecurity(args) {
  const result = spawnSync("/usr/bin/security", args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
  if (result.error) {
    throw new CliError("keychain_error", result.error.message);
  }
  return result;
}

function keychainService(name) {
  return `${KEYCHAIN_PREFIX}.${name}`;
}

function writeKeychainSecret(service, secret) {
  // The interactive `security ... -w` password prompt truncates input at 128
  // bytes, which silently corrupts long session cookies (u_json, u_r). Pass the
  // value as an argument instead so the entire secret is stored.
  const result = spawnSync("/usr/bin/security", [
    "add-generic-password",
    "-a", KEYCHAIN_ACCOUNT,
    "-s", service,
    "-l", "Jushuitan Inventory CLI session",
    "-U",
    "-w", secret,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (result.error) {
    throw new CliError("keychain_error", result.error.message);
  }
  return result;
}

function readKeychainSecret(service) {
  const result = runSecurity([
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    service,
    "-w",
  ]);
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

export function chromeTimeToUnixMs(value) {
  if (!value) return null;
  return Number(value) / 1000 - CHROME_EPOCH_OFFSET_MS;
}

export function deriveChromeKey(password) {
  return pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
}

export function decryptChromeCookie({ encryptedValue, plaintextValue, host, dbVersion, key }) {
  if (plaintextValue) return plaintextValue;
  const encrypted = Buffer.from(encryptedValue ?? []);
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") {
    throw new CliError("unsupported_cookie_format", `Unsupported Chrome cookie format for ${host}`);
  }

  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    let decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);

    if (dbVersion >= 24 && decrypted.length >= 32) {
      const hostDigest = createHash("sha256").update(host).digest();
      if (decrypted.subarray(0, 32).equals(hostDigest)) {
        decrypted = decrypted.subarray(32);
      }
    }
    return decrypted.toString("utf8");
  } catch {
    throw new CliError(
      "cookie_decrypt_failed",
      "Could not decrypt Chrome cookies. Approve Chrome Safe Storage access and retry.",
    );
  }
}

function readChromeSafeStoragePassword() {
  const result = runSecurity(["find-generic-password", "-w", "-s", "Chrome Safe Storage"]);
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new CliError(
      "keychain_access_denied",
      "Chrome Safe Storage could not be read. Run auth sync in Terminal and approve the macOS Keychain prompt.",
    );
  }
  return result.stdout.trim();
}

function validateProfile(profile) {
  if (!/^(Default|Profile [0-9]+)$/.test(profile)) {
    throw new CliError("invalid_profile", "Chrome profile must be Default or Profile N.");
  }
}

function appliesToApi(cookie) {
  const host = cookie.host_key.startsWith(".") ? cookie.host_key.slice(1) : cookie.host_key;
  return "api.erp321.com" === host || "api.erp321.com".endsWith(`.${host}`);
}

export function readChromeErpSession(profile = "Default") {
  validateProfile(profile);
  const cookieDb = join(CHROME_ROOT, profile, "Cookies");
  if (!existsSync(cookieDb)) {
    throw new CliError("chrome_profile_not_found", `Chrome cookie database not found for profile ${profile}.`);
  }

  const password = readChromeSafeStoragePassword();
  const key = deriveChromeKey(password);
  const db = new DatabaseSync(cookieDb, { readOnly: true });
  try {
    const dbVersion = Number(db.prepare("SELECT value FROM meta WHERE key = 'version'").get()?.value ?? 0);
    const cookieQuery = db.prepare(`
        SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly
        FROM cookies
        WHERE host_key = '.erp321.com' OR host_key = 'api.erp321.com'
        ORDER BY LENGTH(path) DESC, name ASC
      `);
    cookieQuery.setReadBigInts(true);
    const rows = cookieQuery.all();

    const now = Date.now();
    const cookies = rows
      .map((row) => ({
        host: row.host_key,
        name: row.name,
        value: decryptChromeCookie({
          encryptedValue: row.encrypted_value,
          plaintextValue: row.value,
          host: row.host_key,
          dbVersion,
          key,
        }),
        path: row.path,
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        expiresAt: chromeTimeToUnixMs(row.expires_utc),
      }))
      .filter((cookie) => cookie.value && (!cookie.expiresAt || cookie.expiresAt > now))
      .filter((cookie) => appliesToApi({ host_key: cookie.host }))
      .filter((cookie) => ERP_COOKIE_NAME_SET.has(cookie.name));

    if (!cookies.some((cookie) => cookie.name === "u_sso_token")) {
      throw new CliError(
        "not_logged_in",
        "No active u_sso_token was found. Log in to 聚水潭 in Chrome, then run auth sync again.",
      );
    }

    return {
      version: 1,
      profile,
      syncedAt: new Date().toISOString(),
      cookies,
    };
  } finally {
    db.close();
  }
}

export function sessionFromCookieHeader(header) {
  const source = String(header ?? "").trim().replace(/^cookie\s*:\s*/i, "");
  const values = new Map();
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (ERP_COOKIE_NAME_SET.has(name) && value) values.set(name, value);
  }

  const missing = [...REQUIRED_COOKIE_NAMES].filter((name) => !values.has(name));
  if (missing.length > 0) {
    throw new CliError(
      "invalid_cookie",
      `Cookie is missing required fields: ${missing.join(", ")}. Copy the full request Cookie header.`,
    );
  }

  return {
    version: 1,
    profile: "manual",
    syncedAt: new Date().toISOString(),
    cookies: ERP_COOKIE_NAMES.filter((name) => values.has(name)).map((name) => ({
      host: ".erp321.com",
      name,
      value: values.get(name),
      path: "/",
      secure: false,
      httpOnly: name === "u_sso_token",
      expiresAt: null,
    })),
  };
}

export function cookieHeader(session) {
  const now = Date.now();
  return session.cookies
    .filter((cookie) => cookie.value && (!cookie.expiresAt || cookie.expiresAt > now))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}

export function saveSession(session) {
  for (const cookie of session.cookies) {
    const result = writeKeychainSecret(keychainService(`cookie.${cookie.name}`), cookie.value);
    if (result.status !== 0) {
      throw new CliError("keychain_error", "Could not save the 聚水潭 session to macOS Keychain.");
    }
  }
  const authCookie = session.cookies.find((cookie) => cookie.name === "u_sso_token");
  const metadata = {
    profile: session.profile,
    syncedAt: session.syncedAt,
    expiresAt: authCookie?.expiresAt ? new Date(authCookie.expiresAt).toISOString() : "",
  };
  for (const [name, value] of Object.entries(metadata)) {
    const result = writeKeychainSecret(keychainService(`meta.${name}`), value);
    if (result.status !== 0) {
      throw new CliError("keychain_error", "Could not save session metadata to macOS Keychain.");
    }
  }
}

export function loadSession() {
  const expiresAtValue = readKeychainSecret(keychainService("meta.expiresAt"));
  const expiresAt = expiresAtValue ? Date.parse(expiresAtValue) : null;
  const cookies = ERP_COOKIE_NAMES.map((name) => ({
    host: ".erp321.com",
    name,
    value: readKeychainSecret(keychainService(`cookie.${name}`)),
    path: "/",
    secure: false,
    httpOnly: ["u_sso_token", "u_ssi", "u_cid", "u_json"].includes(name),
    expiresAt,
  })).filter((cookie) => cookie.value);
  if (cookies.some((cookie) => !cookie.value)) {
    throw new CliError("auth_required", "No complete saved session. Run: jst-inventory auth import");
  }
  return {
    version: 1,
    profile: readKeychainSecret(keychainService("meta.profile")) || "Default",
    syncedAt: readKeychainSecret(keychainService("meta.syncedAt")) || null,
    cookies,
  };
}

export function clearSession() {
  const services = [
    ...[...REQUIRED_COOKIE_NAMES].map((name) => keychainService(`cookie.${name}`)),
    ...["profile", "syncedAt", "expiresAt"].map((name) => keychainService(`meta.${name}`)),
    ...ERP_COOKIE_NAMES.map((name) => keychainService(`cookie.${name}`)),
    `${KEYCHAIN_PREFIX}.session`,
  ];
  let deleted = 0;
  for (const service of services) {
    const result = spawnSync(
      "/usr/bin/security",
      ["delete-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", service],
      { stdio: "ignore" },
    );
    if (result.status === 0) deleted += 1;
  }
  if (deleted === 0) {
    throw new CliError("auth_required", "No saved session was found.");
  }
}

export function sessionMetadata(session) {
  const authCookie = session.cookies.find((cookie) => cookie.name === "u_sso_token");
  return {
    profile: session.profile,
    synced_at: session.syncedAt,
    expires_at: authCookie?.expiresAt ? new Date(authCookie.expiresAt).toISOString() : null,
    cookie_count: session.cookies.length,
  };
}
