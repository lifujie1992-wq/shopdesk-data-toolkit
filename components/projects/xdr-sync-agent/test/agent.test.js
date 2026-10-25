import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Agent } from "../src/agent.js";
test("offline poll is retained for next daemon iteration",async()=>{const dir=mkdtempSync(join(tmpdir(),"xdr-agent-"));const config={state_dir:dir,log_dir:dir,poll_seconds:1,command_timeout_seconds:1,cli:{},server:{},sales_seed:""};const transport={lease:async()=>{throw new Error("offline")}};const agent=new Agent(config,{datasets:{}},{transport});assert.equal(await agent.pollOnce(),false);assert.equal(agent.localStatus().connectivity,"offline");});

test("paid-order task copies only the validated ODS seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-paid-"));
  const seed = join(dir, "seed.sqlite"); const staging = join(dir, "staging.sqlite");
  const db = new DatabaseSync(seed);
  db.exec("CREATE TABLE export_batches(batch_id TEXT,business_date TEXT,start_date TEXT,end_date TEXT,captured_at TEXT,complete INTEGER); INSERT INTO export_batches VALUES('batch','2026-09-09','2026-08-10','2026-09-09','2026-09-09T00:00:00Z',1)");
  db.close();
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1,
    cli: {}, server: {}, sales_seed: "", paid_orders_seed: seed };
  const schemas = { datasets: { paid_orders: { filename: "paid.sqlite",
    primary_table: "export_batches", tables: { export_batches: { pk: ["batch_id"],
      columns: ["batch_id", "business_date", "start_date", "end_date", "captured_at", "complete"] } } } } };
  const agent = new Agent(config, schemas, { transport: {} });
  const result = await agent.fetch("paid_orders", "sync_paid_orders", staging);
  assert.equal(result.batch_id, "batch");
  assert.equal(existsSync(staging), true);
});

test("inventory fetch includes shop shortage tables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-inventory-"));
  const staging = join(dir, "inventory.sqlite");
  let invocation;
  const runner = async (command, args, options) => {
    invocation = { command, args, options };
    const db = new DatabaseSync(staging);
    db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)");
    db.close();
    return { ok: true };
  };
  const config = {
    state_dir: dir,
    log_dir: dir,
    poll_seconds: 1,
    command_timeout_seconds: 1,
    cli: { inventory: "/tmp/jst-inventory" },
    server: {},
    sales_seed: "",
  };
  const schemas = { datasets: { inventory: {
    filename: "inventory.sqlite",
    primary_table: "items",
    tables: { items: { pk: ["id"], columns: ["id"] } },
  } } };
  const agent = new Agent(config, schemas, { runner, transport: {} });
  await agent.fetch("inventory", "sync_inventory", staging);
  assert.equal(invocation.command, "/tmp/jst-inventory");
  assert.deepEqual(invocation.args, [
    "export-sqlite", "--output", staging, "--concurrency", "1", "--include-shop-shortage",
    "--shop-shortage-concurrency", "1", "--empty-sales-analysis",
  ]);
  assert.equal(invocation.options.timeoutMs, 14_400_000);
  assert.equal(invocation.options.env.JST_AUTOMATED, "1");
  assert.equal(invocation.options.env.JST_MANUAL, undefined);
});

test("SPU live fetch uses the lightweight exporter and normal timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-spu-live-"));
  const staging = join(dir, "spu-live.sqlite");
  let invocation;
  const runner = async (command, args, options) => {
    invocation = { command, args, options };
    const db = new DatabaseSync(staging);
    db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)");
    db.close();
    return { ok: true };
  };
  const config = {
    state_dir: dir, log_dir: dir, command_timeout_seconds: 1200,
    inventory_command_timeout_seconds: 172800,
    cli: { inventory: "/tmp/jst-inventory" }, server: {}, sales_seed: "",
  };
  const schemas = { datasets: { spu_live: {
    filename: "spu-live.sqlite", primary_table: "items",
    tables: { items: { pk: ["id"], columns: ["id"] } },
  } } };
  const agent = new Agent(config, schemas, { runner, transport: {} });

  await agent.fetch("spu_live", "sync_spu_live", staging);

  assert.equal(invocation.command, "/tmp/jst-inventory");
  assert.deepEqual(invocation.args, [
    "export-spu-sqlite", "--output", staging, "--concurrency", "1",
  ]);
  assert.equal(invocation.options.timeoutMs, 1_200_000);
  assert.equal(invocation.options.env.JST_AUTOMATED, "1");
});

