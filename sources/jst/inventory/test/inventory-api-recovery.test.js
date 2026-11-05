import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CliError } from "../src/errors.js";
import { exportInventoryToSqlite } from "../src/sqlite-export.js";

const shopPayload = () => ({ data: [{ shop_id: "test-shop", shop_name: "测试店铺", platform: "测试平台" }] });

function options(t) {
  const root = mkdtempSync(join(tmpdir(), "inventory-api-recovery-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    session: {}, outputPath: join(root, "inventory.sqlite"),
    pageSize: 1, concurrency: 1, retryDelaysMs: [0, 0],
    fetchShops: async () => shopPayload(),
    fetchShopGroups: async () => ({ data: [] }),
  };
}

function systemError(status = 200) {
  return new CliError("api_error", "系统异常，请稍后再试", {
    api_code: "purchase_alarm_sku_detail", http_status: status,
    response: { code: 9001, success: false, message: "系统异常，请稍后再试" },
  });
}

function page(id, total = 1) {
  return { total, data: [{ spu_id: id, children: [{ sku_id: `${id}-sku` }] }] };
}

test("hourly inventory export retries page 54 without fetching completed pages or directories again", async t => {
  const calls = [], retries = [];
  let failedPageCalls = 0, shopCalls = 0, groupCalls = 0;
  const opts = options(t);
  const result = await exportInventoryToSqlite({
    ...opts,
    fetchShops: async () => { shopCalls++; return shopPayload(); },
    fetchShopGroups: async () => { groupCalls++; return { data: [] }; },
    fetchPage: async number => {
      calls.push(number);
      if (number === 54 && ++failedPageCalls <= 2) throw systemError();
      return page(`spu-${number}`, 55);
    },
    onProgress: progress => { if (progress.event === "retry") retries.push(progress); },
  });
  assert.deepEqual(calls, [...Array.from({ length: 54 }, (_, i) => i + 1), 54, 54, 55]);
  assert.equal(shopCalls, 1);
  assert.equal(groupCalls, 1);
  assert.equal(result.fetched_spu, 55);
  assert.equal(result.fetched_sku, 55);
  assert.deepEqual(retries.map(p => [p.pageNum, p.attempt]), [[54, 1], [54, 2]]);
  const db = new DatabaseSync(opts.outputPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM spu_inventory").get().n, 55);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sku_inventory").get().n, 55);
  } finally { db.close(); }
});

test("exhausted inventory retries report three attempts and roll back to the complete snapshot", async t => {
  const opts = options(t);
  await exportInventoryToSqlite({ ...opts, fetchPage: async () => page("old") });
  const calls = [];
  await assert.rejects(exportInventoryToSqlite({
    ...opts,
    fetchPage: async number => {
      calls.push(number);
      if (number === 2) throw systemError(503);
      return page("new", 2);
    },
  }), error => {
    assert.equal(error.code, "api_error");
    assert.deepEqual(error.diagnostic, {
      api_code: "purchase_alarm_sku_detail", http_status: 503,
      page_num: 2, page_size: 1, attempts: 3,
      response: { code: 9001, success: false, message: "系统异常，请稍后再试" },
    });
    return true;
  });
  assert.deepEqual(calls, [1, 2, 2, 2]);
  const db = new DatabaseSync(opts.outputPath, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT spu_id FROM spu_inventory").all().map(r => r.spu_id), ["old"]);
    assert.equal(db.prepare("SELECT fetched_spu FROM export_info").get().fetched_spu, 1);
  } finally { db.close(); }
});

test("inventory export does not retry login, permission, network, ordinary API or invalid response errors", async t => {
  for (const error of [
    new CliError("not_logged_in", "未登录"),
    systemError(403), systemError(429),
    new CliError("network_error", "request failed"),
    new CliError("api_error", "参数错误", { http_status: 200 }),
    new CliError("invalid_response", "non-array page payload"),
  ]) {
    let calls = 0;
    await assert.rejects(exportInventoryToSqlite({
      ...options(t), fetchPage: async () => { calls++; throw error; },
    }), result => result.code === error.code && result.message === error.message);
    assert.equal(calls, 1);
  }
});
