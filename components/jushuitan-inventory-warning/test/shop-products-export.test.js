import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { exportShopProducts, shopIdsFromInventory } from "../src/shop-products-export.js";

function inventory(path) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE shop_directory(shop_id TEXT PRIMARY KEY,shop_name TEXT,platform TEXT)");
  db.exec("INSERT INTO shop_directory VALUES('0','offline','线下'),('2','two','淘宝'),('1','one','拼多多')");
  db.close();
}

const session = { cookies: [
  { name: "u_sso_token", value: "token" },
  { name: "u_id", value: "user" },
  { name: "u_co_id", value: "company" },
] };

test("reads sorted exportable shop ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "shop-products-shops-"));
  const path = join(dir, "inventory.sqlite");
  inventory(path);
  assert.deepEqual(shopIdsFromInventory(path), ["1", "2"]);
});

test("exports planned batches and atomically writes a manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shop-products-export-"));
  const inventoryPath = join(dir, "inventory.sqlite");
  const planPath = join(dir, "plan.json");
  const outputDir = join(dir, "published");
  inventory(inventoryPath);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(planPath, JSON.stringify({ batches: [{ shops: ["1", "2"] }] }));
  const originalFetch = globalThis.fetch;
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2_000)]);
  globalThis.fetch = async (url) => {
    if (String(url).includes("MapExport.aspx")) {
      return new Response("", { status: 302, headers: {
        location: "https://files.example/export.xlsx?response-content-disposition=attachment%3Bfilename%3Dshop.xlsx",
      } });
    }
    return new Response(payload, { status: 200 });
  };
  try {
    const result = await exportShopProducts({ session, inventoryPath, outputDir, planPath });
    assert.equal(result.shop_count, 2);
    assert.equal(result.batch_count, 1);
    assert.equal(existsSync(join(outputDir, "shop.xlsx")), true);
    const manifest = JSON.parse(readFileSync(join(outputDir, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.files[0].shops, ["1", "2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("waits for an asynchronous export record and downloads its file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shop-products-async-"));
  const inventoryPath = join(dir, "inventory.sqlite");
  const outputDir = join(dir, "published");
  inventory(inventoryPath);
  const originalFetch = globalThis.fetch;
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2_000)]);
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("MapExport.aspx")) {
      return new Response("window.alert('店铺商品资料导出请求成功，请查看右上角导出记录进行下载')", { status: 200 });
    }
    if (value.includes("export_log.aspx") && options.method !== "POST") {
      return new Response(`
        <input name="__VIEWSTATE" value="state">
        <input name="__VIEWSTATEGENERATOR" value="generator">
      `, { status: 200 });
    }
    if (value.includes("export_log.aspx")) {
      const callback = JSON.parse(new URLSearchParams(options.body).get("__CALLBACKPARAM"));
      const returnValue = callback.Method === "LoadDataToJSON"
        ? JSON.stringify({ datas: [{
          auto_id: 42,
          export_type: "店铺商品资料",
          created: "2099-01-01 00:00:00",
          status: "文件已生成，可下载",
          message: "",
        }] })
        : "https://files.example/async.xlsx";
      return new Response(`0|${JSON.stringify({ IsSuccess: true, ReturnValue: returnValue })}`, { status: 200 });
    }
    return new Response(payload, { status: 200 });
  };
  try {
    const result = await exportShopProducts({ session, inventoryPath, outputDir });
    assert.equal(result.batch_count, 1);
    assert.equal(existsSync(join(outputDir, "async.xlsx")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("exports one shop through complete listed and unlisted filter partitions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shop-products-filtered-"));
  const inventoryPath = join(dir, "inventory.sqlite");
  const planPath = join(dir, "plan.json");
  const outputDir = join(dir, "published");
  inventory(inventoryPath);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(planPath, JSON.stringify({ batches: [
    { shops: ["1"], filters: [{ k: "enabled", v: "0", c: "=" }] },
    { shops: ["1"], filters: [{ k: "enabled", v: "1", c: "=" }] },
    { shops: ["2"] },
  ] }));
  const originalFetch = globalThis.fetch;
  const payload = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2_000)]);
  const exports = [];
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value === "https://www.erp321.com/app/item/itemtool/itemContrast.aspx") {
      return new Response(`
        <input name="__VIEWSTATE" value="state">
        <input name="__VIEWSTATEGENERATOR" value="generator">
        <input name="__EVENTVALIDATION" value="validation">
      `, { status: 200 });
    }
    if (value.includes("SetSearchConditionToCache")) {
      const callback = JSON.parse(new URLSearchParams(options.body).get("__CALLBACKPARAM"));
      const listed = JSON.parse(callback.Args[0]).find((filter) => filter.k === "enabled").v;
      const result = JSON.stringify({ IsSuccess: true, ReturnValue: `token-${listed}` });
      return new Response(`0|${result}`, { status: 200 });
    }
    if (value.includes("MapExport.aspx")) {
      const body = new URLSearchParams(options.body);
      exports.push({ url: value, shop: body.get("shop_id"), token: body.get("s") });
      return new Response("", { status: 302, headers: {
        location: `https://files.example/${exports.length}.xlsx`,
      } });
    }
    return new Response(payload, { status: 200 });
  };
  try {
    const result = await exportShopProducts({ session, inventoryPath, outputDir, planPath });
    assert.equal(result.batch_count, 3);
    assert.deepEqual(exports, [
      { url: `${"https://www-do.erp321.com/app/item/itemsku/MapExport.aspx"}?dt=filteritems&exporttype=`, shop: "1", token: "token-0" },
      { url: `${"https://www-do.erp321.com/app/item/itemsku/MapExport.aspx"}?dt=filteritems&exporttype=`, shop: "1", token: "token-1" },
      { url: `${"https://www-do.erp321.com/app/item/itemsku/MapExport.aspx"}?dt=&exporttype=`, shop: "2", token: null },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects a plan that omits a shop before requesting an export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shop-products-plan-"));
  const inventoryPath = join(dir, "inventory.sqlite");
  const planPath = join(dir, "plan.json");
  inventory(inventoryPath);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(planPath, JSON.stringify({ batches: [{ shops: ["1"] }] }));
  await assert.rejects(
    exportShopProducts({ session, inventoryPath, outputDir: join(dir, "out"), planPath }),
    (error) => error.code === "invalid_export_plan",
  );
});

test("rejects an incomplete filtered partition before requesting an export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "shop-products-incomplete-filter-"));
  const inventoryPath = join(dir, "inventory.sqlite");
  const planPath = join(dir, "plan.json");
  inventory(inventoryPath);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(planPath, JSON.stringify({ batches: [
    { shops: ["1"], filters: [{ k: "enabled", v: "0", c: "=" }] },
    { shops: ["2"] },
  ] }));
  await assert.rejects(
    exportShopProducts({ session, inventoryPath, outputDir: join(dir, "out"), planPath }),
    (error) => error.code === "invalid_export_plan",
  );
});
