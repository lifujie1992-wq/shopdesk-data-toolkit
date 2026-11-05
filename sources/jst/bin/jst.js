#!/usr/bin/env node
/**
 * 聚水潭统一 CLI。
 *
 * 取代 7 个独立二进制：jst-orders / jst-sales / jst-inventory /
 * jst-order-page / jst-aftersales / jst-purple-orders / build_facts.py。
 *
 * 迁移状态见 docs/MIGRATION.md：
 *   ✅ orders / sales   已迁移并对拍
 *   ⏳ inventory / order-page / aftersales / purple / profit  阶段 2
 */
import {
  CliError,
  JST_COOKIE_NAMES,
  JST_KEYCHAIN_ACCOUNT,
  createProgram,
  describeSession,
  jsonProvider,
  loadSession,
  parseFlags,
  run,
  runDoctor,
  writeKeychainSecret,
} from "@shopdesk/core";

import * as orders from "../src/orders.js";
import { main as inventoryMain } from "../inventory/bin/jst-inventory.js";
import { cli as orderPageCli } from "../order-page/bin/jst-order-page.js";
import { cli as aftersalesCli } from "../aftersales/bin/jst-aftersales.js";
import { cli as refundCli } from "../aftersales/export-refund-daily.mjs";
import * as sales from "../src/sales.js";

/* ------------------------------------------------------------------ *
 * orders
 * ------------------------------------------------------------------ */

const ORDERS_HELP = `Usage: jst orders <command> [options]

Commands:
  login-status               Validate access with a one-row request
  count                      Count orders and read the API totals
  sync-sqlite                Export the full date range to SQLite
  summary                    Read the saved snapshot metadata and totals
  list                       Read saved orders without private recipient fields

Options:
  --days N                   Inclusive day count, default 30, maximum 366
  --end-date YYYY-MM-DD      Last report day, default yesterday in Shanghai
  --output PATH              Default: 新数据目录，若旧文件存在则沿用旧文件
  --merge-existing PATH      Preserve dates outside the requested range
  --page-size N              Export page size, default 5000, maximum 5000
  --concurrency N            Parallel requests, default 3, maximum 4
  --dimension NAME           order (default) or item (订单（商品）)
  --append                   Append item tables to an existing database
  --limit N                  List limit, default 20, maximum 500

Filters match the verified page: send date, sent orders, split bundles,
exclude unfinished orders, exchange orders, 特殊单, and 统计排除标.`;

const ORDERS_FLAGS = {
  days: { type: "number", default: 30, min: 1, max: 366 },
  "end-date": { type: "string" },
  output: { type: "string" },
  "merge-existing": { type: "string" },
  "page-size": { type: "number", default: 5000, min: 1, max: 5000 },
  concurrency: { type: "number", default: 3, min: 1, max: 4 },
  dimension: { type: "string", default: "order", values: ["order", "item"] },
  append: { type: "boolean" },
  limit: { type: "number", default: 20, min: 1, max: 500 },
};

async function runOrders(args) {
  const [sub, ...rest] = args;
  if (!sub) {
    process.stdout.write(`${ORDERS_HELP}\n`);
    return undefined;
  }

  const flags = parseFlags(rest, ORDERS_FLAGS);
  const range = orders.inputRange({ days: flags.days, endDate: flags["end-date"] });
  const dimension = flags.dimension;
  const outputPath = flags.output ?? orders.defaultOutputPath(dimension);

  if (sub === "login-status") {
    const session = loadSession();
    const oneDay = orders.inputRange({ days: 1, endDate: flags["end-date"] });
    const payload = await orders.fetchOrderPage(session, oneDay, 1, 1, dimension);
    return {
      logged_in: true,
      end_date: oneDay.end_date,
      dimension,
      total: Number(payload.total ?? 0),
    };
  }

  if (sub === "count") {
    const session = loadSession();
    const [detail, summary] = await Promise.all([
      orders.fetchOrderPage(session, range, 1, 1, dimension),
      orders.fetchOrderSummary(session, range, dimension),
    ]);
    return {
      start_date: range.start_date,
      end_date: range.end_date,
      dimension,
      total: Number(detail.total ?? 0),
      summary: summary.data ?? [],
    };
  }

  if (sub === "sync-sqlite") {
    const session = loadSession();
    if (flags.append && dimension !== "item") {
      throw new CliError("invalid_arguments", "--append is only valid with --dimension item.");
    }
    if (dimension === "item") {
      throw new CliError(
        "not_migrated",
        "item 维度尚未迁移（阶段 2）。暂时请用旧命令：jst-orders sync-sqlite --dimension item",
      );
    }
    const result = await orders.exportOrdersToSqlite({
      session,
      range,
      outputPath,
      pageSize: flags["page-size"],
      concurrency: flags.concurrency,
      mergeFromPath: flags["merge-existing"] ?? null,
      dimension,
      onProgress: ({ completedPages, pages, fetchedRows }) => {
        if (completedPages === pages || completedPages % 10 === 0) {
          process.stderr.write(`Exported ${completedPages}/${pages} pages (${fetchedRows} rows)\n`);
        }
      },
    });
    return { ...result, dimension };
  }

  if (sub === "summary") return orders.readOrderSummary(outputPath);
  if (sub === "list") return { rows: orders.readOrders(outputPath, flags.limit) };

  throw new CliError("unknown_command", `Unknown orders command: ${sub}`);
}

/* ------------------------------------------------------------------ *
 * sales
 * ------------------------------------------------------------------ */