test("profit analysis crawls page data and imports it into SQLite", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-profit-"));
  const staging = join(dir, "profit.sqlite");
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ kind: "export", command, args, options });
    return { start_date: "2026-09-03", end_date: "2026-09-09", row_count: 2 };
  };
  const processRunner = async (command, args, options) => {
    calls.push({ kind: "import", command, args, options });
    const db = new DatabaseSync(staging);
    db.exec("CREATE TABLE runs(start_date TEXT PRIMARY KEY); CREATE TABLE items(start_date TEXT,sku_id TEXT,PRIMARY KEY(start_date,sku_id)); INSERT INTO runs VALUES('2026-09-03'); INSERT INTO items VALUES('2026-09-03','sku-1')");
    db.close();
    return { code: 0, timedOut: false, signal: null,
      stdout: '{"row_count":1}', stderr: "" };
  };
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1200,
    profit_analysis_command_timeout_seconds: 3600,
    excel_python: "/tmp/xdr/.venv/bin/python",
    cli: { profit_analysis: "/tmp/jst-inventory" }, server: {}, sales_seed: "" };
  const schemas = { datasets: { profit_analysis: { filename: "profit.sqlite",
    primary_table: "items", tables: {
      runs: { pk: ["start_date"], columns: ["start_date"] },
      items: { pk: ["start_date", "sku_id"], columns: ["start_date", "sku_id"] },
    } } } };
  const agent = new Agent(config, schemas, { runner, processRunner, transport: {} });
  const result = await agent.fetch("profit_analysis", "sync_profit_analysis", staging, "manual");
  assert.deepEqual(calls[0].args, ["profit-analysis", "crawl-json", "--output", join(dir, "profit-analysis.crawl.json")]);
  assert.equal(calls[0].options.env.JST_MANUAL, "1");
  assert.equal(calls[1].command, "/tmp/xdr/.venv/bin/python");
  assert.deepEqual(calls[1].args.slice(-4), ["--start-date", "2026-09-03", "--end-date", "2026-09-09"]);
  assert.deepEqual(calls[1].args.slice(1, 3), ["--crawl-json", join(dir, "profit-analysis.crawl.json")]);
  assert.equal(result.imported.row_count, 1);
});

test("shop products are planned, exported, then imported into DuckDB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-shop-products-"));
  const staging = join(dir, "shop-products.duckdb");
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ kind: "export", command, args, options });
    return { shop_count: 2, batch_count: 1 };
  };
  const processRunner = async (command, args, options) => {
    calls.push({ kind: args[0].includes("plan-") ? "plan" : "import", command, args, options });
    return { code: 0, timedOut: false, signal: null,
      stdout: args[0].includes("plan-") ? '{"batch_count":1}' : '{"sku_count":15503447,"warehouse":"duckdb"}',
      stderr: "" };
  };
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1200,
    shop_products_command_timeout_seconds: 43200, shop_products_target_rows: 900000,
    excel_python: "/tmp/xdr/.venv/bin/python",
    cli: { inventory: "/tmp/jst-inventory" }, server: {}, sales_seed: "" };
  const schemas = { datasets: { shop_products: {
    filename: "jst-shop-products.duckdb", primary_table: "shop_product_skus", tables: {},
  }, inventory: { filename: "inventory.sqlite", tables: {} },
  spu_live: { filename: "spu-live.sqlite", tables: {} } } };
  const agent = new Agent(config, schemas, { runner, processRunner, transport: {} });
  const inventory = agent.baseline("inventory");
  const db = new DatabaseSync(inventory); db.exec("CREATE TABLE shop_directory(shop_id TEXT)"); db.close();
  const result = await agent.fetch("shop_products", "sync_shop_products", staging, "manual");
  assert.equal(calls[0].kind, "plan");
  assert.match(calls[0].args[0], /plan-shop-product-exports\.py$/);
  assert.deepEqual(calls[1].args.slice(0, 2), ["shop-products", "export"]);
  assert.equal(calls[1].options.env.JST_MANUAL, "1");
  assert.equal(calls[2].kind, "import");
  assert.match(calls[2].args[0], /import-shop-product-exports-duckdb\.py$/);
  assert.equal(result.imported.warehouse, "duckdb");
  calls.length = 0;
  await agent.fetch("shop_products", "sync_shop_products", staging, "auto");
  assert.equal(calls[1].options.env.JST_SHOP_PRODUCTS_NIGHT, "1");
  assert.equal(calls[1].args[calls[1].args.indexOf("--resume-root") + 1], join(dir, "work"));
  assert.equal(calls[1].options.env.JST_AUTOMATED, "1");
  assert.notEqual(calls[1].options.env.JST_MANUAL, "1");
});

