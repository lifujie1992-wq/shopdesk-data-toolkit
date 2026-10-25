#!/usr/bin/env node
import { loadConfig, loadDatasets } from "../src/config.js";
import { Agent, doctor } from "../src/agent.js";

function output(data, ok = true) { process.stdout.write(`${JSON.stringify({ ok, data }, null, 2)}\n`); }
async function main() {
  const [command, arg] = process.argv.slice(2); const config = loadConfig(); const schemas = loadDatasets(); const agent = new Agent(config, schemas);
  if (command === "doctor") { const result = await doctor(config, schemas); output(result, result.ok); if (!result.ok) process.exitCode = 1; return; }
  if (command === "run-once") { output({ ran: await agent.runOnce() }); return; }
  if (command === "daemon") { await agent.daemon(); return; }
  if (command === "status") { let remote = null; try { remote = await agent.transport.status(); } catch {} output({ local: agent.localStatus(), remote }); return; }
  if (command === "sync-now" || command === "schedule") {
    const tasks = { all: "sync_all", inventory: "sync_inventory", orders: "sync_orders", order_page: "sync_order_page", sales: "sync_sales", paid_orders: "sync_paid_orders", unshipped_orders: "sync_unshipped_orders", unshipped: "sync_unshipped_orders", profit_analysis: "sync_profit_analysis", profit: "sync_profit_analysis", profit_facts: "sync_profit_facts", shop_products: "sync_shop_products", doudian: "sync_doudian", doudian_client: "sync_doudian_client", doudian_invoice: "sync_doudian_invoice", purple_orders: "sync_purple_orders" };
    if (!tasks[arg || "all"]) throw new Error(`usage: ${command} [all|inventory|orders|order_page|sales|paid_orders|unshipped_orders|profit_analysis|profit_facts|shop_products|doudian|doudian_client|doudian_invoice]`);
    output(await agent.transport.enqueue(tasks[arg || "all"], command === "schedule" ? "auto" : "manual")); return;
  }
  throw new Error("usage: xdr-sync-agent <doctor|run-once|daemon|status|sync-now|schedule [all|inventory|orders|order_page|sales|paid_orders|profit_analysis|shop_products|doudian|doudian_client|doudian_invoice]>");
}
main().catch((error) => { output({ error: String(error.message || error).replace(/[^A-Za-z0-9_.: -]/g, "_").slice(0, 200) }, false); process.exitCode = 1; });
