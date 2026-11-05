# 下游字段覆盖说明

本文档对应 SQLite schema version 4。字段同时出现在 `spu_inventory` 和  
`sku_inventory` 时，分别代表款式汇总值和 SKU 值；SKU 独有字段只在  
`sku_inventory` 中提供。

## 已显式落库

| 需求         | SQLite 字段                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 名称、图片、规格   | `spu_name`, `spu_pic`, `sku_name`, `pic`, `properties_value`                                                                                                                                                        |
| 品牌、分类、虚拟分类 | `brand_name`, `category`, `vc_name`                                                                                                                                                                                 |
| 供应商、标签     | `supplier_id`, `supplier_name`, `sku_labels`, `labels`                                                                                                                                                              |
| 创建及采购备注    | `created`, `i_created`, `spu_remark`, `sku_remark`, `remark_time`, `remark_u_id`, `remark_u_name`                                                                                                                   |
| 成本及采购价     | `cost_price`, `last_purchase_price`（SKU）                                                                                                                                                                            |
| 库存组成       | `main_qty`, `purchase_qty`, `return_onway_item_qty`, `return_qty`, `in_qty`, `allocate_qty`, `wms_qty`, `real_qty`, `onway_qty`                                                                                     |
| 可售及缺货      | `available_qty`, `available_day`, `available_avg_qty`, `stockout_qty`                                                                                                                                               |
| 未发货总数及预售   | `no_sent_qty`, `no_sent_qty_all`, `pre_no_sent_qty`, `pre_no_sent_qty_all`                                                                                                                                          |
| 未发货时效      | `timeout_qty`, `will_timeout_qty_1d`, `will_timeout_qty_1d_3d`, `will_timeout_qty_3d_7d`, `will_timeout_qty_7d` 及对应 `_all` 字段                                                                                       |
| 销量         | `pay_qty_today`, `pay_qty_1d`, `pay_qty_3d`, `pay_qty_7d`, `pay_qty_15d`, `pay_qty_30d`, `pay_qty_180d`                                                                                                             |
| 日均销量       | `pay_avg_qty_1d`, `pay_avg_qty_3d`, `pay_avg_qty_7d`, `pay_avg_qty_15d`, `pay_avg_qty_30d`, `pay_avg_qty_180d`                                                                                                      |
| 出库         | `inout_sent_item_qty_today`, `inout_sent_item_qty_1d`, `inout_sent_item_qty_3d`, `inout_sent_item_qty_7d`, `inout_sent_item_qty_15d`, `inout_sent_item_qty_30d`, `inout_sent_item_qty_180d`                         |
| 退货         | `return_item_qty_3d`, `return_item_qty_7d`, `return_item_qty_15d`, `return_item_qty_30d`, `return_item_qty_180d` 及同周期 `return_fact_item_qty_*`                                                                      |
| 店铺链接       | `goods_link_cnt`, `goods_link_cnt_1d`, `goods_link_cnt_7d`                                                                                                                                                          |
| 毛利及利润      | `gross_margin_7d`, `gross_margin_30d`, `order_goods_profit_rate_7d`, `order_goods_profit_rate_30d`, `per_order_goods_profit_7d`, `per_order_goods_profit_30d`, `order_sku_gross_profit_7d`, `net_order_item_amt_7d` |
| 退款率预测      | `sent_send_refund_afs_item_qty_rate_pre3to5`, `sent_send_refund_afs_item_qty_rate_pre5to7`                                                                                                                          |
| 采购建议       | `advice_purchase_qty`, `wait_audit_purchase_qty`                                                                                                                                                                    |

所有字段只读取接口同名值；接口未返回时保持 `NULL`，不再用日均值补数量，也不  
自行计算平均值。所有接口原始字段仍保留在 `raw_json`。  
旧的 `pay_avg_qty_7d_calculated` 列仅为 schema 兼容而保留，值固定为 `NULL`。

## 当前接口未直接提供

- 独立的普通商品备注（当前只有采购预警备注）
- 采购备注创建时间与商品创建时间之外的采购业务时间
- 今日、昨日退货量及今日、昨日销退货入库件数
- 采购后可售天数所需的自定义采购天数、售后率和可用比例配置
- 新款、爆款、增长款、滞销款等场景的完整规则明细

这些字段不能从当前明细响应可靠推导。需要验证新的只读接口或由下游提供明确  
业务口径后再补充，不能用空值或未经确认的公式替代。

## 单款销售分析（店铺维度）

`jst-inventory sales-analysis shops --spu-id ID` 对应库存预警表格操作列的  
「销售分析」弹窗。店铺行提供：

