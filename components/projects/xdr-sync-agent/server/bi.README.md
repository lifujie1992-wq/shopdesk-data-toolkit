# BI

BI 层读取数仓明细和 ADS 结果，负责统一口径、关联维度、加工汇总和对外 API。

## Dimensions

- SKU：`sku_id`
- SPU/商品：订单商品明细的 `i_id`，库存维度的 `spu_id`
- 店铺：`shop_id`、`shop_name`
- 平台：`platform`
- 日期：订单商品的支付日期或上游报表明确提供的业务日期

## Source Classification

按以下优先级生成 `source_type`：

1. 标签含 `精选联盟`，或达人 ID/名称有值：`精选联盟`
2. 否则标签含 `直播`：`直播间`
3. 其余：`商品卡`

原始标签和达人字段保留在数仓中，BI 只返回分类后的统一指标。

## API

- `/v1/bi/sales-channels?query_type=sku&product_id=...&count_type=platform`：SKU/SPU 按平台销量
- `/v1/bi/sales-channels?query_type=sku&product_id=...&count_type=channel`：SKU/SPU 按店铺/渠道销量
- `/v1/bi/platform-sales?spu_id=...`：SPU + 平台汇总
- `/v1/bi/shop-sales?spu_id=...`：SPU + 店铺汇总
- `/v1/bi/link-sales?spu_id=...`：SPU + 店铺商品链接汇总
- `/v1/bi/sku-source-sales?sku_id=...`：SKU 的精选联盟/直播间/商品卡销量
- `/v1/bi/sku-platform-sales-daily?sku_id=...`：SKU + 平台的每日事实指标
- `/v1/bi/sku-source-sales?sku_id=...&shop_id=...`：SKU + 店铺粒度
- `/v1/bi/shop-directory`：聚水潭 `platform_shop_list` 的完整平台—店铺目录
- `/v1/bi/product-scope?platform=拼多多&shop_id=...`：所选平台/店铺关联的 SPU 集合；多个同名参数按并集筛选
- `/v1/bi/shop-products/status`：店铺商品 DuckDB 快照时间、文件数及商品/SKU 总数
- `/v1/bi/shop-product-items?platform=淘宝&limit=100`：店铺商品链接主表；支持 `shop_id`、平台商品编码、内部商品编码和上下架状态筛选
- `/v1/bi/shop-product-code-summary?product_code=34284`：纯数字商品编码汇总；自动合并 `34284-`、`品34284-`、`34284-A` 等数字部分相同的原始编码，返回总链接、上下架链接、店铺及平台统计
- `/v1/bi/shop-product-skus?platform=拼多多&limit=100`：店铺 SKU 明细；支持平台商品/SKU 编码、内部 SKU 编码和上下架状态筛选
- `/v1/bi/shop-product-status-changes?change_date=2026-09-10`：每日新增、删除及上下架状态变化

店铺商品主表和 SKU 接口使用 `after_rowid` 游标分页。每次把响应中的
`next_cursor` 作为下一页 `after_rowid`，直到 `has_more=false`；不要使用大 offset
扫描千万级明细。所有接口使用统一的 `X-API-Key` 请求头。

接口固定返回三个 `source_type`，并包含今日、昨日、近 3/7/15/30 天销量、
`captured_at`、`business_date` 和 `data_version`。旧的
对应的旧 `/v1/warehouse/...` 销量路径仅作为隐藏兼容入口，不再作为正式契约。

数仓层继续负责接收、校验并原子发布事实数据；下游不直接读取数仓原始表。

日事实表 `bi_sku_platform_sales_daily` 以
`biz_date + sku_id + platform` 为主键，包含 `spu_id`、`sales_qty`、
`order_count`、`sales_amount`、`refund_qty`、`refund_amount`、`gross_margin`。
上游未直接提供的指标必须保留 null。
