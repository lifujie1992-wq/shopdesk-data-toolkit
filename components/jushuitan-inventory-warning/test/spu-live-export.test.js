import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { exportSpuInventoryToSqlite } from "../src/sqlite-export.js";

function temporaryOutput() {
  const directory = mkdtempSync(join(tmpdir(), "jst-spu-live-test-"));
  return { directory, outputPath: join(directory, "spu-live.sqlite") };
}

test("exports one strictly complete SPU and SKU snapshot", async () => {
  const { directory, outputPath } = temporaryOutput();
  const payloads = new Map([
    [1, { total: 3, data: [
      { spu_id: "spu-1", spu_name: "one", advice_purchase_qty: 9, pay_qty_today: 20,
        children: [{ sku_id: "sku-1", pay_qty_today: 20 }] },
      { spu_id: "spu-2", spu_name: "two", children: "[]" },
    ] }],
    [2, { total: 3, data: [{ spu_id: "spu-3", spu_name: "three", children: [] }] }],
  ]);

  try {
    const result = await exportSpuInventoryToSqlite({
      session: {},
      outputPath,
      pageSize: 2,
      concurrency: 2,
      fetchPage: async (page) => payloads.get(page),
    });
    assert.deepEqual(
      {
        total_spu: result.total_spu,
        fetched_spu: result.fetched_spu,
        fetched_sku: result.fetched_sku,
        pages: result.pages,
      },
      { total_spu: 3, fetched_spu: 3, fetched_sku: 1, pages: 2 },
    );

    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM spu_inventory").get().count, 3);
      assert.deepEqual(
        { ...db.prepare("SELECT schema_version,api_total_spu,fetched_spu,fetched_sku FROM export_info").get() },
        { schema_version: 7, api_total_spu: 3, fetched_spu: 3, fetched_sku: 1 },
      );
      assert.equal(
        JSON.parse(db.prepare("SELECT raw_json FROM spu_inventory WHERE spu_id='spu-1'").get().raw_json).children,
        undefined,
      );
      assert.deepEqual(
        { ...db.prepare("SELECT spu_id,sku_id FROM sku_inventory").get() },
        { spu_id: "spu-1", sku_id: "sku-1" },
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects an SPU snapshot whose today quantity does not match its SKUs", async () => {
  const { directory, outputPath } = temporaryOutput();
  try {
    await assert.rejects(
      exportSpuInventoryToSqlite({
        session: {}, outputPath, pageSize: 1,
        fetchPage: async () => ({ total: 1, data: [{
          spu_id: "spu-1", pay_qty_today: 20,
          children: [{ sku_id: "sku-1", pay_qty_today: 19 }],
        }] }),
      }),
      /does not equal SKU total 19/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects a changing total and preserves the previous committed snapshot", async () => {
  const { directory, outputPath } = temporaryOutput();
  try {
    await exportSpuInventoryToSqlite({
      session: {}, outputPath, pageSize: 1,
      fetchPage: async (page) => ({ total: 2, data: [{ spu_id: `old-${page}`, children: [{ sku_id: `old-sku-${page}` }] }] }),
    });

    await assert.rejects(
      exportSpuInventoryToSqlite({
        session: {}, outputPath, pageSize: 1,
        fetchPage: async (page) => page === 1
          ? { total: 2, data: [{ spu_id: "new-1", children: [{ sku_id: "new-sku-1" }] }] }
          : { total: 3, data: [{ spu_id: "new-2", children: [{ sku_id: "new-sku-2" }] }] },
      }),
      /total changed from 2 to 3/,
    );

    const db = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.deepEqual(
        db.prepare("SELECT spu_id FROM spu_inventory ORDER BY spu_id").all().map((row) => row.spu_id),
        ["old-1", "old-2"],
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects duplicate SPUs and incomplete pages", async () => {
  const duplicate = temporaryOutput();
  const incomplete = temporaryOutput();
  try {
    await assert.rejects(
      exportSpuInventoryToSqlite({
        session: {}, outputPath: duplicate.outputPath, pageSize: 1,
        fetchPage: async () => ({ total: 2, data: [{ spu_id: "same", children: [{ sku_id: "sku" }] }] }),
      }),
      /appeared more than once/,
    );
    await assert.rejects(
      exportSpuInventoryToSqlite({
        session: {}, outputPath: incomplete.outputPath, pageSize: 2,
        fetchPage: async () => ({ total: 2, data: [{ spu_id: "only-one", children: [{ sku_id: "sku" }] }] }),
      }),
      /returned 1 rows; expected 2/,
    );
  } finally {
    rmSync(duplicate.directory, { recursive: true, force: true });
    rmSync(incomplete.directory, { recursive: true, force: true });
  }
});
