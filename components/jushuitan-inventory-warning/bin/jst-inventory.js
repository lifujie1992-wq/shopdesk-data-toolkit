#!/usr/bin/env node

import {
  clearSession,
  loadSession,
  readChromeErpSession,
  saveSession,
  sessionFromCookieHeader,
  sessionMetadata,
} from "../src/chrome-session.js";
import {
  callApi,
  callListApi,
  detailParams,
  parseChildren,
  SHOP_SHORTAGE_CONTEXT,
  shopShortageParams,
  summaryParams,
  listSaleChannel,
} from "../src/api.js";
import { CliError, errorResult } from "../src/errors.js";
import { exportSaleChannels } from "../src/sale-channel-sqlite.js";
import { exportShopProducts } from "../src/shop-products-export.js";
import { exportShopSkuBatches } from "../src/shop-sku-batch.js";
import { readSecret } from "../src/secret-input.js";
import {
  listDailySalesAnalysis,
  listSalesAnalysisDimension,
  listShopDailySalesAnalysis,
  listShopSalesAnalysis,
} from "../src/sales-analysis.js";
import {
  appendSalesAnalysisToSqlite,
  copySalesAnalysisFromSqlite,
  initializeEmptySalesAnalysis,
} from "../src/sales-analysis-sqlite.js";
import {
  appendShopShortageToSqlite,
  exportShopShortageToSqlite,
} from "../src/shop-shortage-sqlite.js";
import {
  enrichShopShortageRows,
  getShopShortageSummary,
  SHOP_SHORTAGE_LIST_API,
} from "../src/shop-shortage.js";
import { exportInventoryToSqlite, exportSpuInventoryToSqlite } from "../src/sqlite-export.js";
import {
  appendDailyMetricsToSqlite,
  readDailyMetricsFromSqlite,
} from "../src/daily-metrics.js";
import {
  crawlProfitAnalysisJson,
  defaultProfitDateRange,
  exportProfitAnalysisXlsx,
} from "../src/profit-analysis-export.js";

const HELP = `Usage: jst-inventory <command> [options]

Read 聚水潭 purchase and inventory warning data without opening Chrome.

Commands:
  auth import                 Paste a Cookie header and save the verified session
  auth sync [--profile NAME]  Import the active Chrome session into macOS Keychain
  auth clear                  Remove the saved session from macOS Keychain
  login-status               Check whether the saved session is valid
  summary                    Get purchase/inventory warning scenario totals
  list [--page N] [--limit N] Get style rows with parsed SKU children
  daily-metrics              Calculate the requested daily inventory/shortage metrics
  export-spu-sqlite          Export one complete live SPU + SKU snapshot
  export-sqlite [options]    Export the complete report to a local SQLite file
  shop-shortage <command>    Read shop-level shortage and unshipped quantities
  sale-channel <platform|channel> Read today sales popup by platform/channel
  shop-sku-batch export-sqlite Supplement shop sales in batches of 500 inventory SKUs
  shop-products export       Export current shop-product files in verified batches
  sales-analysis platform    Read the drawer's platform tab by SPU
  sales-analysis channel     Read the drawer's channel tab by SPU
  sales-analysis link        Read the drawer's link tab by SPU
  sales-analysis shops       Alias of sales-analysis channel
  sales-analysis daily       Read daily sales, amount, orders, and net sales by SPU
  sales-analysis shop-daily  Read one day's sales and returns by SPU and shop
  profit-analysis crawl-json  Crawl 商品利润分析（按 SKU）including page labels
  profit-analysis export-xlsx Export 商品利润分析（按 SKU）to Excel

Options:
  -h, --help                  Show help

All results are JSON. Read commands do not require Chrome after authentication.`;

function ok(data) {
  process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
}

function fail(error) {
  process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
  process.exitCode = 1;
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith("-")) {
    throw new CliError("invalid_arguments", `${name} requires a value.`);
  }
  return args[index + 1];
}

function positiveInteger(value, name, { max } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || (max && number > max)) {
    const range = max ? `1-${max}` : "a positive integer";
    throw new CliError("invalid_arguments", `${name} must be ${range}.`);
  }
  return number;
}

