#!/usr/bin/env node

import { homedir } from "node:os";
import { join } from "node:path";

import { assertDate, fetchSalesPerformance, yesterdayShanghai } from "../src/api.js";
import { CliError } from "../src/errors.js";
import { normalizeSalesRow } from "../src/report.js";
import { loadSession } from "../src/session.js";
import { readSalesRows, readSalesSummary, writeSalesSnapshot } from "../src/sqlite.js";

const DEFAULT_DB = join(homedir(), "jst-sales-performance.sqlite");
const HELP = `Usage: jst-sales <command> [options]

Read 聚水潭销售业绩 and store daily shop reports in SQLite.

Commands:
  login-status               Validate the saved 聚水潭 session
  fetch [--date DATE]        Fetch one day's shop sales report
  sync-sqlite [options]      Replace one day's rows in SQLite
  summary [options]          Summarize one saved report date
  list [options]             Read saved rows ordered by net sales

Options:
  --date YYYY-MM-DD          Report date, default yesterday (Asia/Shanghai)
  --output PATH              SQLite file, default ~/jst-sales-performance.sqlite
  --limit N                  List row limit, default 20, maximum 500
  -h, --help                 Show help

Authentication is shared with jst-inventory auth import.`;

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

function inputDate(args) {
  return assertDate(option(args, "--date", yesterdayShanghai()));
}

function inputLimit(args) {
  const value = Number(option(args, "--limit", "20"));
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new CliError("invalid_arguments", "--limit must be 1-500.");
  }
  return value;
}

async function run(args) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || rest.includes("--help") || rest.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  if (command === "login-status") {
    const session = loadSession();
    const date = inputDate(rest);
    const result = await fetchSalesPerformance(session, date);
    ok({ logged_in: true, report_date: date, shop_count: result.rows.length });
    return;
  }

  if (command === "fetch") {
    const session = loadSession();
    const date = inputDate(rest);
    const result = await fetchSalesPerformance(session, date);
    const syncedAt = new Date().toISOString();
    ok({
      report_date: date,
      total: result.total,
      rows: result.rows.map((row) => normalizeSalesRow(date, row, syncedAt)),
    });
    return;
  }

  if (command === "sync-sqlite") {
    const session = loadSession();
    const date = inputDate(rest);
    const outputPath = option(rest, "--output", DEFAULT_DB);
    const startedAt = new Date();
    const result = await fetchSalesPerformance(session, date);
    const syncedAt = new Date().toISOString();
    const rows = result.rows.map((row) => normalizeSalesRow(date, row, syncedAt));
    ok(writeSalesSnapshot({
      outputPath,
      reportDate: date,
      rows,
      sourceTotal: result.total,
      startedAt,
    }));
    return;
  }

  if (command === "list") {
    const date = inputDate(rest);
    const outputPath = option(rest, "--output", DEFAULT_DB);
    const limit = inputLimit(rest);
    ok({ report_date: date, rows: readSalesRows(outputPath, date, limit) });
    return;
  }

  if (command === "summary") {
    const date = inputDate(rest);
    const outputPath = option(rest, "--output", DEFAULT_DB);
    ok(readSalesSummary(outputPath, date));
    return;
  }

  throw new CliError("unknown_command", `Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch(fail);
