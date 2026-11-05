/**
 * jst sales —— 聚水潭销售业绩（店铺日报）。
 *
 * 迁移自 jushuitan-sales-performance（701 行）。字段口径、取整规则、
 * 综合快览文案、建表与视图全部原样保留。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertDate,
  createJstTransport,
  openDatabase,
  resolveDataPath,
  yesterdayShanghai,
} from "@shopdesk/core";

export { assertDate, yesterdayShanghai };

const API_CODE = "sales_performance_channel_list";
const TABLE_CODE = "sales_performance_report_overview_shop_v_2_table";

const PROFILE = Object.freeze({
  origin: "https://www.erp321.com",
  referer: "https://www.erp321.com/",
  pageParam: { bizDomain: "merchantBusinessAnalysis", pageCode: "SALES_PERFORMANCE", dataRole: 1 },
});

export function defaultOutputPath() {
  const next = resolveDataPath("jst/sales", "sales-performance.sqlite");
  const legacy = join(homedir(), "jst-sales-performance.sqlite");
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
}

export function previousDate(value) {
  assertDate(value);
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10);
}

function apiParams(date, page, pageSize) {
  const previous = previousDate(date);
  return {
    pageNum: page,
    pageSize,
    dateSelectValue: {
      quickKey: "Days",
      quickSubKey: "1d",
      startDate: date,
      endDate: date,
      preDate: "",
      preStartDate: previous,
      preEndDate: previous,
    },
    startDate: date,
    endDate: date,
    preDate: "",
    preStartDate: previous,
    preEndDate: previous,
    timePeriod: "day",
    timePeriodFullFlag: 1,
    selectSaleType: "",
    sortMap: { net_order_amt: "DESC" },
  };
}

export async function fetchSalesPerformance(session, date, pageSize = 500) {
  assertDate(date);
  const transport = createJstTransport({ session, profile: PROFILE });
  const extraData = { debounce: true, customColumnTableCode: TABLE_CODE };
  const context = { bizDomain: "merchantBusinessAnalysis", pageCode: "SALES_PERFORMANCE" };

  const fetchPage = (page) => transport.request(API_CODE, apiParams(date, page, pageSize), {
    extraData,
    context,
  });

  const first = await fetchPage(1);
  const total = Number(first.total ?? first.data?.length ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const rows = [...(first.data ?? [])];
  for (let page = 2; page <= pages; page += 1) {
    const payload = await fetchPage(page);
    rows.push(...(payload.data ?? []));
  }
  return {
    date,
    total,
    pages,
    rows: rows.filter((row) => row.channel_name),
  };
}

/* ------------------------------------------------------------------ *
 * 归一化：口径与旧实现逐字一致
 * ------------------------------------------------------------------ */

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function percent(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value).replaceAll(",", ""));
  return Number.isFinite(parsed) ? Math.round(parsed * 10_000) / 100 : null;
}

function ownerName(shopName) {
  return shopName.match(/[（(]([^）)]+)[）)]/)?.[1] ?? "";
}

function overview(row, values) {
  const chain = percent(row.net_order_amt_chain);
  const section1 = [
    "销售",
    values.netSalesIncome !== null
      ? `净销${(values.netSalesIncome / 10_000).toFixed(1)}万${chain !== null ? `${chain >= 0 ? "+" : "-"}${Math.abs(chain).toFixed(1)}%` : ""}`
      : null,
    values.orderCount !== null ? `订单${Math.round(values.orderCount)}` : null,
    values.orderUnitPrice !== null ? `笔单价${values.orderUnitPrice.toFixed(0)}` : null,
  ].filter(Boolean).join(" ");
  const section2 = [
    "发货",
    values.sendRatio48h !== null ? `48小时${values.sendRatio48h.toFixed(0)}%` : null,
    values.averageSendHours !== null ? `平均${values.averageSendHours.toFixed(0)}小时` : null,
  ].filter(Boolean).join(" ");
  return [section1, section2].filter(Boolean).join(" | ");
}

export function normalizeSalesRow(reportDate, row, syncedAt) {
  const shopName = String(row.channel_name ?? "");
  const platform = String(row.platform ?? row.buyer_platform ?? "");
  const shopId = String(row.channel_id ?? row.buyer_shop_id ?? `${platform}:${shopName}`);
  const netSalesIncome = number(row.net_order_amt);
  const salesAmount = number(row.order_amt);
  const orderCount = number(row.order_cnt);
  const salesCost = number(row.order_sku_cost);
  const netProfit = number(row.order_sku_profit);
  const refundOnly = number(row.afs_refund_amt);
  const paymentRefund = number(row.pay_order_refund_amt);
  const values = {
    reportDate,
    shopId,
    shopName,
    platform,
    ownerName: ownerName(shopName),
    salesAmount,
    netSalesIncome,
    salesQuantity: number(row.order_item_qty),
    orderCount,
    orderUnitPrice: number(row.pre_order_price),
    customerUnitPrice: orderCount && netSalesIncome !== null
      ? Math.round((netSalesIncome / orderCount) * 100) / 100
      : null,
    salesChainPercent: percent(row.net_order_amt_chain),
    shippedGrossMarginPercent: percent(row.order_sku_gross_profit_rate),
    shippedNetProfitPercent: netSalesIncome && netProfit !== null
      ? Math.round((netProfit / netSalesIncome) * 10_000) / 100
      : null,
    shippedNetProfit: netProfit,
    salesCost,
    commission: number(row.common_commission),
    platformFees: number(row.total_fee),
    advertisingCosts: number(row.advertising_costs),
    refundAmount: refundOnly !== null || paymentRefund !== null
      ? Math.round(((refundOnly ?? 0) + (paymentRefund ?? 0)) * 100) / 100
      : null,
    refundOnlyAmount: refundOnly,
    shippedRefundAmount: number(row.afs_refund_send_amt),
    returnedQuantity: number(row.afs_refund_qty),
    sendRatio48h: percent(row.send_ratio_48hours),
    sendRatio24h: percent(row.send_ratio_24hours),
    averageSendHours: number(row.send_rate_avg),
    delayedShipmentQuantity: number(row.delay_send_order_qty),
    stockoutOvertimeOrders: number(row.stock_out_over_time_order_cnt),
    stockoutCompensation: number(row.stock_out_damages_amt),
    delayedShipmentPercent: percent(row.delay_send_qty_ratio),
    dailyShippedOrders: number(row.send_order_cnt),
    shippedQuantity: number(row.send_order_qty),
    paidShippedAmount: number(row.pay_send_order_amt),
    paidShippedQuantity: number(row.pay_send_order_qty),
    paidShippedOrders: number(row.pay_send_order_cnt),
    paidSendRatio: percent(row.pay_send_ratio),
    markupMultiple: salesAmount > 0 && salesCost > 0
      ? Math.round((salesAmount / salesCost) * 100) / 100
      : null,
    syncedAt,
  };
  return { ...values, overview: overview(row, values), rawJson: JSON.stringify(row) };
}

/* ------------------------------------------------------------------ *
 * 落库
 * ------------------------------------------------------------------ */

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
  const db = openDatabase(resolvedPath);
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
    return {
      output: resolvedPath,
      report_date: reportDate,
      rows: rows.length,
      duration_ms: durationMs,
    };
  } catch (error) {
    try { db.exec("ROLLBACK;"); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

export function readSalesRows(outputPath, reportDate, limit) {
  const db = openDatabase(outputPath, { readOnly: true });
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
  const db = openDatabase(outputPath, { readOnly: true });
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

