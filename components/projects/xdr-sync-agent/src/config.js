import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function expandHome(value) {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function projectRoot() { return ROOT; }

export function loadDatasets() {
  return JSON.parse(readFileSync(join(ROOT, "shared", "datasets.json"), "utf8"));
}

export function loadConfig(path = process.env.XDR_AGENT_CONFIG || join(homedir(), ".config", "xdr-sync-agent", "config.json")) {
  const defaults = {
    server: {
      host: "47.114.33.246", port: 22, user: "xdrsync",
      identity_file: "~/.ssh/xdr_mac",
      ctl: "/usr/local/bin/xdr-syncctl",
      incoming: "/var/lib/xdr-sync/incoming"
    },
    poll_seconds: 20,
    agent_id: null,
    lease_tasks: null,
    lease_exclude_tasks: null,
    command_timeout_seconds: 1200,
    unshipped_command_timeout_seconds: 3600,
    profit_analysis_command_timeout_seconds: 3600,
    profit_facts_command_timeout_seconds: 3600,
    shop_products_command_timeout_seconds: 43200,
    shop_products_target_rows: 900000,
    shop_products_max_change_ratio: 0.35,
    inventory_command_timeout_seconds: 172800,
    state_dir: "~/Library/Application Support/xdr-sync-agent",
    log_dir: "~/Library/Logs/xdr-sync-agent",
    cli: {
      inventory: "~/.local/bin/jst-inventory",
      orders: "~/.local/bin/jst-orders",
      order_page: "~/.local/bin/jst-order-page",
      sales: "~/.local/bin/jst-sales",
      profit_analysis: "~/.local/bin/jst-inventory",
      profit_facts: "~/jushuitan-profit-facts/bin/jst-profit-facts",
      doudian: "~/doudian-daily/doudian_sync.py",
      doudian_client: "~/doudian-daily/doudian_client_sync.py",
      doudian_invoice: "~/doudian-daily/invoice_sync.py",
      jst_purple_orders: "~/doudian-daily/jst_purple_sync.py"
    },
    excel_python: join(ROOT, ".venv", "bin", "python"),
    sales_seed: "~/jst-sales-performance.sqlite",
    paid_orders_seed: "~/Library/Application Support/xdr-sync-agent/imports/paid-orders.sqlite"
  };
  const configured = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const result = {
    ...defaults, ...configured,
    server: { ...defaults.server, ...(configured.server || {}) },
    cli: { ...defaults.cli, ...(configured.cli || {}) },
  };
  result.state_dir = resolve(expandHome(result.state_dir));
  result.log_dir = resolve(expandHome(result.log_dir));
  result.sales_seed = resolve(expandHome(result.sales_seed));
  result.paid_orders_seed = resolve(expandHome(result.paid_orders_seed));
  result.excel_python = resolve(expandHome(result.excel_python));
  result.server.identity_file = resolve(expandHome(result.server.identity_file));
  for (const key of Object.keys(result.cli)) result.cli[key] = resolve(expandHome(result.cli[key]));
  return result;
}
