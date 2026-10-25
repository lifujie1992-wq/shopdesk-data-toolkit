const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AGENT = /^[A-Za-z0-9._-]{1,64}$/;
export const TASKS = new Set([
  "sync_all", "sync_hourly", "sync_inventory", "sync_orders", "sync_sales",
  "finalize_sales", "sync_order_page", "sync_paid_orders", "sync_unshipped_orders", "sync_spu_live",
  "sync_profit_analysis", "sync_profit_facts", "sync_shop_products", "sync_doudian", "sync_doudian_client", "sync_doudian_invoice", "sync_purple_orders",
]);
export const DATASETS = new Set(["inventory", "spu_live", "orders", "sales", "order_page", "paid_orders", "profit_analysis", "profit_facts", "shop_products", "doudian", "doudian_client", "doudian_invoice", "unshipped_orders", "jst_purple_orders"]);
export const PHASES = new Set(["fetching_inventory", "fetching_spu_live", "fetching_orders", "fetching_order_page", "fetching_sales", "fetching_paid_orders", "fetching_unshipped_orders", "fetching_profit_analysis", "fetching_profit_facts", "fetching_shop_products", "fetching_doudian", "fetching_doudian_client", "fetching_doudian_invoice", "fetching_jst_purple_orders", "diffing", "uploading", "waiting_apply", "idle"]);

export function validUuid(value) { if (!UUID.test(value)) throw new Error("invalid UUID"); return value; }
export function validAgent(value) { if (!AGENT.test(value)) throw new Error("invalid agent id"); return value; }
export function validTask(value) { if (!TASKS.has(value)) throw new Error("invalid task"); return value; }
export function validDataset(value) { if (!DATASETS.has(value)) throw new Error("invalid dataset"); return value; }
