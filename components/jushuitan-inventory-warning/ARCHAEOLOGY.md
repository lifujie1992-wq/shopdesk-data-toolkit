# 聚水潭「商品采购及库存预警」考古记录

## 范围

- 主入口：`https://www.erp321.com/epaas`
- 功能页：`https://src.erp321.com/erp-data/inventoryWarning/home?_c=jst-epaas&epaas=true`
- 登录方式：复用当前 Chrome 的聚水潭登录态
- 本轮验证能力：库存预警汇总、款式列表、列表合计、分页
- 未执行：导出、极速采购、生成采购单、批量修改、预警规则配置

功能页由主入口中的跨域 iframe 加载。CLI 应先查找已登录的 `erp321.com` 标签页，再在功能页上下文执行请求。

## 页面结构

主要视图：

- `采购库存预警` / `配置预警规则`
- `按款式看` / `按SKU看`
- 场景：缺货款式、新款、爆款、增长款、低库存款、滞销款、无销量有库存款式
- 操作：搜索、重置、快捷查询、极速采购、生成采购单、批量修改、导出、自定义列
- 默认分页：10 条/页

主要筛选包括发货仓、平台/店铺、分销商、款式编码、标签、库存数、销量、未发货件数、毛利率、预测退款率、采购备注及备注时间。

## API 约定

共同请求：

- Origin：`https://src.erp321.com`
- Host：`https://api.erp321.com`
- Method：`POST`
- `credentials: "include"`
- 必需请求头：`Content-Type: application/json`
- 页面原请求还包含 `gwfp`、`pageparam`、`u_co_id`、`u_id`，但独立重放验证表明默认查询不需要显式复制这些头。
- 响应 envelope：`{ code, act, msg, data, total, success, requestId, ext }`
- 成功条件：HTTP 200、`code === 0`、`success === true`

共同 body 外层：

```json
{
  "coid": "",
  "uid": "",
  "data": {
    "apiCode": "<per endpoint>",
    "apiParams": {},
    "bizDomain": "purchaseAlarm",
    "pageCode": "PURCHASE_ALARM",
    "sysEnv": "ERP"
  }
}
```

默认 `apiParams`：

```json
{
  "hasSkuInfo": 1,
  "skuLabelsFilterType": 1,
  "avgQtyType": "pay_qty_today",
  "noSentQtyType": "no_sent_qty",
  "grossMarginType": "gross_margin_7d",
  "sentSendRefundItemQtyRatePreType": "pre3to5",
  "remarkFlag": 1,
  "viewType": "spu",
  "excludeNoPayQtyFlag": 1,
  "realInventoryItemList": [
    { "name": "main_qty", "rate": 100 },
    { "name": "purchase_qty", "rate": 100 },
    { "name": "return_onway_item_qty", "rate": 100 },
    { "name": "return_qty", "rate": 100 },
    { "name": "in_qty" }
  ]
}
```

## 已验证接口

### 1. 预警场景汇总

```text
/jst-data-report/getData/transportData?apiCode=purchase_alarm_sku_summary
```

`data.apiCode` 为 `purchase_alarm_sku_summary`。默认查询还携带场景阈值，例如新款 30 天、缺货爆款近 7 天日均销量 50、建议采购爆款近 7 天日均销量 5、低库存可售 0-5 天、滞销可售 30 天且近 7 天日均销量不高于 5。

响应 `data` 为单元素数组，包含 `cnt`、`spu_stockout_count`、`advice_purchase_spu_count`、各场景数量及未发货时间分段统计。

### 2. 款式/SKU 明细

```text
/jst-data-report/getData/transportData?apiCode=purchase_alarm_sku_detail
```

附加请求参数：

```json
{
  "childrenSortMap": { "advice_purchase_qty": "DESC" },
  "sortMap": { "advice_purchase_qty": "DESC" },
  "pageSize": 10,
  "pageNum": 1
}
```

`data.customColumnTableCode` 为 `procurement_rt_warning_table`。响应 `data` 是款式数组，`total` 是总记录数。每个款式的 `children` 字段是 JSON 字符串，必须再次 `JSON.parse` 才能得到 SKU 数组。

分页已验证：将 `pageNum` 改为 2、`pageSize` 改为 2 后返回 2 条记录，`total` 保持一致。

关键字段：

- 商品：`spu_id`、`spu_name`、`spu_pic`、`brand_name`、`category`、`supplier_name`
- 库存：`available_qty`、`available_day`、`main_qty`、`in_qty`、`purchase_qty`、`return_qty`
- 销售：`pay_qty_*`、`pay_avg_qty_*`、`goods_link_cnt*`
- 风险：`stockout_qty`、`no_sent_qty`、`timeout_qty`、`will_timeout_qty_*`
- 建议：`advice_purchase_qty`
- SKU 子项：`sku_id`、`sku_name`、`properties_value`、`cost_price`、`last_purchase_price`

### 3. 列表合计

```text
/jst-data-report/getData/transportData?apiCode=purchase_alarm_sku_detail_summary
```

响应 `data` 为单元素数组，包含建议采购、各类库存、销售、出库、退货、缺货、未发货和超时分段的合计值。

