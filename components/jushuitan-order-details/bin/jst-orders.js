#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";

import { dateRange, fetchOrderPage, fetchOrderSummary, orderDimension, yesterdayShanghai } from "../src/api.js";
import { CliError } from "../src/errors.js";
import { exportOrderItemsToSqlite } from "../src/item-sqlite-export.js";
import { loadSession } from "../src/session.js";
import {
  exportOrdersToSqlite,
  readOrders,
  readOrderSummary,
} from "../src/sqlite-export.js";

const DEFAULT_DB = join(homedir(), "jst-order-details.sqlite");
const DEFAULT_ITEM_DB = join(homedir(), "jst-order-item-details.sqlite");
const HELP = `Usage: jst-orders <command> [options]

Read 聚水潭订单明细查询 and store a rolling snapshot in SQLite.

Commands:
  login-status               Validate access with a one-row request
  count [options]            Count orders and read the API totals
  sync-sqlite [options]      Export the full date range to SQLite
  summary [--output PATH]    Read the saved snapshot metadata and totals
  list [options]             Read saved orders without private recipient fields

Options:
  --days N                   Inclusive day count, default 30, maximum 366
  --end-date YYYY-MM-DD      Last report day, default yesterday in Shanghai
  --output PATH              Default ~/jst-order-details.sqlite
  --merge-existing PATH      Preserve dates outside the requested range from this database
  --page-size N              Export page size, default 5000, maximum 5000
  --concurrency N            Parallel requests, default 3, maximum 4
  --dimension NAME           order (default) or item (订单（商品）)
  --append                   Append item tables to an existing orders SQLite database
  --limit N                  List limit, default 20, maximum 500
  -h, --help                 Show help

Filters match the verified page: send date, sent orders, split bundles,
exclude unfinished orders, exchange orders, 特殊单, and 统计排除标.`;

function ok(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

function fail(error) {
  const code = error instanceof CliError ? error.code : "internal_error";
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exitCode = 1;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new CliError("invalid_arguments", `${name} requires a value.`);
  }
  return value;
}

function integerOption(args, name, fallback, max) {
  const value = Number(option(args, name, String(fallback)));
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new CliError("invalid_arguments", `${name} must be 1-${max}.`);
  }
  return value;
}

function inputRange(args) {
  return dateRange(
    integerOption(args, "--days", 30, 366),
    option(args, "--end-date", yesterdayShanghai()),
  );
}

function inputDimension(args) {
  return orderDimension(option(args, "--dimension", "order")).name;
}

async function run(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (command === "login-status") {
    const session = loadSession();
    const dimension = inputDimension(rest);
    const range = dateRange(1, option(rest, "--end-date", yesterdayShanghai()));
    const payload = await fetchOrderPage(session, range, 1, 1, dimension);
    ok({ logged_in: true, end_date: range.end_date, dimension, total: Number(payload.total ?? 0) });
    return;
  }

  if (command === "count") {
    const session = loadSession();
    const range = inputRange(rest);
    const dimension = inputDimension(rest);
    const [detail, summary] = await Promise.all([
      fetchOrderPage(session, range, 1, 1, dimension),
      fetchOrderSummary(session, range, dimension),
    ]);
    ok({
      start_date: range.start_date,
      end_date: range.end_date,
      dimension,
      total: Number(detail.total ?? 0),
      summary: summary.data ?? [],
    });
    return;
  }

  if (command === "sync-sqlite") {
    const session = loadSession();
    const range = inputRange(rest);
    const dimension = inputDimension(rest);
    const outputPath = option(rest, "--output", dimension === "item" ? DEFAULT_ITEM_DB : DEFAULT_DB);
    const pageSize = integerOption(rest, "--page-size", 5000, 5000);
    const concurrency = integerOption(rest, "--concurrency", 3, 4);
    const mergeFromPath = option(rest, "--merge-existing", null);
    const append = rest.includes("--append");
    if (append && dimension !== "item") {
      throw new CliError("invalid_arguments", "--append is only valid with --dimension item.");
    }
    const exportSqlite = dimension === "item" ? exportOrderItemsToSqlite : exportOrdersToSqlite;
    const result = await exportSqlite({
      session,
      range,
      outputPath,
      pageSize,
      concurrency,
      mergeFromPath,
      ...(dimension === "order" ? { dimension } : {}),
      ...(dimension === "item" ? { append } : {}),
      onProgress: ({ completedPages, pages, fetchedRows }) => {
        if (completedPages === pages || completedPages % 10 === 0) {
          process.stderr.write(`Exported ${completedPages}/${pages} pages (${fetchedRows} rows)\n`);
        }
      },
    });
    ok({ ...result, dimension });
    return;
  }

  if (command === "summary") {
    ok(readOrderSummary(option(rest, "--output", DEFAULT_DB)));
    return;
  }

  if (command === "list") {
    const outputPath = option(rest, "--output", DEFAULT_DB);
    const limit = integerOption(rest, "--limit", 20, 500);
    ok({ rows: readOrders(outputPath, limit) });
    return;
  }

  throw new CliError("unknown_command", `Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch(fail);