| 需求          | 标准化字段                     | 接口原字段                             |
| ----------- | ------------------------- | --------------------------------- |
| 销售件数        | `sales_qty`               | `order_item_qty`                  |
| 销售件数增量      | `sales_increase`          | `order_item_qty_increase`         |
| 销售件数环比      | `sales_chain_ratio`       | `order_item_qty_chain`            |
| 支付退货件数      | `paid_return_qty`         | `afs_return_refund_qty`           |
| 180 天支付退货件数 | `paid_return_qty_180d`    | `afs_return_refund_qty_180d`      |
| 180 天退货件数   | `return_item_qty_180d`    | `afs_return_refund_qty_180d`（店铺行） |
| 支付退货件数环比    | `paid_return_chain_ratio` | `afs_return_refund_qty_chain`     |

环比只保留接口原始小数比率；`previous_*` 和 `*_percent` 等曾经由 CLI 推导的  
兼容列保持 `NULL`。接口必须传  
单个 `spuId`，不支持一次查询全部商品。XDR 全量库存同步会受控并发遍历所有 SPU，  
写入 `shop_product_sales_analysis` 和 `sales_analysis_export_info`。

页面前端列定义已验证：“近180天退货件数”的接口字段就是  
`afs_return_refund_qty_180d`。`return_item_qty_180d` 直接重命名该店铺行字段，  
不会从商品汇总表回填或摊分。  
店铺表中的预测退款率字段同样只读取店铺明细响应；某店铺行未返回时保持 `NULL`，  
不得用 `spu_inventory` 的商品汇总预测值补齐。

## 单款销售分析（每日趋势）

`jst-inventory sales-analysis daily --spu-id ID` 读取同一弹窗的每日趋势。四项  
指标均为接口直接返回值，不是 CLI 推算值：

| 需求        | 标准化字段              | 接口原字段            |
| --------- | ------------------ | ---------------- |
| 商品每日销售件数  | `sales_qty`        | `order_item_qty` |
| 商品每日销售金额  | `sales_amount`     | `order_amt`      |
| 商品每日订单数   | `order_count`      | `order_cnt`      |
| 商品每日净销售金额 | `net_sales_amount` | `net_order_amt`  |

日期字段为 `biz_date`。XDR 全量库存同步通过既有的  
`--include-sales-analysis` 开关一并采集，并写入  
`product_daily_sales_analysis`，主键为 `spu_id + biz_date`。

`shop_daily_sales_analysis` 通过同一弹窗的单日“按渠道”明细取得真实店铺行，  
主键为 `spu_id + shop_id + biz_date`。其中 `sales_qty`、`sales_amount`、  
`order_count`、`return_item_qty` 分别来自该店铺行的 `order_item_qty`、`order_amt`、  
`order_cnt`、`afs_return_refund_qty`。每日更新只请求并覆盖昨天，历史日期继续保留。

## 店铺缺货预警（独立导出）

`jst-inventory shop-shortage export-sqlite` 对应「缺货处罚预警 → 按链接看」，  
写入独立的 `jst-shop-shortage.sqlite`：

| 需求      | `shop_shortage_summary` 字段 | 来源/口径                             |
| ------- | -------------------------- | --------------------------------- |
| 店铺缺货件数  | `shop_stockout_qty`        | 预发货、现货未发、预售未发的接口缺货分量之和            |
| 店铺急缺件数  | `shop_urgent_stockout_qty` | `timeout_qty + due_within_1d_qty` |
| 店铺未发货件数 | `shop_no_sent_qty`         | `no_sent_qty`                     |

`shop_stockout_warning` 保留店铺链接明细、各原始时效字段、解析后的 SKU 子项和  
`raw_json`。`shop_shortage_summary` 是按 `shop_id` 汇总后的下游读取表。急缺并非  
聚水潭页面的原始字段名，本项目将页面的「已超时」和「剩余<=1天」合并，并在  
`export_info.urgent_definition` 中固化该口径。

## 库存与缺货日指标

带店铺缺货数据的完整导出会生成 `inventory_daily_metrics`，主键为  
`snapshot_date`。同一天的多次同步覆盖当天行，历史日期继续保留。

| 指标        | 字段                      | 来源/口径                         |
| --------- | ----------------------- | ----------------------------- |
| 预警款数      | `warning_style_count`   | 缺货处罚预警中唯一的店铺款式行数              |
| 缺货件数      | `stockout_qty`          | 店铺款式的三类缺货分量合计                 |
| 急缺件数      | `urgent_stockout_qty`   | 已超时加 1 天内即将超时                 |
| 已超时件数     | `overdue_qty`           | 页面 `timeout_qty`，用于“急缺（超时）”口径 |
| 预售缺货件数    | `presale_stockout_qty`  | 页面预售无现货缺货分量                   |
| 未发货件数     | `unshipped_qty`         | 店铺款式 `no_sent_qty` 合计         |
| 可售库存件数    | `available_qty`         | 款式级 `available_qty` 合计        |
| 在途件数      | `onway_qty`             | 款式级 `onway_qty` 合计            |
| 近 7 天动销款数 | `active_style_count_7d` | `pay_qty_7d > 0` 的款式数         |

`jst-inventory daily-metrics --input PATH` 可直接从已有完整 SQLite 快照读取上述  
指标，不产生新的聚水潭请求。
