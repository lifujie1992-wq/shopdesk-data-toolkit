import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const COLUMNS = [
  "report_date", "shop_id", "shop_name", "platform", "owner_name",
  "sales_amount", "net_sales_income", "sales_quantity", "order_count",
  "order_unit_price", "customer_unit_price", "sales_chain_percent",
  "shipped_gross_margin_percent", "shipped_net_profit_percent",
  "shipped_net_profit", "sales_cost", "commission", "platform_fees",
  "advertising_costs", "refund_amount", "refund_only_amount",
  "shipped_refund_amount", "returned_quantity", "send_ratio_48h",
  "send_ratio_24h", "average_send_hours", "delayed_shipment_quantity",
  "stockout_overtime_orders", "stockout_compensation",
  "delayed_shipment_percent", "daily_shipped_orders", "shipped_quantity",
  "paid_shipped_amount", "paid_shipped_quantity", "paid_shipped_orders",
  "paid_send_ratio", "markup_multiple", "overview", "synced_at", "raw_json",
];

function rowValues(row) {
  return [
    row.reportDate, row.shopId, row.shopName, row.platform, row.ownerName,
    row.salesAmount, row.netSalesIncome, row.salesQuantity, row.orderCount,
    row.orderUnitPrice, row.customerUnitPrice, row.salesChainPercent,
    row.shippedGrossMarginPercent, row.shippedNetProfitPercent,
    row.shippedNetProfit, row.salesCost, row.commission, row.platformFees,
    row.advertisingCosts, row.refundAmount, row.refundOnlyAmount,
    row.shippedRefundAmount, row.returnedQuantity, row.sendRatio48h,
    row.sendRatio24h, row.averageSendHours, row.delayedShipmentQuantity,
    row.stockoutOvertimeOrders, row.stockoutCompensation,
    row.delayedShipmentPercent, row.dailyShippedOrders, row.shippedQuantity,
    row.paidShippedAmount, row.paidShippedQuantity, row.paidShippedOrders,
    row.paidSendRatio, row.markupMultiple, row.overview, row.syncedAt, row.rawJson,
  ];
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_performance (
      report_date TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      shop_name TEXT NOT NULL,
      platform TEXT,
      owner_name TEXT,
      sales_amount REAL,
      net_sales_income REAL,
      sales_quantity REAL,
      order_count REAL,
      order_unit_price REAL,
      customer_unit_price REAL,
      sales_chain_percent REAL,
      shipped_gross_margin_percent REAL,
      shipped_net_profit_percent REAL,
      shipped_net_profit REAL,
      sales_cost REAL,
      commission REAL,
      platform_fees REAL,
      advertising_costs REAL,
      refund_amount REAL,
      refund_only_amount REAL,
      shipped_refund_amount REAL,
      returned_quantity REAL,
      send_ratio_48h REAL,
      send_ratio_24h REAL,
      average_send_hours REAL,
      delayed_shipment_quantity REAL,
      stockout_overtime_orders REAL,
      stockout_compensation REAL,
      delayed_shipment_percent REAL,
      daily_shipped_orders REAL,
      shipped_quantity REAL,
      paid_shipped_amount REAL,
      paid_shipped_quantity REAL,
      paid_shipped_orders REAL,
      paid_send_ratio REAL,
      markup_multiple REAL,
      overview TEXT,
      synced_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (report_date, shop_id)
    );

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_date TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      source_total INTEGER NOT NULL,
      saved_rows INTEGER NOT NULL,
      status TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sales_performance_date_net_sales_idx
      ON sales_performance(report_date, net_sales_income DESC);

    DROP VIEW IF EXISTS "销售业绩报告";
    CREATE VIEW "销售业绩报告" AS SELECT
      report_date AS "日期", shop_name AS "店铺", platform AS "平台",
      shop_id AS "店铺ID", owner_name AS "负责人", sales_amount AS "销售额(元)",
      net_sales_income AS "净销售收入(元)", sales_quantity AS "销量(件)",
      order_count AS "订单数", order_unit_price AS "笔单价(元)",
      customer_unit_price AS "客单价(元)", sales_chain_percent AS "销售额环比%",
      shipped_gross_margin_percent AS "发货毛利率%",
      shipped_net_profit_percent AS "发货纯利润率%",
      shipped_net_profit AS "发货纯利润金额", sales_cost AS "销售成本(元)",
      commission AS "佣金费用(元)", platform_fees AS "平台账单费用(元)",
      advertising_costs AS "推广费用(元)", refund_amount AS "退款金额(元)",
      refund_only_amount AS "仅退款金额(元)", shipped_refund_amount AS "发货退款金额(元)",
      returned_quantity AS "退货数量(件)", send_ratio_48h AS "48小时发货率%",
      send_ratio_24h AS "24小时发货率%", average_send_hours AS "平均发货时长(小时)",
      delayed_shipment_quantity AS "延迟发货件数",
      stockout_overtime_orders AS "缺货超时订单数",
      stockout_compensation AS "缺货赔付金额(元)",
      delayed_shipment_percent AS "延迟发货占比%",
      daily_shipped_orders AS "日发货订单数", shipped_quantity AS "全部发货(件)",
      paid_shipped_amount AS "支付发货金额(元)",
      paid_shipped_quantity AS "支付发货件数", paid_shipped_orders AS "支付发货单量",
      paid_send_ratio AS "支付发货率%", markup_multiple AS "加价倍数",
      synced_at AS "同步时间", overview AS "综合快览"
    FROM sales_performance;
  `);
}

export function writeSalesSnapshot({ outputPath, reportDate, rows, sourceTotal, startedAt }) {
  const resolvedPath = resolve(outputPath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  const db = new DatabaseSync(resolvedPath);
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - startedAt.getTime();
  try {
    createSchema(db);
    db.exec("BEGIN IMMEDIATE;");
    db.prepare("DELETE FROM sales_performance WHERE report_date = ?").run(reportDate);
    const placeholders = COLUMNS.map(() => "?").join(", ");
    const insert = db.prepare(
      `INSERT INTO sales_performance (${COLUMNS.join(", ")}) VALUES (${placeholders})`,
    );
    for (const row of rows) insert.run(...rowValues(row));
    db.prepare(`
      INSERT INTO sync_runs (
        report_date, started_at, completed_at, duration_ms,
        source_total, saved_rows, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'success')
    `).run(
      reportDate,
      startedAt.toISOString(),
      completedAt.toISOString(),
      durationMs,
      sourceTotal,
      rows.length,
    );
    db.exec("COMMIT;");
    return { output: resolvedPath, report_date: reportDate, rows: rows.length, duration_ms: durationMs };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

export function readSalesRows(outputPath, reportDate, limit) {
  const db = new DatabaseSync(resolve(outputPath), { readOnly: true });
  try {
    return db.prepare(`
      SELECT report_date, shop_id, shop_name, platform, owner_name,
        sales_amount, net_sales_income, sales_quantity, order_count,
        shipped_gross_margin_percent, shipped_net_profit_percent,
        refund_amount, send_ratio_48h, stockout_overtime_orders,
        stockout_compensation, overview, synced_at
      FROM sales_performance
      WHERE report_date = ?
      ORDER BY net_sales_income DESC
      LIMIT ?
    `).all(reportDate, limit);
  } finally {
    db.close();
  }
}

export function readSalesSummary(outputPath, reportDate) {
  const db = new DatabaseSync(resolve(outputPath), { readOnly: true });
  try {
    const totals = db.prepare(`
      SELECT
        COUNT(*) AS shop_count,
        ROUND(SUM(sales_amount), 2) AS sales_amount,
        ROUND(SUM(net_sales_income), 2) AS net_sales_income,
        ROUND(SUM(sales_quantity), 2) AS sales_quantity,
        ROUND(SUM(order_count), 2) AS order_count,
        ROUND(SUM(refund_amount), 2) AS refund_amount,
        ROUND(SUM(shipped_net_profit), 2) AS shipped_net_profit,
        CASE WHEN SUM(net_sales_income) <> 0 THEN
          ROUND(SUM(shipped_net_profit) / SUM(net_sales_income) * 100, 2)
        END AS shipped_net_profit_percent
      FROM sales_performance
      WHERE report_date = ?
    `).get(reportDate);
    const topShop = db.prepare(`
      SELECT shop_id, shop_name, platform, owner_name, net_sales_income,
        sales_quantity, order_count, sales_chain_percent
      FROM sales_performance
      WHERE report_date = ?
      ORDER BY net_sales_income DESC
      LIMIT 1
    `).get(reportDate) ?? null;
    return { report_date: reportDate, ...totals, top_shop: topShop };
  } finally {
    db.close();
  }
}
