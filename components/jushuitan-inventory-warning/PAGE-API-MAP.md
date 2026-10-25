# 商品采购及库存预警：完整接口地图

考古日期：2026-09-08。页面版本：`7ba80486-async.47f2c373.js`。

本文覆盖商品采购及库存预警首屏、主表、今日销量分渠道弹窗、销售分析抽屉，  
以及抽屉内按平台、按渠道、按链接三个 Tab。接口通过当前登录态实际页面观察，  
核心数据接口均已独立重放。创建采购单、修改采购数、保存配置等写接口不在  
“还原只读页面”的调用链中，本文只在末尾列出边界，不执行重放。

## 通用协议

- API host：`https://api.erp321.com`
- 报表请求：`POST /jst-data-report/getData/transportData?apiCode=<apiCode>`
- 业务下拉请求还会使用 `getBusinessData`、`getErpData`
- Origin / Referer：`https://src.erp321.com` / `https://src.erp321.com/`
- 登录态：`u_sso_token`、`u_id`、`u_co_id` Cookie
- 页面上下文：`bizDomain=purchaseAlarm`、`pageCode=PURCHASE_ALARM`、`sysEnv=ERP`
- 通用响应：`{ code, act, msg, data, total, success, requestId, ext }`

报表 body：

```json
{
  "coid": "",
  "uid": "",
  "data": {
    "apiCode": "purchase_goods_analysis_trend_detail",
    "apiParams": {},
    "bizDomain": "purchaseAlarm",
    "pageCode": "PURCHASE_ALARM",
    "sysEnv": "ERP"
  }
}
```

## 首屏初始化接口

以下是一次干净加载中观察到的完整请求集合。基础框架、活动和鉴权请求也列出，  
避免重做页面时误以为主表三个接口就是全部调用。

| 路径 / apiCode                                    | 用途            | 关键参数                     |
| ----------------------------------------------- | ------------- | ------------------------ |
| `getAuth/getAuth`                               | 页面权限          | 页面框架生成                   |
| `pageInfo/getPageInfo`                          | 页面元数据         | 当前路由                     |
| `query_front_storage_version`                   | 前端配置版本        | 空参数                      |
| `query_user_biz_config`                         | 用户列折叠、展示配置    | `operateType`            |
| `query_current_promotion_info`                  | 当前活动提示        | 空参数                      |
| `get_user_action_role`                          | 页面按钮、成本字段权限   | 空参数                      |
| `query_base_code_item_list`                     | 页面枚举          | 页面配置的 code               |
| `query_purchase_alarm_config`                   | 采购预警规则和全仓库存组成 | 空参数                      |
| `global_analysis_date_inner`                    | 数据可用日期        | 空参数                      |
| `query_platform_icon`                           | 平台图标          | `bizDomain=commonDomain` |
| `report_wms_partner_query` (`getErpData`)       | 发货仓           | 空参数                      |
| `platform_shop_list`                            | 平台 / 店铺选择器    | 空参数                      |
| `query_shop_group_config`                       | 店铺分组          | 空参数                      |
| `get_drp_list` (`getBusinessData`)              | 分销商           | 空参数                      |
| `get_categories` (`getBusinessData`)            | 商品分类          | 空参数                      |
| `get_brands` (`getBusinessData`)                | 商品品牌          | 空参数                      |
| `itemlabels_list` (`getBusinessData`)           | 商品标签          | 空参数                      |
| `get_vcname_list` (`getBusinessData`)           | 虚拟分类          | 空参数                      |
| `get_erp_supplier_list` (`getBusinessData`)     | 供应商           | 空参数                      |
| `select_data_product_quick_query_pool`          | 快捷查询          | 页面码                      |
| `export_file_split_key`                         | 导出分片能力初始化     | 页面码                      |
| `query_custom_column_limit` (`getBusinessData`) | 自定义列上限        | 表格码                      |
| `query_purchase_prepare_config_flag`            | 备货配置状态        | 空参数                      |
| `query_data_page_table_config`                  | 表格列配置         | `tableCode`              |
| `query_data_indicators`                         | 字段口径提示        | `tableCode`              |

主表业务数据：

| apiCode                             | 用途            | 表格码                            |
| ----------------------------------- | ------------- | ------------------------------ |
| `purchase_alarm_sku_summary`        | 顶部场景数量        | 无                              |
| `purchase_alarm_sku_detail`         | 款式 / SKU 分页明细 | `procurement_rt_warning_table` |
| `purchase_alarm_sku_detail_summary` | 当前查询合计        | 无                              |

主表的完整筛选参数、场景阈值和库存组成见 `ARCHAEOLOGY.md`。

## 今日销量分渠道弹窗

点击主表“今日销量”下的“分渠道看”，打开 1000px 弹窗。它只有两个 Tab，  
不要与下方销售分析抽屉混淆。

- 数据 apiCode：`purchase_alarm_sale_channel_detail`
- `countType=platform`：按平台
- `countType=channel`：按渠道
- 商品粒度：`queryType=spu, spuId` 或 `queryType=sku, skuId`
- 分页：`pageNum`、`pageSize`
- 可选过滤：`shopIds`、`platforms`、`disCoIds`
- 可选排序：`sortMap`
- 列配置存储键：`sale_channel_detail_platform|channel`
- 字段：`pay_qty_today`、`pay_qty_3d`、`pay_qty_7d`、`pay_qty_15d`、  
  `pay_qty_30d`，外加平台或店铺标识字段