test("manual inventory fetch carries an explicit quiet-hours override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-manual-"));
  const staging = join(dir, "inventory.sqlite");
  let invocation;
  const runner = async (command, args, options) => {
    invocation = { command, args, options };
    const db = new DatabaseSync(staging);
    db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)");
    db.close();
    return { ok: true };
  };
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1,
    cli: { inventory: "/tmp/jst-inventory" }, server: {}, sales_seed: "" };
  const schemas = { datasets: { inventory: { filename: "inventory.sqlite",
    primary_table: "items", tables: { items: { pk: ["id"], columns: ["id"] } } } } };
  const agent = new Agent(config, schemas, { runner, transport: {} });
  await agent.fetch("inventory", "sync_inventory", staging, "manual");
  assert.equal(invocation.options.env.JST_AUTOMATED, "1");
  assert.equal(invocation.options.env.JST_MANUAL, "1");
});

test("hourly inventory reuses the existing sales analysis snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-reuse-analysis-"));
  const staging = join(dir, "staging.sqlite");
  let invocation;
  const runner = async (command, args) => {
    invocation = { command, args };
    const db = new DatabaseSync(staging);
    db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)");
    db.close();
    return { ok: true };
  };
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1,
    cli: { inventory: "/tmp/jst-inventory" }, server: {}, sales_seed: "" };
  const schemas = { datasets: { inventory: { filename: "inventory.sqlite",
    primary_table: "items", tables: { items: { pk: ["id"], columns: ["id"] } } } } };
  const agent = new Agent(config, schemas, { runner, transport: {} });
  const baseline = agent.baseline("inventory");
  const db = new DatabaseSync(baseline); db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)"); db.close();

  await agent.fetch("inventory", "sync_all", staging, "auto");
  assert.deepEqual(invocation.args.slice(-2), ["--reuse-sales-analysis", baseline]);
  assert.equal(invocation.args.includes("--include-sales-analysis"), false);
});

test("orders fetch only yesterday and merge it into the historical baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-orders-daily-"));
  const staging = join(dir, "staging.sqlite");
  const invocations = [];
  const runner = async (command, args) => {
    invocations.push({ command, args });
    if (invocations.length === 1) {
      const db = new DatabaseSync(staging); db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)"); db.close();
    }
    return { ok: true };
  };
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1,
    cli: { orders: "/tmp/jst-orders" }, server: {}, sales_seed: "" };
  const schemas = { datasets: { orders: { filename: "orders.sqlite",
    primary_table: "items", tables: { items: { pk: ["id"], columns: ["id"] } } } } };
  const agent = new Agent(config, schemas, {
    runner,
    transport: {},
    now: () => new Date("2026-09-08T01:00:00Z"),
  });
  const baseline = agent.baseline("orders");
  const db = new DatabaseSync(baseline); db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)"); db.close();

  await agent.fetch("orders", "sync_orders", staging, "auto");
  assert.deepEqual(invocations[0].args, [
    "sync-sqlite", "--days", "1", "--end-date", "2026-09-07", "--concurrency", "1", "--output", staging,
    "--merge-existing", baseline,
  ]);
  assert.deepEqual(invocations[1].args, [
    "sync-sqlite", "--days", "1", "--end-date", "2026-09-07", "--dimension", "item",
    "--concurrency", "1", "--append", "--output", staging, "--merge-existing", baseline,
  ]);
});

test("first XDR orders sync also fetches only yesterday", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xdr-agent-orders-first-daily-"));
  const staging = join(dir, "staging.sqlite");
  const invocations = [];
  const runner = async (command, args) => {
    invocations.push({ command, args });
    if (invocations.length === 1) {
      const db = new DatabaseSync(staging); db.exec("CREATE TABLE items(id TEXT PRIMARY KEY)"); db.close();
    }
    return { ok: true };
  };
  const config = { state_dir: dir, log_dir: dir, command_timeout_seconds: 1,
    cli: { orders: "/tmp/jst-orders" }, server: {}, sales_seed: "" };
  const schemas = { datasets: { orders: { filename: "orders.sqlite",
    primary_table: "items", tables: { items: { pk: ["id"], columns: ["id"] } } } } };
  const agent = new Agent(config, schemas, {
    runner,
    transport: {},
    now: () => new Date("2026-09-08T01:00:00Z"),
  });

  await agent.fetch("orders", "sync_orders", staging, "auto");
  assert.deepEqual(invocations[0].args, [
    "sync-sqlite", "--days", "1", "--end-date", "2026-09-07", "--concurrency", "1", "--output", staging,
  ]);
  assert.deepEqual(invocations[1].args, [
    "sync-sqlite", "--days", "1", "--end-date", "2026-09-07", "--dimension", "item",
    "--concurrency", "1", "--append", "--output", staging,
  ]);
});
