# 抖店「给消费者开票」接口契约（实测抓取）

> 2026-10-19 主体字段设计：[主体同步接口补充](2026-10-19_主体同步接口补充.md)。在原有订单/账单记录内直接增加 `companyName`、`creditCode`，消费者已按用户确认的业务规则使用店铺最新主体。消费者 `list/detail` 本次实测未返回销售方开票主体；`title/tax_no` 为购买方，主体字段由独立主体接口的最新主体填入。

> 抓取方式：通过店铺工作台（Electron）`flyge_probe` 在「南北行时尚服饰」页面上下文实测。  
> 页面路径：`https://fxg.jinritemai.com/ffa/morder/receipt/list`（导航「资金 → 发票管理 → 给消费者开票」）。  
> 抓取日期：2026-10-14。供 Mac 回传代理和店铺工作台 `invoice.js` 实现使用。

---

## 0. 关键结论（重要）

1. **全部接口都可在店铺工作台页面上下文用 `fetch` 相对路径直接调用**（`credentials:'include'` 自动带登录 Cookie），**不需要** `x-secsdk-csrf-token`、`a_bogus`、`verifyFp`、`msToken` 等动态参数（实测 `list`/`detail`/`upload_pdf` 均返回 `code:0`）。
2. 接口基地址：`https://fxg.jinritemai.com`，相对路径即可。
3. 响应统一包装：`{ errno, st, msg, code, data, page, total, size, total_page }`，成功 `code===0`。
4. 因此 Mac 侧实现**走「页面 fetch 直连」即可**，不需要 UI 驱动 + 网络捕获（那是动态参数必需时的备选）。

---

## 1. 发票列表 `/order/invoice/list`

```
GET /order/invoice/list?invoice_status_desc=wait_blue&page=0&pageSize=20&shop_order_id=xxx
```

| 参数                    | 说明                                                                             |
| --------------------- | ------------------------------------------------------------------------------ |
| `invoice_status_desc` | 状态筛选：`wait_blue`（待开票）/ `wait_red`（待红冲）/ `done_blue`（已开票）/ `cancel`（已取消）/ `all` |
| `shop_order_id`       | 订单号筛选（关联查询用它精确匹配）                                                              |
| `page`                | 从 0 开始                                                                         |
| `pageSize`            | 每页数量                                                                           |

响应 `data[]` 关键字段（待开票记录）：

| 字段                                        | 类型            | 说明                               |
| ----------------------------------------- | ------------- | -------------------------------- |
| `shop_order_id`                           | string        | 订单号 = 云端 `payload.orderId`，关联唯一键 |
| `registation_id`                          | string        | 开票申请登记 ID                        |
| `invoice_type_text`                       | string        | 如「增值税电子普通发票」                     |
| `title`                                   | string        | 发票抬头（购买方名称）                      |
| `tax_no`                                  | string        | 购买方税号                            |
| `invoice_amount`                          | string        | 开票金额，格式「￥ 79.80」（需去 `￥ ` 和空格）    |
| `invoice_status`                          | number        | 1 = 待开票                          |
| `invoice_status_info.invoice_status_text` | string        | 「待开票」                            |
| `order_status` / `order_status_text`      | number/string | 订单状态（如 5 / 已完成）                  |
| `apply_time`                              | string        | 开票申请时间                           |
| `operations`                              | string[]      | 如 `["openReceipt"]`              |
| `latest_invoice_time_info.deadline_time`  | number        | 最晚开票时间（Unix 秒）                   |

实测响应片段：

```json
{
  "st": 0, "msg": "", "code": 0,
  "data": [
    {
      "registation_id": "7696384938471915837",
      "shop_order_id": "6927844451847011694",
      "invoice_type_text": "增值税电子普通发票",
      "apply_time": "2026-10-14 13:05:08",
      "invoice_status": 1,
      "order_status": 5,
      "invoice_status_info": { "icon": "warn", "invoice_status_text": "待开票" },
      "order_status_text": "已完成",
      "operations": ["openReceipt"],
      "title": "德瑞锦鑫（北京）企业管理有限公司",
      "tax_no": "91110117MA04BB3778",
      "invoice_amount": "￥ 79.80",
      "latest_invoice_time_info": { "deadline_time": 1792857599, "description_text": "2026/10/24 23:59:59" },
      "finish_time": "-"
    }
  ],
  "page": 0, "size": 5, "total": 10
}
```

---

## 2. 状态数量 `/order/invoice/get_counts`

```
GET /order/invoice/get_counts
```

页面加载时调用，返回各状态数量（`wait_blue`/`wait_red`/`done_blue`/`cancel`/`all`）。Mac 侧可选使用（自检/统计），非必需。

---

## 3. 上传详情 `/order/invoice/detail`

```
GET /order/invoice/detail?shop_order_id=xxx
```

响应 `data` 关键字段：

| 字段                        | 说明                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `status_info`             | 含 `status_text`（如「发票上传」）、`limit_size`（单文件大小上限 MB）、`invoice_status_text`（「待开票」）、`order_status_text` |
| `receipt_info[].fields[]` | 结构化开票信息：`label`/`value`（发票金额、开票状态、订单编号、发票抬头、税号、开户银行等）                                              |
| `upload_info`             | **`{ invoice_status_type: 1, blue_invoice_key?: string }`** —— 提交 `save` 时这两个字段从这里取                |
| `submit_msg`              | 提交确认提示（「请确认发票上传正确，提交后不支持修改已上传发票」）                                                                  |
| `alert_msg`               | 弹窗提示                                                                                               |

