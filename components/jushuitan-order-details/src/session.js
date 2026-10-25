import { spawnSync } from "node:child_process";

import { CliError } from "./errors.js";

const ACCOUNT = "erp321.com";
const PREFIXES = ["com.xx-cli.jst-orders", "com.xx-cli.jst-inventory"];
const NAMES = ["u_sso_token", "u_id", "u_co_id"];

function keychainSecret(service) {
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-a", ACCOUNT, "-s", service, "-w"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? result.stdout.trim() : null;
}

export function loadSession() {
  for (const prefix of PREFIXES) {
    const cookies = NAMES.map((name) => ({ name, value: keychainSecret(`${prefix}.cookie.${name}`) }));
    if (cookies.every(({ value }) => value)) return { cookies };
  }
  throw new CliError("auth_required", "No saved 聚水潭 session. Run: jst-inventory auth import");
}

export function cookieHeader(session) {
  return session.cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
}

export function cookieValue(session, name) {
  return session.cookies.find((cookie) => cookie.name === name)?.value ?? "";
}
