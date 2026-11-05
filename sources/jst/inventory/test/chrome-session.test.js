import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import test from "node:test";

import {
  chromeTimeToUnixMs,
  decryptChromeCookie,
  deriveChromeKey,
  sessionFromCookieHeader,
} from "../src/chrome-session.js";

test("decrypts a Chrome v10 version 24 cookie", () => {
  const host = ".erp321.com";
  const password = "test-password";
  const key = deriveChromeKey(password);
  const plaintext = Buffer.concat([
    createHash("sha256").update(host).digest(),
    Buffer.from("session-value"),
  ]);
  const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  const encryptedValue = Buffer.concat([
    Buffer.from("v10"),
    cipher.update(plaintext),
    cipher.final(),
  ]);

  assert.equal(
    decryptChromeCookie({ encryptedValue, host, dbVersion: 24, key }),
    "session-value",
  );
});

test("converts Chrome epoch microseconds", () => {
  const unixMs = Date.UTC(2026, 8, 6, 10, 0, 0);
  const chromeMicros = BigInt(unixMs + 11_644_473_600_000) * 1000n;
  assert.equal(chromeTimeToUnixMs(chromeMicros), unixMs);
});

test("imports only the required fields from a full Cookie header", () => {
  const session = sessionFromCookieHeader(
    "Cookie: other=ignored; u_id=user-1; u_sso_token=token=a=b; u_co_id=company-1",
  );
  assert.deepEqual(
    session.cookies.map(({ name, value }) => ({ name, value })),
    [
      { name: "u_sso_token", value: "token=a=b" },
      { name: "u_id", value: "user-1" },
      { name: "u_co_id", value: "company-1" },
    ],
  );
});

test("rejects an incomplete Cookie header", () => {
  assert.throws(
    () => sessionFromCookieHeader("u_sso_token=token; u_id=user"),
    (error) => error.code === "invalid_cookie" && error.message.includes("u_co_id"),
  );
});