当前页登录态独立重放（SPU `66353`）返回按平台 3 行、按渠道 24 行，字段与  
弹窗一致；CLI 的 `sale-channel` 即调用此接口。主表问号/眼睛图标的公式提示  
为页面内计算/Popover，观察期间未产生独立数据请求。

## 销售分析抽屉

入口包括主表操作列“销售分析”，以及店铺链接数中的“昨日动销 / 近7天动销”。  
后者会把 `$tab=link` 和对应 `$timeType` 带入抽屉，因此打开后默认落在按链接。

抽屉打开后并发调用：

| apiCode                                | 调用次数 / 条件         | 用途                                        |
| -------------------------------------- | ----------------- | ----------------------------------------- |
| `purchase_goods_analysis_trend_curve`  | 每次日期或过滤条件变化       | 顶部每日趋势图                                   |
| `purchase_goods_analysis_trend_detail` | 当前 Tab、分页、排序或条件变化 | 三个 Tab 的表格数据                              |
| `query_user_biz_config`                | 每个表格实例            | 列折叠配置，`operateType=TABLE_COLUMN_COLLAPSE` |
| `query_data_page_table_config`         | 每个 Tab            | 用户列配置                                     |
| `query_data_indicators`                | 每个 Tab            | 字段说明和统计口径                                 |

趋势请求不带 `countType` 和分页：

```json
{
  "startDate": "2026-09-01",
  "endDate": "2026-09-07",
  "preDate": "2026-08-25",
  "preStartDate": "2026-08-25",
  "preEndDate": "2026-08-31",
  "queryType": "spu",
  "spuId": "61427"
}
```

趋势响应每行以 `biz_date` 为日期，指标为 `order_item_qty`、`order_amt`、  
`order_cnt`、`net_order_amt`。

### 三个 Tab 的共同请求

```json
{
  "startDate": "2026-09-01",
  "endDate": "2026-09-07",
  "preDate": "2026-08-25",
  "preStartDate": "2026-08-25",
  "preEndDate": "2026-08-31",
  "countType": "link",
  "pageNum": 1,
  "pageSize": 10,
  "queryType": "spu",
  "sortMap": { "order_item_qty": "DESC" },
  "spuId": "61427"
}
```

可选过滤参数为 `saleType`、`shopIds`、`distributorIds`。查询 SKU 时改为  
`queryType=sku, skuId=<id>`，不要同时强行传 SPU 和 SKU。

| Tab | `countType` | `customColumnTableCode`                 | 标识字段                                           |
| --- | ----------- | --------------------------------------- | ---------------------------------------------- |
| 按平台 | `platform`  | `procurement_rt_warning_table_platform` | `platform`                                     |
| 按渠道 | `channel`   | `procurement_rt_warning_table_channel`  | `shop_id`, `shop_name`, `platform`             |
| 按链接 | `link`      | `procurement_rt_warning_table_link`     | 渠道字段 + `shop_spu_*`, `shop_i_id`, `shop_sku_*` |

三个维度共同经营字段：

- 销售：`order_item_qty`、`order_item_qty_increase`、`order_item_qty_chain`
- 金额：`order_amt`、`order_amt_increase`、`order_amt_chain`
- 订单：`order_cnt`、`order_cnt_increase`、`order_cnt_chain`
- 支付退货：`afs_return_refund_qty`、`afs_return_refund_qty_chain`
- 180 天：`afs_return_refund_qty_180d`、`inout_sent_item_qty_180d`
- 利润及预测：`gross_margin_7d`、`gross_margin_30d` 和各发货时间段退款率字段；  
  账号无权限或无数据时字段可能不返回，不能用商品汇总值回填

按链接独有字段：`shop_spu_id`、`shop_i_id`、`shop_spu_name`、`shop_spu_pic`、  
`shop_spu_created`、`shop_spu_created_day`、`shop_sku_id`、`shop_sku_url`。

2026-09-08 对 SPU `61427`、近 7 天独立重放结果：按平台 `total=2`、按渠道  
`total=14`、按链接 `total=24`。三个请求的合计与页面显示一致。

## CLI 重放

```bash
jst-inventory sales-analysis platform --spu-id 61427 --days 7 --end-date 2026-09-07
jst-inventory sales-analysis channel  --spu-id 61427 --days 7 --end-date 2026-09-07
jst-inventory sales-analysis link     --spu-id 61427 --days 7 --end-date 2026-09-07
```

`shops` 保留为 `channel` 的兼容别名。返回中的 `rows` 是统一数组；渠道维度还保留  
原有 `shops` 字段，避免破坏现有 XDR 和 SQLite 同步。

## 写接口边界

线上 bundle 还包含 `save_purchase_alarm_config`、`update_purchase_remark`、  
`create_purchase_order`、`save_data_page_table_config`、`save_user_biz_config` 等接口。  
它们会修改业务数据或用户配置，不属于只读页面复刻所需的数据读取链路，本次没有  
执行。实现复刻页面时，应将这些按钮置于独立的确认和权限流程中。
