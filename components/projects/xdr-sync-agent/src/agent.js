import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "./lock.js";
import { buildTransfer, checkDatabase } from "./patch.js";
import { runJson, runProcess } from "./process.js";
import { todayShanghai, yesterdayShanghai } from "./date.js";
import { Transport } from "./transport.js";
import { validTask } from "./validation.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TASK_DATASETS = {
  sync_all: ["inventory", "orders", "sales", "profit_analysis"], sync_inventory: ["inventory"],
  sync_hourly: ["inventory", "sales"],
  sync_orders: ["orders"],
  sync_sales: ["sales"], finalize_sales: ["sales"], sync_order_page: ["order_page"],
  sync_paid_orders: ["paid_orders"], sync_unshipped_orders: ["unshipped_orders"],
  sync_spu_live: ["spu_live"],
  sync_profit_analysis: ["profit_analysis"],
  sync_profit_facts: ["profit_facts"],
  sync_shop_products: ["shop_products"],
  sync_doudian: ["doudian"],
  sync_doudian_client: ["doudian_client"],
  sync_doudian_invoice: ["doudian_invoice"],
  sync_purple_orders: ["jst_purple_orders"],
};

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safeJson(path, fallback = {}) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } }

export class Agent {
  constructor(config, schemas, { now = () => new Date(), transport, runner = runJson, processRunner = runProcess } = {}) {
    this.config = config; this.schemas = schemas.datasets; this.now = now;
    this.runner = runner;
    this.processRunner = processRunner;
    this.agentId = (config.agent_id || `mac-${hostname()}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    this.leaseTasks = config.lease_tasks || null;
    this.leaseExcludeTasks = config.lease_exclude_tasks || null;
    this.transport = transport || new Transport(config, this.agentId);
    this.statusPath = join(config.state_dir, "status.json");
    mkdirSync(config.state_dir, { recursive: true, mode: 0o700 });
    mkdirSync(config.log_dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(config.state_dir, "baseline"), { recursive: true, mode: 0o700 });
    mkdirSync(join(config.state_dir, "work"), { recursive: true, mode: 0o700 });
    mkdirSync(join(config.state_dir, "checkpoints"), { recursive: true, mode: 0o700 });
  }
  setStatus(fields) {
    const old = safeJson(this.statusPath);
    writeFileSync(this.statusPath, `${JSON.stringify({ ...old, ...fields, updated_at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  }
  logDiagnostic(job, phase, error) {
    if (!error?.diagnostic) return;
    const record = { at: new Date().toISOString(), job_id: job.id, task: job.task, phase, ...error.diagnostic };
    appendFileSync(join(this.config.log_dir, "diagnostics.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  }
  baseline(dataset) { return join(this.config.state_dir, "baseline", this.schemas[dataset].filename); }
  async fetch(dataset, task, staging, source = "auto") {
    const date = task === "finalize_sales" ? yesterdayShanghai(this.now()) : todayShanghai(this.now());
    let command; let args;
    if (dataset === "inventory") {
      command = this.config.cli.inventory;
      const baseline = this.baseline("inventory");
      args = ["export-sqlite", "--output", staging, "--concurrency", "1",
        "--include-shop-shortage", "--shop-shortage-concurrency", "1"];
      // Sales windows come from paid-order Excel exports. Inventory refreshes
      // must never fan out into popup, drawer, trend, or shop/SKU sales requests.
      if (existsSync(baseline)) args.push("--reuse-sales-analysis", baseline);
      else args.push("--empty-sales-analysis");
    }
    if (dataset === "spu_live") {
      command = this.config.cli.inventory;
      // One source response already contains both SPU rows and SKU children;
      // the CLI validates and publishes the two grains as one snapshot.
      args = ["export-spu-sqlite", "--output", staging, "--concurrency", "1"];
    }
    if (dataset === "orders") {
      command = this.config.cli.orders;
      const baseline = this.baseline("orders");
      // Orders are always incremental: never backfill the full order history.
      args = ["sync-sqlite", "--days", "1",
        "--end-date", yesterdayShanghai(this.now()), "--concurrency", "1", "--output", staging];
      if (existsSync(baseline)) args.push("--merge-existing", baseline);
      const options = {
        timeoutMs: this.config.command_timeout_seconds * 1000,
        env: {
          ...process.env,
          JST_AUTOMATED: "1",
          ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
        },
      };
      const orders = await this.runner(command, args, options);
      const itemArgs = ["sync-sqlite", "--days", "1",
        "--end-date", yesterdayShanghai(this.now()), "--dimension", "item",
        "--concurrency", "1", "--append", "--output", staging];
      if (existsSync(baseline)) itemArgs.push("--merge-existing", baseline);
      const items = await this.runner(command, itemArgs, options);
      checkDatabase(staging, this.schemas[dataset]);
      return { orders, items };
    }
    if (dataset === "profit_facts") {
      command = this.config.cli.profit_facts;
      const baseline = this.baseline("profit_facts");
      args = ["export-sqlite", "--output", staging];
      if (existsSync(baseline)) args.push("--merge-existing", baseline);
      const captured = await this.runner(command, args, {
        timeoutMs: (this.config.profit_facts_command_timeout_seconds ?? 3_600) * 1000,
        env: {
          ...process.env,
          JST_AUTOMATED: "1",
          ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
        },
      });
      checkDatabase(staging, this.schemas[dataset]);
      return captured;
    }
    if (dataset === "sales") {
      command = this.config.cli.sales; args = ["sync-sqlite", "--date", date, "--output", staging];
      const source = existsSync(this.baseline("sales")) ? this.baseline("sales") : this.config.sales_seed;
      if (existsSync(source)) copyFileSync(source, staging);
    }
    if (dataset === "order_page") {
      command = this.config.cli.order_page;
      args = ["capture", "--limit", "20", "--output", staging];
    }
    if (dataset === "unshipped_orders") {
      // The unshipped backlog is a live snapshot: every run replaces the
      // previous one and patch diffing removes orders that have shipped.
      command = this.config.cli.order_page;
      args = ["sync-unshipped", "--output", staging];
      const options = {
        timeoutMs: (this.config.unshipped_command_timeout_seconds ?? 3_600) * 1000,
        env: {
          ...process.env,
          JST_AUTOMATED: "1",
          ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
        },
      };
      const captured = await this.runner(command, args, options);
      checkDatabase(staging, this.schemas[dataset]);
      return captured;
    }
    if (dataset === "paid_orders") {
      const baseline = this.baseline("paid_orders");
      const odsSource = existsSync(baseline) ? baseline : this.config.paid_orders_seed;
      if (!existsSync(odsSource)) throw new Error("paid_orders_seed_missing");
      copyFileSync(odsSource, staging);
      if (this.config.cli.order_page && existsSync(this.config.cli.order_page)) {
        const today = todayShanghai(this.now());
        const snapshot = join(dirname(staging), "today-paid.sqlite");
        const options = {
          timeoutMs: this.config.command_timeout_seconds * 1000,
          env: {
            ...process.env,
            JST_AUTOMATED: "1",
            ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
          },
        };
        const captured = await this.runner(this.config.cli.order_page, [
          "sync-day", "--date", today, "--date-field", "pay_date",
          "--settle-minutes", "2", "--output", snapshot,
        ], options);
        const inventory = [this.baseline("spu_live"), this.baseline("inventory")]
          .find(path => existsSync(path));
        const append = await runProcess("/usr/bin/python3", [
          join(PROJECT_ROOT, "scripts", "append-today-order-page.py"),
          "--ods", staging, "--today", snapshot, "--business-date", today,
          ...(inventory ? ["--inventory", inventory] : []),
        ], options);
        if (append.code !== 0 || append.timedOut) {
          throw Object.assign(new Error(append.timedOut ? "paid_orders_append_timeout" : "paid_orders_append_failed"),
            { diagnostic: { executable: "/usr/bin/python3", exit_code: append.code,
              signal: append.signal, timed_out: append.timedOut,
              stdout: append.stdout.slice(-2000), stderr: append.stderr.slice(-2000) } });
        }
        checkDatabase(staging, this.schemas[dataset]);
        return { captured, appended: JSON.parse(append.stdout.trim().split(/\r?\n/).at(-1)) };
      }
      checkDatabase(staging, this.schemas[dataset]);
      const db = new DatabaseSync(staging, { readOnly: true });
      try {
        return db.prepare("SELECT batch_id,business_date,start_date,end_date,captured_at FROM export_batches WHERE complete=1").get();
      } finally { db.close(); }
    }
    if (dataset === "profit_analysis") {
      const crawl = join(dirname(staging), "profit-analysis.crawl.json");
      const options = {
        timeoutMs: (this.config.profit_analysis_command_timeout_seconds ?? 3_600) * 1000,
        env: {
          ...process.env,
          JST_AUTOMATED: "1",
          ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
        },
      };
      const exported = await this.runner(this.config.cli.profit_analysis, [
        "profit-analysis", "crawl-json", "--output", crawl,
      ], options);
      const baseline = this.baseline("profit_analysis");
      const imported = await this.processRunner(this.config.excel_python, [
        join(PROJECT_ROOT, "scripts", "import-profit-analysis-export.py"),
        "--crawl-json", crawl, "--output", staging,
        "--start-date", exported.start_date, "--end-date", exported.end_date,
        ...(existsSync(baseline) ? ["--base", baseline] : []),
      ], options);
      if (imported.code !== 0 || imported.timedOut) {
        throw Object.assign(new Error(imported.timedOut ? "profit_analysis_import_timeout" : "profit_analysis_import_failed"),
          { diagnostic: { executable: this.config.excel_python, exit_code: imported.code,
            signal: imported.signal, timed_out: imported.timedOut,
            stdout: imported.stdout.slice(-2000), stderr: imported.stderr.slice(-2000) } });
      }
      let importResult;
      try { importResult = JSON.parse(imported.stdout.trim().split(/\r?\n/).at(-1)); }
      catch { throw new Error("profit_analysis_import_invalid_json"); }
      checkDatabase(staging, this.schemas[dataset]);
      return { exported, imported: importResult };
    }
    if (dataset === "doudian") {
      command = this.config.cli.doudian;
      args = ["export-sqlite", "--output", staging];
    }
    if (dataset === "doudian_client") {
      command = this.config.cli.doudian_client;
      args = ["export-sqlite", "--output", staging];
    }
    if (dataset === "doudian_invoice") {
      command = this.config.cli.doudian_invoice;
      args = ["export-sqlite", "--output", staging];
    }
    if (dataset === "jst_purple_orders") {
      command = this.config.cli.jst_purple_orders;
      args = ["export-sqlite", "--output", staging];
    }
    if (dataset === "shop_products") {
      const timeoutMs = (this.config.shop_products_command_timeout_seconds ?? 14_400) * 1000;
      const options = {
        timeoutMs,
        env: {
          ...process.env,
          JST_AUTOMATED: "1",
          JST_SHOP_PRODUCTS_NIGHT: "1",
          ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
        },
      };
      const baseline = this.baseline("shop_products");
      const inventory = this.baseline("inventory");
      if (!existsSync(inventory)) throw new Error("shop_products_inventory_baseline_missing");
      const sourceDir = join(dirname(staging), "shop-products-export");
      const exportPlan = join(dirname(staging), "shop-products-export-plan.json");
      const reusableExport = existsSync(join(sourceDir, "manifest.json"));
      let exported = { resumed: true };
      if (!reusableExport) {
        const planned = await this.processRunner(this.config.excel_python, [
          join(PROJECT_ROOT, "scripts", "plan-shop-product-exports.py"),
          "--inventory", inventory, "--output", exportPlan,
          ...(existsSync(baseline) ? ["--baseline", baseline] : []),
          "--target-rows", String(this.config.shop_products_target_rows ?? 900_000),
        ], options);
        if (planned.code !== 0 || planned.timedOut) {
          throw Object.assign(new Error(planned.timedOut ? "shop_products_plan_timeout" : "shop_products_plan_failed"),
            { diagnostic: { executable: this.config.excel_python, exit_code: planned.code,
              signal: planned.signal, timed_out: planned.timedOut,
              stdout: planned.stdout.slice(-2000), stderr: planned.stderr.slice(-2000) } });
        }
        exported = await this.runner(this.config.cli.inventory, [
          "shop-products", "export", "--inventory", inventory,
          "--output-dir", sourceDir, "--plan", exportPlan,
          "--resume-root", join(this.config.state_dir, "work"),
        ], options);
      }
      const building = join(dirname(staging), `.${basename(staging)}.building`);
      const imported = await this.processRunner(this.config.excel_python, [
        join(PROJECT_ROOT, "scripts", "import-shop-product-exports-duckdb.py"),
        "--source-dir", sourceDir,
        "--output", staging,
        ...(existsSync(baseline) ? ["--base", baseline] : []),
        "--inventory", inventory,
        ...(reusableExport && existsSync(building) ? ["--resume-building"] : []),
      ], options);
      if (imported.code !== 0 || imported.timedOut) {
        throw Object.assign(new Error(imported.timedOut ? "shop_products_import_timeout" : "shop_products_import_failed"),
          { diagnostic: { executable: this.config.excel_python, exit_code: imported.code,
            signal: imported.signal, timed_out: imported.timedOut,
            stdout: imported.stdout.slice(-2000), stderr: imported.stderr.slice(-2000) } });
      }
      let importResult;
      try { importResult = JSON.parse(imported.stdout.trim().split(/\r?\n/).at(-1)); }
      catch { throw new Error("shop_products_import_invalid_json"); }
      return { exported, imported: importResult };
    }
    const timeoutSeconds = dataset === "inventory"
      ? (this.config.inventory_command_timeout_seconds ?? 14_400)
      : this.config.command_timeout_seconds;
    const data = await this.runner(command, args, {
      timeoutMs: timeoutSeconds * 1000,
      env: {
        ...process.env,
        JST_AUTOMATED: "1",
        ...(source === "manual" ? { JST_MANUAL: "1" } : {}),
      },
    });
    checkDatabase(staging, this.schemas[dataset]);
    return data;
  }
  async runJob(job) {
    validTask(job.task);
    const datasets = TASK_DATASETS[job.task];
    const work = join(this.config.state_dir, "work", job.id);
    const reusableShopProducts = job.task === "sync_shop_products"
      && (existsSync(join(work, "shop-products-export", "manifest.json"))
        || existsSync(join(work, "shop-products-export.building", "checkpoint.json")));
    if (!reusableShopProducts) rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const staged = new Map(); let phase = "idle";
    // 心跳走独立子进程：主进程做同步 SQLite diff/校验时会阻塞事件循环，
    // 主进程内的 setInterval 会饿死 → 180s 租约过期 → 任务被判 lease_expired。
    const heartbeat = spawn(process.execPath, [
      join(PROJECT_ROOT, "bin", "heartbeat-loop.js"),
      job.id, this.statusPath, String(process.pid),
    ], { stdio: "ignore", env: process.env });
    heartbeat.unref();
    const stopHeartbeat = () => { try { heartbeat.kill("SIGTERM"); } catch { /* ignore */ } };
    try {
      for (const dataset of datasets) {
        phase = `fetching_${dataset}`; this.setStatus({ job_id: job.id, task: job.task, phase, started_at: job.started_at || new Date().toISOString(), completed_at: null, result: null, error: null, retry: null, dataset: null });
        await this.transport.heartbeat(job.id, phase).catch(() => {});
        const staging = join(work, `${dataset}.${dataset === "shop_products" ? "duckdb" : "sqlite"}`);
        await this.fetch(dataset, job.task, staging, job.source);
        staged.set(dataset, staging);
      }
      for (const dataset of datasets) {
        phase = "diffing"; this.setStatus({ phase, dataset }); await this.transport.heartbeat(job.id, phase).catch(() => {});
        let transfer;
        if (dataset === "shop_products") {
          const built = await this.processRunner(this.config.excel_python, [
            join(PROJECT_ROOT, "scripts", "build-shop-products-delta.py"),
            "--current", staged.get(dataset), "--base", this.baseline(dataset),
            "--output-dir", work, "--job-id", job.id,
            "--server-revision", job.revisions?.[dataset] ?? "",
            "--max-primary-change-ratio", String(this.config.shop_products_max_change_ratio ?? 0.35),
          ], { timeoutMs: (this.config.shop_products_command_timeout_seconds ?? 14_400) * 1000,
            env: { ...process.env } });
          if (built.code !== 0 || built.timedOut) {
            throw Object.assign(new Error(built.timedOut ? "shop_products_delta_timeout" : "shop_products_delta_failed"),
              { diagnostic: { executable: this.config.excel_python, exit_code: built.code,
                signal: built.signal, timed_out: built.timedOut,
                stdout: built.stdout.slice(-2000), stderr: built.stderr.slice(-2000) } });
          }
          try { transfer = JSON.parse(built.stdout.trim().split(/\r?\n/).at(-1)); }
          catch { throw new Error("shop_products_delta_invalid_json"); }
        } else {
          transfer = await buildTransfer({ jobId: job.id, dataset, staging: staged.get(dataset), baseline: this.baseline(dataset),
            outputDir: work, spec: this.schemas[dataset], serverRevision: job.revisions?.[dataset] ?? null });
        }
        phase = "uploading"; this.setStatus({ phase, dataset }); await this.transport.heartbeat(job.id, phase).catch(() => {});
        await this.transport.upload(job.id, dataset, transfer.data, transfer.sha);
        phase = "waiting_apply"; this.setStatus({ phase, dataset }); await this.transport.heartbeat(job.id, phase).catch(() => {});
        let applied = await this.transport.apply(job.id, dataset);
        if (applied.conflict && transfer.manifest.mode === "patch" && dataset !== "shop_products") {
          transfer = await buildTransfer({ jobId: job.id, dataset, staging: staged.get(dataset), baseline: this.baseline(dataset),
            outputDir: work, spec: this.schemas[dataset], serverRevision: applied.current_revision ?? null, forceFull: true });
          phase = "uploading"; this.setStatus({ phase, dataset, retry: "full" });
          await this.transport.upload(job.id, dataset, transfer.data, transfer.sha);
          phase = "waiting_apply"; applied = await this.transport.apply(job.id, dataset);
        }
        if (applied.conflict && dataset === "shop_products") throw new Error("shop_products_revision_conflict");
        if (!applied.applied && !applied.idempotent) throw new Error("server_apply_failed");
      }
      await this.transport.complete(job.id);
      for (const [dataset, source] of staged) {
        const target = this.baseline(dataset); const temp = `${target}.new`;
        copyFileSync(source, temp); renameSync(temp, target);
      }
      this.setStatus({ job_id: job.id, task: job.task, phase: "idle", result: "success", completed_at: new Date().toISOString(), dataset: null });
      rmSync(work, { recursive: true, force: true });
      return true;
    } catch (error) {
      this.logDiagnostic(job, phase, error);
      const code = String(error?.message || error).replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 160);
      this.setStatus({ job_id: job.id, task: job.task, phase, result: "failed", error: code, completed_at: new Date().toISOString() });
      await this.transport.fail(job.id, code).catch(() => {});
      return false;
    } finally { stopHeartbeat(); }
  }
  async pollOnce() {
    let job;
    try { job = await this.transport.lease(this.leaseTasks, this.leaseExcludeTasks); } catch (error) { this.setStatus({ phase: "idle", connectivity: "offline", error: "server_unreachable" }); return false; }
    this.setStatus({ connectivity: "online" });
    if (!job?.job) return false;
    return this.runJob(job.job);
  }
  async daemon() {
    const release = acquireLock(this.config.state_dir);
    const wake = () => { this._wake = true; };
    process.on("SIGCONT", wake); process.on("SIGHUP", wake);
    try {
      for (;;) {
        await this.pollOnce();
        for (let i = 0; i < this.config.poll_seconds * 2 && !this._wake; i += 1) await sleep(500);
        this._wake = false;
      }
    } finally { release(); }
  }
  async runOnce() { const release = acquireLock(this.config.state_dir); try { return await this.pollOnce(); } finally { release(); } }
  localStatus() { return safeJson(this.statusPath, { phase: "idle", result: "never_run" }); }
}

export async function doctor(config, schemas) {
  const checks = [];
  const launchPath = [...new Set(Object.values(config.cli).map(dirname))].concat(["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]).join(":");
  for (const [dataset, executable] of Object.entries(config.cli)) {
    const found = executable.startsWith("/") && existsSync(executable); checks.push({ name: `cli_${dataset}`, ok: found, executable });
    if (!found) continue;
    const args = dataset === "inventory" || dataset === "order_page" || dataset === "profit_analysis"
      ? ["login-status"]
      : ["login-status", ...(dataset === "orders" ? ["--end-date", todayShanghai()] : ["--date", todayShanghai()])];    try { await runJson(executable, args, { timeoutMs: 60_000 }); checks.push({ name: `auth_${dataset}_terminal`, ok: true }); }
    catch { checks.push({ name: `auth_${dataset}_terminal`, ok: false }); }
    try { await runJson(executable, args, { timeoutMs: 60_000, env: { HOME: process.env.HOME, PATH: launchPath, LANG: "en_US.UTF-8" } }); checks.push({ name: `auth_${dataset}_launchagent`, ok: true }); }
    catch { checks.push({ name: `auth_${dataset}_launchagent`, ok: false }); }
  }
  try { await new Transport(config, `doctor-${hostname()}`.replace(/[^A-Za-z0-9._-]/g, "-")).status(); checks.push({ name: "server", ok: true }); }
  catch { checks.push({ name: "server", ok: false }); }
  return { ok: checks.every((x) => x.ok), checks, timezone: "Asia/Shanghai", schema_version: schemas.format_version };
}