const SALES_HELP = `Usage: jst sales <command> [options]

Commands:
  login-status               Validate the saved 聚水潭 session
  fetch                      Fetch one day's shop sales report
  sync-sqlite                Replace one day's rows in SQLite
  summary                    Summarize one saved report date
  list                       Read saved rows ordered by net sales

Options:
  --date YYYY-MM-DD          Report date, default yesterday (Asia/Shanghai)
  --output PATH              Default: 新数据目录，若旧文件存在则沿用旧文件
  --limit N                  List row limit, default 20, maximum 500`;

const SALES_FLAGS = {
  date: { type: "string" },
  output: { type: "string" },
  limit: { type: "number", default: 20, min: 1, max: 500 },
};

async function runSales(args) {
  const [sub, ...rest] = args;
  if (!sub) {
    process.stdout.write(`${SALES_HELP}\n`);
    return undefined;
  }
  const flags = parseFlags(rest, SALES_FLAGS);
  const date = sales.assertDate(flags.date ?? sales.yesterdayShanghai());
  const outputPath = flags.output ?? sales.defaultOutputPath();

  if (sub === "login-status") {
    const session = loadSession();
    const result = await sales.fetchSalesPerformance(session, date);
    return { logged_in: true, report_date: date, shop_count: result.rows.length };
  }

  if (sub === "fetch") {
    const session = loadSession();
    const result = await sales.fetchSalesPerformance(session, date);
    const syncedAt = new Date().toISOString();
    return {
      report_date: date,
      total: result.total,
      rows: result.rows.map((row) => sales.normalizeSalesRow(date, row, syncedAt)),
    };
  }

  if (sub === "sync-sqlite") {
    const session = loadSession();
    const startedAt = new Date();
    const result = await sales.fetchSalesPerformance(session, date);
    const syncedAt = new Date().toISOString();
    const rows = result.rows.map((row) => sales.normalizeSalesRow(date, row, syncedAt));
    return sales.writeSalesSnapshot({
      outputPath,
      reportDate: date,
      rows,
      sourceTotal: result.total,
      startedAt,
    });
  }

  if (sub === "list") {
    return { report_date: date, rows: sales.readSalesRows(outputPath, date, flags.limit) };
  }

  if (sub === "summary") return sales.readSalesSummary(outputPath, date);

  throw new CliError("unknown_command", `Unknown sales command: ${sub}`);
}

/* ------------------------------------------------------------------ *
 * auth / doctor
 * ------------------------------------------------------------------ */

async function runAuth(args) {
  const [sub = "status", ...rest] = args;
  const flags = parseFlags(rest, { from: { type: "string" }, prefix: { type: "string" } });

  if (sub === "status") {
    const session = loadSession();
    return describeSession(session);
  }

  if (sub === "import") {
    if (!flags.from) throw new CliError("invalid_arguments", "--from PATH is required.");
    const fileSession = jsonProvider(flags.from)();
    if (!fileSession) {
      throw new CliError("invalid_cookie_file", `Could not read cookies from ${flags.from}`);
    }
    const missing = JST_COOKIE_NAMES.filter(
      (name) => !fileSession.cookies.find((c) => c.name === name)?.value,
    );
    if (missing.length) {
      throw new CliError("auth_incomplete", `Cookie file is missing: ${missing.join(", ")}`);
    }
    const prefix = flags.prefix ?? "com.xx-cli.jst-inventory";
    for (const name of JST_COOKIE_NAMES) {
      const value = fileSession.cookies.find((c) => c.name === name).value;
      writeKeychainSecret(`${prefix}.cookie.${name}`, value, JST_KEYCHAIN_ACCOUNT);
    }
    return { imported: JST_COOKIE_NAMES, prefix, account: JST_KEYCHAIN_ACCOUNT };
  }

  throw new CliError("unknown_command", `Unknown auth command: ${sub}`);
}

function notMigrated(name) {
  return () => {
    throw new CliError(
      "not_migrated",
      `jst ${name} 还没迁移。旧命令仍然可用，见 docs/MIGRATION.md 阶段 2。`,
    );
  };
}

const program = createProgram({
  name: "jst",
  description: "聚水潭取数统一入口。数据落位见 packages/core/src/paths.js。",
  commands: {
    orders: { description: "订单明细（原 jst-orders）", usage: "<command> [options]", run: runOrders },
    sales: { description: "销售业绩（原 jst-sales）", usage: "<command> [options]", run: runSales },
    doctor: {
      description: "环境自检：运行时 / 数据目录 / Keychain / 登录态",
      run: () => {
        const report = runDoctor();
        if (!report.ok) process.exitCode = 1;
        return report;
      },
    },
    auth: {
      description: "登录态：status | import --from cookies.json",
      run: runAuth,
    },
    inventory: {
      description: "库存预警（原 jst-inventory）",
      selfHandled: true,
      selfHelp: true,
      run: (args) => inventoryMain(args),
    },
    "order-page": {
      description: "订单页抓取（原 jst-order-page，走 OpenBridge）",
      selfHandled: true,
      selfHelp: true,
      run: (args) => orderPageCli(args),
    },
    aftersales: {
      description: "售后明细（原 jst-aftersales）",
      selfHandled: true,
      selfHelp: true,
      run: (args) => aftersalesCli(args),
    },
    refund: {
      description: "退款单导出（原 export-refund-daily.mjs）",
      selfHandled: true,
      selfHelp: true,
      run: (args) => refundCli(args),
    },
    purple: { description: "紫色旗订单（原 jst-purple-orders）—— 阶段 2", run: notMigrated("purple") },
    profit: { description: "利润事实库（原 jst-profit-facts）—— 阶段 2", run: notMigrated("profit") },
  },
});

await run(program);