## 页面上下文验证表达式

下面的模式已通过 OpenBridge `browser_evaluate` 验证。原始调用返回 Promise，因此应启动异步请求并轮询全局结果：

```javascript
(() => {
  globalThis.__jstProbe = { state: "pending" };
  fetch("//api.erp321.com/jst-data-report/getData/transportData?apiCode=purchase_alarm_sku_detail", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody)
  })
    .then(async (response) => ({ status: response.status, json: await response.json() }))
    .then(({ status, json }) => {
      globalThis.__jstProbe = {
        state: "fulfilled",
        status,
        code: json.code,
        success: json.success,
        total: json.total,
        data: json.data
      };
    })
    .catch((error) => {
      globalThis.__jstProbe = { state: "rejected", message: String(error) };
    });
  return globalThis.__jstProbe;
})()
```

## 完整页面接口地图

本次范围仅限当前库存预警页，不跳转其他页面。主页面首屏初始化、今日销量分渠道弹窗、销售分析抽屉以及按平台 / 按渠道 /  
按链接三个 Tab 的完整调用关系和字段见 [`PAGE-API-MAP.md`](./PAGE-API-MAP.md)。

## 风险与待验证项

- 搜索、汇总和分页为只读，可作为首版 CLI 能力。
- 导出会产生文件；需要单独考古任务创建、轮询和下载接口。
- 极速采购、生成采购单、批量修改和规则配置会改变业务数据，必须单独确认并增加预览/确认机制。
- 未观察到验证码；登录失效与无权限响应尚未验证。
- 未观察到明确限流响应；CLI 应限制并发并对非 200、`code !== 0` 或 `success !== true` 返回结构化错误。
- 网络抓包工具未返回事件，本记录的 URL 来源于 Performance Resource Timing，请求细节来自页面内只读 fetch 包装与独立重放。

## 店铺缺货处罚预警

- 菜单：`订单 → 缺货处罚预警 → 按链接看`
- 页面：`/erp-data/stockOutAlarm/home`
- 请求上下文：`bizDomain=stockOutAlarm`、`pageCode=STOCK_OUT_ALARM`
- 列表接口：`stock_out_shop_spu_alarm_list`
- 汇总接口：`stock_out_shop_spu_alarm_summary`
- 场景：`cardType=lackSku`
- 维度：店铺链接（`goodsType=shop_spu`），响应包含 JSON 字符串形式的店铺 SKU 子项

列表独立重放验证了分页、店铺标识、缺货分量、未发货件数以及超时分段。关键字段：

- 店铺：`shop_id`、`shop_name`、`platform`、`shop_type`
- 链接：`shop_spu_id`、`shop_spu_name`、`shop_sku_url`、`shop_sku_cnt`
- 未发：`no_sent_qty`、`no_sent_order_cnt`
- 已超时：`timeout_qty`、`timeout_order_cnt`
- 一天内超时：`will_timeout_qty_1d`、`will_timeout_order_cnt_1d`
- 缺货分量：`present_stock_out_qty`、`insent_no_present_stock_out_qty`、  
  `presale_no_present_will_timeout_stock_out_qty_1d_30d_or_timeout`

页面没有名为「急缺件数」的原始字段。CLI 的店铺急缺件数固定为  
`timeout_qty + will_timeout_qty_1d`，即页面的「已超时」加「剩余<=1天」。

## 单款销售分析弹窗

- 入口：商品采购及库存预警表格 → 操作 → 销售分析
- 店铺明细接口：`purchase_goods_analysis_trend_detail`
- 趋势接口：`purchase_goods_analysis_trend_curve`
- 店铺维度：`countType=channel`
- 商品参数：`queryType=spu`、`spuId`
- 当前区间：`startDate`、`endDate`
- 对比区间：`preStartDate`、`preEndDate`
- 店铺字段：`shop_id`、`shop_name`、`platform`
- 销售字段：`order_item_qty`、`order_item_qty_increase`、`order_item_qty_chain`
- 支付退货字段：`afs_return_refund_qty`、`afs_return_refund_qty_chain`
- 趋势日期：`biz_date`
- 趋势字段：`order_item_qty`、`order_amt`、`order_cnt`、`net_order_amt`

`order_item_qty_chain` 和 `afs_return_refund_qty_chain` 都是环比小数比率；页面将其  
乘以 100 显示为百分数。上期销售件数可由  
`order_item_qty - order_item_qty_increase` 得到。上一期为 0 时销售环比为空。  
趋势接口直接返回每日销售件数、销售金额、订单数和净销售金额；不需要自行聚合  
订单明细或推算。

该功能当前页面实际为右侧抽屉，并有三个维度。三者共用  
`purchase_goods_analysis_trend_detail`：

- 按平台：`countType=platform`，表格码 `procurement_rt_warning_table_platform`
- 按渠道：`countType=channel`，表格码 `procurement_rt_warning_table_channel`
- 按链接：`countType=link`，表格码 `procurement_rt_warning_table_link`

CLI 已提供同名 `platform`、`channel`、`link` 子命令；原 `shops` 是 `channel`  
的兼容别名。
