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