function commandHelp(command) {
  const messages = {
    auth: "Usage: jst-inventory auth <import|sync [--profile NAME]|clear>\n  import reads a full Cookie header from hidden input or stdin",
    "login-status": "Usage: jst-inventory login-status",
    summary: "Usage: jst-inventory summary",
    list: "Usage: jst-inventory list [--page N] [--limit N]\n  --page: page number, default 1\n  --limit: rows per page, 1-100, default 10",
    "daily-metrics": "Usage: jst-inventory daily-metrics --input PATH [--date YYYY-MM-DD]\n  Reads an existing complete inventory SQLite export without calling 聚水潭",
    "export-spu-sqlite": "Usage: jst-inventory export-spu-sqlite [--output PATH] [--concurrency N]\n  Exports the 100-row SPU list and its included SKU children after strict completeness checks",
    "export-sqlite": "Usage: jst-inventory export-sqlite [--output PATH] [--concurrency N] [--include-shop-shortage] [--include-sales-analysis|--reuse-sales-analysis PATH]\n  --output: SQLite file, default ./jst-inventory-full.sqlite\n  --concurrency: inventory parallel requests, 1-8, default 4\n  --include-shop-shortage: append shop shortage detail, summary, and daily metrics tables\n  --shop-shortage-concurrency: shop shortage parallel requests, 1-8, default 2\n  --include-sales-analysis: append all-SPU platform, channel, and link sales analysis\n  --reuse-sales-analysis: copy sales analysis from an existing inventory SQLite file\n  --sales-analysis-concurrency: sales analysis parallel SPUs, 1-16, default 2\n  --sales-analysis-days: comparison period length, default 30",
    "shop-shortage": `Usage: jst-inventory shop-shortage <list|summary|export-sqlite> [options]
  list --page N --limit N       Get shop-link warning rows, default 1/10
  summary --concurrency N       Aggregate all warning rows by shop
  export-sqlite [options]       Export link details and shop summaries

Urgent shortage quantity = overdue quantity + quantity due within 1 day.`,
    "sales-analysis": "Usage: jst-inventory sales-analysis <platform|channel|link|shops|daily|shop-daily|export-sqlite> [options]\n  platform/channel/link: the three sales-analysis drawer tabs\n  shops: compatibility alias of channel\n  daily: daily sales quantity, sales amount, orders, and net sales by SPU\n  shop-daily: one day's sales and paid-return quantity by SPU and shop\n  export-sqlite: refresh all-SPU sales analysis in an existing inventory SQLite file\n  --days: period length, default 30\n  --end-date: period end date, default yesterday in Asia/Shanghai",
    "sale-channel": "Usage: jst-inventory sale-channel <platform|channel> --spu-id ID [--sku-id ID] [options]\n  Reproduces 今日销售件数 → 分渠道看 popup (not the sales-analysis drawer)\n  --page N --limit N --shop-ids CSV --platforms CSV --dis-co-ids CSV",
    "shop-sku-batch": "Usage: jst-inventory shop-sku-batch export-sqlite --output PATH [--max-batches N]\n  Uses existing inventory SKUs, skips today's complete channel snapshots, then reads one shop / 500 SKUs per request.\n  Serial requests with >=1500ms spacing; missing values stay null; old popup snapshots are unchanged.\n  --max-batches bounds a diagnostic run; unfinished runs do not publish batch snapshots.",
    "shop-products": "Usage: jst-inventory shop-products export --inventory PATH --output-dir PATH [--batch-size N]\n  Exports every shop from shop_directory and atomically publishes the files after all batches download successfully.",
    "profit-analysis": "Usage: jst-inventory profit-analysis <crawl-json|export-xlsx> --output PATH [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]\n  crawl-json collects the complete SKU list, page labels, and focus-order counts. Default range is the latest 7 days ending yesterday in Asia/Shanghai.",
  };
  return messages[command] ?? HELP;
}