实测响应片段：

```json
{
  "code": 0,
  "data": {
    "status_info": { "status_text": "发票上传", "limit_size": 10, "status": 1, "invoice_status_text": "待开票", "order_status_text": "已完成" },
    "receipt_info": [ { "title": "基础信息", "fields": [ {"label":"发票金额","value":"79.80元"}, {"label":"订单编号","value":"6927844451847011694"} ] } ],
    "upload_info": { "invoice_status_type": 1 },
    "submit_msg": "请确认发票上传正确，提交后不支持修改已上传发票"
  }
}
```

> 关键：**`blue_invoice_key` 来自 `upload_info.blue_invoice_key`**（待开票场景通常为 null/缺省），`invoice_status_type` 来自 `upload_info.invoice_status_type`。提交时原样回传。

---

## 4. 上传发票文件 `/order/invoice/upload_pdf`

```
POST /order/invoice/upload_pdf
Content-Type: multipart/form-data
```

multipart 字段（实测成功）：

| 字段                    | 说明                                               |
| --------------------- | ------------------------------------------------ |
| `file`                | PDF 文件（字段名 `file`，文件名任意，type `application/pdf`）  |
| `shop_order_id`       | 订单号                                              |
| `invoice_status_type` | 取 detail 的 `upload_info.invoice_status_type`（=1） |
| `file_name`           | 文件名（可选，但建议带）                                     |

> 说明：页面 JS 源码里上传组件 `name="file"`、`action="/order/invoice/upload_pdf"`、`uploadParams={shop_order_id, invoice_status_type}`；文件格式限制 `.pdf/.xml/.ofd/.7z/.zip/.rar`，单个 ≤ `status_info.limit_size`（10MB），最少 1 个最多 3 个。

响应（实测）：

```json
{
  "errno": 0, "st": 0, "msg": "", "code": 0,
  "data": {
    "key": "34f099fcfd09d98142106dcf9d8c3eff",
    "url": "https://lf9-ecom-shop-sign.bytetos.com/ecom-shop-order-invoice/34f099fcfd09d98142106dcf9d8c3eff?lk3s=...&x-expires=...&x-signature=..."
  }
}
```

- `data.key` = 后续提交的 **`tos_key`**。
- `data.url` = 带签名的临时预览地址，**不落盘完整签名串**（只截 host + key）。

---

## 5. 提交开票 `/order/invoice/save`

```
POST /order/invoice/save
Content-Type: application/json
```

请求体（从页面 JS 源码确认）：

```json
{
  "shop_order_id": "6927844451847011694",
  "blue_invoice_key": "<upload_info.blue_invoice_key 或 null>",
  "invoice_status_type": 1,
  "invoice_file_list": [
    { "tos_key": "<upload_pdf 响应 data.key>", "file_name": "xxx.pdf" }
  ]
}
```

提交校验（页面逻辑）：`invoice_file_list` 非空且每项都有 `tos_key`，否则提示「请上传发票文件」；确认弹窗文案用 `detail.submit_msg`；成功后提示「开票成功」并刷新列表。

> ⚠️ 本期只抓取契约，**未实际调用 `save`**（按需求「不点提交」）。实现时按上述 body 构造即可。

---

## 6. 关联匹配判定（对齐需求）

1. 用 `payload.orderId` 作为 `shop_order_id` 调 `/order/invoice/list`（`invoice_status_desc=wait_blue`）。
2. 遍历 `data[]`，找到 `shop_order_id === payload.orderId`（**精确相等**）的记录：
   - 找到 1 条 → 关联成功；核对 `invoice_amount`（去 `￥ ` 和空格后与 `payload.amount` 比，容差 0.01）+ `invoice_status_info.invoice_status_text==='待开票'`。
   - 找到 0 条 → 关联失败（订单不在待开票）。
   - 找到多条 → 防御性转人工。

---

## 7. 实现要点（店铺工作台 `invoice.js`）

- 隐藏 `BrowserWindow`（`session.fromPartition('persist:shop-'+shopId)`）加载 `https://fxg.jinritemai.com/ffa/morder/receipt/list`，`executeJavaScript` 注入自包含函数。
- 函数内用 `fetch` 相对路径直连上述接口（`credentials:'include'`），无需动态参数。
- `upload_pdf` 用 `FormData` + `new File([bytes], name, {type:'application/pdf'})`；字节来源：店铺工作台主进程读 `pdf_path` → base64 → 页面内 `atob` 还原（或 CDP `DOM.setFileInputFiles` 走 UI，二选一）。
- `save` 前先取 `detail` 拿 `upload_info`，再构造 body 提交。

---

## 附：页面 DOM 参考（供 UI 兜底）

- 列表页：每行「上传发票」是 `<a>` 标签，文本「上传发票」；点击打开 `auxo-drawer`（右侧抽屉）。
- 抽屉内：`input[type=file]`（`accept=".pdf,.xml,.ofd,.7z,.zip,.rar"`），底部「提交 / 取消」。
- 文件输入 `name=""`，上传组件 `name="file"`。