async function run(argv) {
  const [command, subcommand, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${commandHelp(command)}\n`);
    return;
  }

  if (command === "auth") {
    if (subcommand === "import") {
      const cookie = await readSecret("Paste the full 聚水潭 Cookie header, then press Enter: ");
      const session = sessionFromCookieHeader(cookie);
      await callApi(session, "purchase_alarm_sku_summary", summaryParams());
      saveSession(session);
      ok({ saved: true, source: "manual", ...sessionMetadata(session) });
      return;
    }
    if (subcommand === "sync") {
      const profile = option(rest, "--profile", "Default");
      const session = readChromeErpSession(profile);
      await callApi(session, "purchase_alarm_sku_summary", summaryParams());
      saveSession(session);
      ok({ saved: true, ...sessionMetadata(session) });
      return;
    }
    if (subcommand === "clear") {
      clearSession();
      ok({ cleared: true });
      return;
    }
    throw new CliError("invalid_arguments", "Use: jst-inventory auth import, auth sync, or auth clear");
  }

  if (command === "daily-metrics") {
    const args = [subcommand, ...rest].filter((value) => value !== undefined);
    const input = option(args, "--input", null);
    if (!input) throw new CliError("invalid_arguments", "--input is required.");
    const snapshotDate = option(args, "--date", null);
    if (snapshotDate && !/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate)) {
      throw new CliError("invalid_arguments", "--date must use YYYY-MM-DD.");
    }
    ok(readDailyMetricsFromSqlite({
      inputPath: input,
      ...(snapshotDate ? { snapshotDate } : {}),
    }));
    return;
  }

  const session = loadSession();
  if (command === "shop-products") {
    if (subcommand !== "export") {
      throw new CliError("invalid_arguments", "Use: shop-products export --inventory PATH --output-dir PATH");
    }
    const inventoryPath = option(rest, "--inventory", null);
    const outputDir = option(rest, "--output-dir", null);
    if (!inventoryPath || !outputDir) {
      throw new CliError("invalid_arguments", "--inventory and --output-dir are required");
    }
    const batchSize = positiveInteger(option(rest, "--batch-size", "7"), "--batch-size", { max: 25 });
    const planPath = option(rest, "--plan", null);
    const resumeRoot = option(rest, "--resume-root", null);
    ok(await exportShopProducts({
      session,
      inventoryPath,
      outputDir,
      batchSize,
      ...(planPath ? { planPath } : {}),
      ...(resumeRoot ? { resumeRoot } : {}),
      onProgress: (progress) => process.stderr.write(`Shop-products ${JSON.stringify(progress)}\n`),
    }));
    return;
  }
  if (command === "profit-analysis") {
    const outputPath = option(rest, "--output", null);
    if (!outputPath) throw new CliError("invalid_arguments", "--output is required");
    if (subcommand === "crawl-json") {
      const defaults = defaultProfitDateRange();
      ok(await crawlProfitAnalysisJson({
        session, outputPath,
        startDate: option(rest, "--start-date", defaults.startDate),
        endDate: option(rest, "--end-date", defaults.endDate),
        onProgress: (progress) => process.stderr.write(`Profit-analysis ${JSON.stringify(progress)}\n`),
      }));
      return;
    }
    if (subcommand !== "export-xlsx") {
      throw new CliError("invalid_arguments", "Use: profit-analysis crawl-json --output PATH");
    }
    ok(await exportProfitAnalysisXlsx({
      session,
      outputPath,
      focusOutputPath: option(rest, "--focus-output", `${outputPath}.focus-orders.json`),
      startDate: option(rest, "--start-date", null),
      endDate: option(rest, "--end-date", null),
      onProgress: (progress) => process.stderr.write(`Profit-analysis ${JSON.stringify(progress)}\n`),
    }));
    return;
  }
  if (command === "shop-sku-batch") {
    if (subcommand !== "export-sqlite") throw new CliError("invalid_arguments", "Use: shop-sku-batch export-sqlite --output PATH");
    const outputPath = option(rest, "--output", null);
    if (!outputPath) throw new CliError("invalid_arguments", "--output is required");
    const limit = option(rest, "--max-batches", null);
    const result = await exportShopSkuBatches({ session, outputPath,
      ...(limit === null ? {} : { maxBatches: positiveInteger(limit, "--max-batches") }),
      onProgress: progress => process.stderr.write(`Shop-SKU batch ${JSON.stringify(progress)}\n`),
    });
    ok(result);
    return;
  }
  if (command === "login-status") {
    await callApi(session, "purchase_alarm_sku_summary", summaryParams());
    ok({ logged_in: true, ...sessionMetadata(session) });
    return;
  }
  if (command === "summary") {
    const payload = await callApi(session, "purchase_alarm_sku_summary", summaryParams());
    ok(payload.data?.[0] ?? {});
    return;
  }
  if (command === "sale-channel") {
    if (subcommand === "export-sqlite") {
      const outputPath = option(rest, "--output", null);
      if (!outputPath) throw new CliError("invalid_arguments", "--output is required");
      const concurrency = positiveInteger(option(rest, "--concurrency", "16"), "--concurrency", { max: 32 });
      const queryType = option(rest, "--query-type", "sku");
      ok(await exportSaleChannels({ session, outputPath, queryType, concurrency, onProgress: ({ completed, total }) => {
        if (completed % 100 === 0 || completed === total) process.stderr.write(`Sale-channel ${completed}/${total} ${queryType.toUpperCase()}\n`);
      } }));
      return;
    }
    if (!["platform", "channel"].includes(subcommand)) {
      throw new CliError("invalid_arguments", "Use: jst-inventory sale-channel platform|channel --spu-id ID");
    }
    const spuId = option(rest, "--spu-id", null);
    const skuId = option(rest, "--sku-id", null);
    if (!spuId && !skuId) throw new CliError("invalid_arguments", "--spu-id or --sku-id is required.");
    const csv = (name) => { const value = option(rest, name, ""); return value ? value.split(",").map(x => x.trim()).filter(Boolean) : undefined; };
    const page = positiveInteger(option(rest, "--page", "1"), "--page", { max: 1000000 });
    const limit = positiveInteger(option(rest, "--limit", "100"), "--limit", { max: 1000 });
    const result = await listSaleChannel({ session, spuId, skuId, countType: subcommand, page, pageSize: limit, shopIds: csv("--shop-ids"), platforms: csv("--platforms"), disCoIds: csv("--dis-co-ids") });
    ok(result);
    return;
  }
  if (command === "list") {
    const args = [subcommand, ...rest].filter((value) => value !== undefined);
    const page = positiveInteger(option(args, "--page", "1"), "--page");
    const limit = positiveInteger(option(args, "--limit", "10"), "--limit", { max: 100 });
    const payload = await callListApi(
      session,
      "purchase_alarm_sku_detail",
      detailParams(page, limit),
      { customColumnTableCode: "procurement_rt_warning_table" },
    );
    ok({ page, limit, total: payload.total, rows: parseChildren(payload.data ?? []) });
    return;
  }
  if (command === "export-spu-sqlite") {
    const args = [subcommand, ...rest].filter((value) => value !== undefined);
    const output = option(args, "--output", "./jst-inventory-spu-live.sqlite");
    const concurrency = positiveInteger(
      option(args, "--concurrency", "4"),
      "--concurrency",
      { max: 8 },
    );
    ok(await exportSpuInventoryToSqlite({
      session,
      outputPath: output,
      concurrency,
      onProgress: (progress) => {
        if (progress.event === 'retry') {
          process.stderr.write(`SPU page retry ${JSON.stringify(progress)}\n`);
          return;
        }
        const {completedPages, pages, fetchedSpu, fetchedSku} = progress;
        if (completedPages === pages || completedPages % 20 === 0) {
          process.stderr.write(
            `Exported ${completedPages}/${pages} pages (${fetchedSpu} SPU, ${fetchedSku} SKU)\n`,
          );
        }
      },
    }));
    return;
  }
  if (command === "export-sqlite") {
    const args = [subcommand, ...rest].filter((value) => value !== undefined);
    const output = option(args, "--output", "./jst-inventory-full.sqlite");
    const includeShopShortage = args.includes("--include-shop-shortage");
    const includeSalesAnalysis = args.includes("--include-sales-analysis");
    // XDR passes this marker so deployed agents can request the current-page
    // today sales channel family; collection is handled by the analysis export.
    const includeSaleChannel = args.includes("--include-sale-channel");
    const reuseSalesAnalysis = option(args, "--reuse-sales-analysis", null);
    const emptySalesAnalysis = args.includes("--empty-sales-analysis");
    if (emptySalesAnalysis && (includeSalesAnalysis || reuseSalesAnalysis)) {
      throw new CliError("invalid_arguments", "--empty-sales-analysis cannot be combined with collection/reuse.");
    }
    if (includeSalesAnalysis && reuseSalesAnalysis) {
      throw new CliError(
        "invalid_arguments",
        "--include-sales-analysis and --reuse-sales-analysis cannot be used together.",
      );
    }
    const shopShortageConcurrency = positiveInteger(
      option(args, "--shop-shortage-concurrency", "2"),
      "--shop-shortage-concurrency",
      { max: 8 },
    );
    const concurrency = positiveInteger(
      option(args, "--concurrency", "4"),
      "--concurrency",
      { max: 8 },
    );
    const salesAnalysisConcurrency = positiveInteger(
      option(args, "--sales-analysis-concurrency", "2"),
      "--sales-analysis-concurrency",
      { max: 16 },
    );
    const salesAnalysisDays = positiveInteger(
      option(args, "--sales-analysis-days", "30"),
      "--sales-analysis-days",
      { max: 180 },
    );
    const inventory = await exportInventoryToSqlite({
      session,
      outputPath: output,
      concurrency,
      onProgress: (progress) => {
        if (progress.event === 'retry') {
          process.stderr.write(`Inventory page retry ${JSON.stringify(progress)}\n`);
          return;
        }
        const { completedPages, pages, fetchedSpu, fetchedSku } = progress;
        if (completedPages === pages || completedPages % 20 === 0) {
          process.stderr.write(
            `Exported ${completedPages}/${pages} pages (${fetchedSpu} SPU, ${fetchedSku} SKU)\n`,
          );
        }
      },
    });
    const shopShortage = includeShopShortage
      ? await appendShopShortageToSqlite({
        session,
        outputPath: output,
        concurrency: shopShortageConcurrency,
        onProgress: ({ completedPages, pages, fetchedLinks }) => {
          if (completedPages === pages || completedPages % 20 === 0) {
            process.stderr.write(
              `Exported ${completedPages}/${pages} shop-shortage pages (${fetchedLinks} links)\n`,
            );
          }
        },
      })
      : null;
    const salesAnalysis = includeSalesAnalysis
      ? await appendSalesAnalysisToSqlite({
        session,
        outputPath: output,
        days: salesAnalysisDays,
        concurrency: salesAnalysisConcurrency,
        onProgress: ({
          fetchedSpus, totalSpus, fetchedPlatformRows, fetchedShopRows, fetchedLinkRows,
          fetchedDailyRows, fetchedShopDailyRows,
        }) => {
          if (fetchedSpus === totalSpus || fetchedSpus % 100 === 0) {
            process.stderr.write(
              `Exported sales analysis for ${fetchedSpus}/${totalSpus} SPU `
              + `(${fetchedPlatformRows} platform rows, ${fetchedShopRows} shop rows, `
              + `${fetchedLinkRows} link rows, ${fetchedDailyRows} product daily rows, `
              + `${fetchedShopDailyRows} shop daily rows)\n`,
            );
          }
        },
      })
      : null;
    const reusedSalesAnalysis = reuseSalesAnalysis
      ? copySalesAnalysisFromSqlite({ sourcePath: reuseSalesAnalysis, outputPath: output })
      : null;
    if (emptySalesAnalysis) initializeEmptySalesAnalysis({ outputPath: output });
    const dailyMetrics = includeShopShortage
      ? appendDailyMetricsToSqlite({
        outputPath: output,
        ...(reuseSalesAnalysis ? { historyPath: reuseSalesAnalysis } : {}),
      })
      : null;
    ok({
      ...inventory,
      ...(shopShortage ? { shop_shortage: shopShortage } : {}),
      ...(salesAnalysis ? { sales_analysis: salesAnalysis } : {}),
      ...(reusedSalesAnalysis ? { reused_sales_analysis: reusedSalesAnalysis } : {}),
      ...(dailyMetrics ? { daily_metrics: dailyMetrics } : {}),
    });
    return;
  }
  if (command === "sales-analysis") {
    if (subcommand === "export-sqlite") {
      const output = option(rest, "--output", "./jst-inventory-full.sqlite");
      const days = positiveInteger(option(rest, "--days", "30"), "--days", { max: 180 });
      const concurrency = positiveInteger(
        option(rest, "--concurrency", "2"),
        "--concurrency",
        { max: 16 },
      );
      const endDate = option(rest, "--end-date", null);
      ok(await appendSalesAnalysisToSqlite({
        session,
        outputPath: output,
        days,
        concurrency,
        ...(endDate ? { endDate } : {}),
        onProgress: ({
          fetchedSpus, totalSpus, fetchedPlatformRows, fetchedShopRows, fetchedLinkRows,
          fetchedDailyRows, fetchedShopDailyRows,
        }) => {
          if (fetchedSpus === totalSpus || fetchedSpus % 100 === 0) {
            process.stderr.write(
              `Exported sales analysis for ${fetchedSpus}/${totalSpus} SPU `
              + `(${fetchedPlatformRows} platform rows, ${fetchedShopRows} shop rows, `
              + `${fetchedLinkRows} link rows, ${fetchedDailyRows} product daily rows, `
              + `${fetchedShopDailyRows} shop daily rows)\n`,
            );
          }
        },
      }));
      return;
    }
    if (!["platform", "channel", "link", "shops", "daily", "shop-daily"].includes(subcommand)) {
      throw new CliError(
        "invalid_arguments",
        "Use: jst-inventory sales-analysis platform|channel|link|shops|daily|shop-daily --spu-id ID",
      );
    }
    const spuId = option(rest, "--spu-id", null);
    if (!spuId) throw new CliError("invalid_arguments", "--spu-id is required.");
    const days = positiveInteger(option(rest, "--days", "30"), "--days", { max: 180 });
    const page = positiveInteger(option(rest, "--page", "1"), "--page");
    const pageSize = positiveInteger(option(rest, "--limit", "100"), "--limit", { max: 100 });
    const endDate = option(rest, "--end-date", null);
    try {
      if (subcommand === "shop-daily") {
        ok(await listShopDailySalesAnalysis({
          session,
          spuId,
          ...(endDate ? { bizDate: endDate } : {}),
          pageSize,
        }));
      } else if (subcommand === "daily") {
        const read = listDailySalesAnalysis;
        ok(await read({
          session,
          spuId,
          days,
          ...(endDate ? { endDate } : {}),
          page,
          pageSize,
        }));
      } else {
        const countType = subcommand === "shops" ? "channel" : subcommand;
        ok(await listSalesAnalysisDimension({
          session,
          spuId,
          days,
          ...(endDate ? { endDate } : {}),
          page,
          pageSize,
          countType,
        }));
      }
    } catch (error) {
      if (error instanceof Error && /^endDate /.test(error.message)) {
        throw new CliError("invalid_arguments", error.message);
      }
      throw error;
    }
    return;
  }
  if (command === "shop-shortage") {
    if (!subcommand) {
      throw new CliError(
        "invalid_arguments",
        "Use: jst-inventory shop-shortage list, summary, or export-sqlite",
      );
    }
    if (subcommand === "list") {
      const page = positiveInteger(option(rest, "--page", "1"), "--page");
      const limit = positiveInteger(option(rest, "--limit", "10"), "--limit", { max: 100 });
      const payload = await callListApi(
        session,
        SHOP_SHORTAGE_LIST_API,
        shopShortageParams(page, limit),
        {},
        SHOP_SHORTAGE_CONTEXT,
      );
      ok({
        page,
        limit,
        total: payload.total,
        rows: enrichShopShortageRows(payload.data ?? []),
      });
      return;
    }
    if (subcommand === "summary") {
      const concurrency = positiveInteger(
        option(rest, "--concurrency", "4"),
        "--concurrency",
        { max: 8 },
      );
      const result = await getShopShortageSummary({
        session,
        concurrency,
        onPage: (_rows, page, pages) => {
          if (page === pages || page % 20 === 0) {
            process.stderr.write(`Read ${page}/${pages} shop-shortage pages\n`);
          }
        },
      });
      ok(result);
      return;
    }
    if (subcommand === "export-sqlite") {
      const output = option(rest, "--output", "./jst-shop-shortage.sqlite");
      const concurrency = positiveInteger(
        option(rest, "--concurrency", "4"),
        "--concurrency",
        { max: 8 },
      );
      const result = await exportShopShortageToSqlite({
        session,
        outputPath: output,
        concurrency,
        onProgress: ({ completedPages, pages, fetchedLinks }) => {
          if (completedPages === pages || completedPages % 20 === 0) {
            process.stderr.write(
              `Exported ${completedPages}/${pages} pages (${fetchedLinks} shop links)\n`,
            );
          }
        },
      });
      ok(result);
      return;
    }
    throw new CliError(
      "invalid_arguments",
      "Use: jst-inventory shop-shortage list, summary, or export-sqlite",
    );
  }

  throw new CliError("unknown_command", `Unknown command: ${command}`);
}

run(process.argv.slice(2)).catch(fail);
