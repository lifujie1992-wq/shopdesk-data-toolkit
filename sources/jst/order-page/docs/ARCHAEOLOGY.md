# 常用功能订单页接口考古

验证日期：2026-09-08，用户已登录 Chrome / OpenBridge。目标页面：

- 列表：`https://www.erp321.com/app/order/order/list.aspx`，通常嵌在 `/epaas` iframe。
- 入口：内部订单号旁 `.h_btn_show_order[title="查看订单详情"]`，显示文本「详」。
- 弹窗：`/app/order/order/OrderEditorNew.aspx`，真实标题「销售订单详情」。用户原话“定点详情”按此实际入口定位；未发现独立同名页签。
- 详情地址来自列表 `o_id_en`，传 `order_id=<o_id_en>&archive=false&owner_co_id=<real_co_id>&fromList=true`。不要自行推导加密订单 ID。

## 已验证读取链路

| 页面/方法                                    | 参数                                                 | 响应/用途                                                                                    |
| ---------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| list.aspx / LoadDataToJSON               | `[page, JSON(filters), JSON(sort)]`，target=JTable1 | `{dp,datas}`；兼容 `{fields,values}` 经原站 DataMapping 还原；列表完整行                               |
| list.aspx / LoadDataToJSONPage           | 同上，`_jt_page_action=2`                             | `dp.DataCount` / `PageCount`；精确 ID 计数返回 1                                                |
| OrderEditorNew.aspx GET                  | 列表给出的详情 URL                                        | HTML 内 `_OrderData`、`_RevenueStatisticsData`、`_ExtDatas`、`_extDatasModelData` JSON 初始化数据 |
| OrderEditorNew.aspx / ReloadOrder        | `["true"]`，target=ACall1                           | ReturnValue 是 JSON 字符串；重新读订单并请求完整商品。页面商品超过限制时也是调用 ReloadOrder(true)                      |
| OrderEditorNew.aspx / LoadAfterSale      | `[]`                                               | 售后数组或 null；无售后真实样本已验证                                                                    |
| OrderEditorNew.aspx / GetOrderActionList | `[o_id,"","false"]`                                | 日志数组；不筛选动作类型，倒序                                                                          |

可执行浏览器表达式：`src/page.js` 导出的 `readPage` 函数。`Bridge.run(readPage,{command:"detail",id:"…",limit:1})` 在页面上下文启动 async 任务并轮询结果，所有网络请求均用 `credentials:"include"`。使用现有页面的 POST 表单状态；不导出浏览器认证。

## 回调协议

POST 到原页面地址，保留详情 query，再加 `ts___=<timestamp>&am___=<method>`。

Headers：`Content-Type: application/x-www-form-urlencoded; charset=UTF-8`，`X-Requested-With: XMLHttpRequest`。复用表单内 `__VIEWSTATE`、`__VIEWSTATEGENERATOR`、`__EVENTVALIDATION` 以及页面生成的 `__ajax_token`。首次缺少 EVENTVALIDATION 的重放没有返回有效回调；补齐原站请求结构后 HTTP 200、IsSuccess=true。

表单参数：

```text
__CALLBACKID=JTable1 或 ACall1
__CALLBACKPARAM=JSON({Method,Args,CallControl?})
```

所有 Args 与原站 `_ACP` 一样序列化成字符串或 null；页面回调带 `CallControl:"{page}"`，JTable 回调不带。

响应不是直接 JSON，而是 `<N>|<N个字符的前缀><JSON envelope>`。解析第一个 `|` 前的十进制长度，跳过对应字符，随后 JSON.parse；校验 `IsSuccess`/`GotoLogin`/`ExceptionMessage`，再解码 `ReturnValue`。不执行返回的 `ClientScript` 或导航指令。

## 列表筛选和分页

实测 `[{"k":"o_id","v":"<内部订单号>","c":"="}]` 返回恰好一行。列表当前 `Filter=[]`、`OrderBy={}` 时是业务订单视图，不是已发货报表。状态及日期筛选应直接使用页面 Filter 结构；不能把中文显示状态当作服务端值。

`_jt_page_size` 必须使用 20/50/100/200/500/1000/1500/2000。传 3 会回退为 50，所以 CLI 明确把 limit 与底层页大小分开。设置 `_jt_page_increament_enabled=false` 使用普通页号；第 2 页实测 PageSize=20、SkipCount=20、PageIndex=2。

列表请求 DataCount=-1 是懒计数，不是负订单数；IsLast=true 也不是可靠终止条件。计数使用独立 LoadDataToJSONPage。跨页去重、时间窗口、变更游标和断点续传还没有实现。

## 字段覆盖与网页对应

| 页面区域                              | 保存位置                                        |
| --------------------------------- | ------------------------------------------- |
| 订单列表全部字段/隐藏列                      | rows[] / columns[]                          |
| 交易、地址、发票、备注、仓库、快递、订单状态            | details[].order                             |
| 商品 SKU、数量、价格、退款状态、成本、库存、分销、批次、达人等 | details[].order.items[]                     |
| 支付方式、金额、确认状态及相关标识                 | details[].order.pays[]                      |
| 操作进程、创建时间、操作人、动作、备注               | details[].order.actions[]                   |
| 售后区域                              | details[].aftersales                        |
| 优惠、平台补贴、服务费、收入及商品分摊               | details[].revenue                           |
| 扩展数据与详情标签                         | extensions / extension_model / field_labels |

最终示例包含 5 笔订单，覆盖 WaitPay、Question、Sent、WaitConfirm 四种状态。订单顶层字段因状态为 166–168 个，商品字段联合 100 个，支付字段联合 53 个；全部联合字段路径 609 条。FIELD-SCHEMA.json 记录实际快照路径/类型，不记录客户字段值。sample.sqlite/sample.html 是这些单独抓取样本的组合，非连续列表页。

## 静态接口线索（未当作可用接口）

INTERFACE-CANDIDATES.json 来自运行中页面函数源码，列表 233 处、详情 125 处回调引用。条目标注函数名、helper、endpoint、method、runtime_verified=false。此清单包含写方法，仅用于继续考古，CLI 只有经过验证的读取方法白名单。

后续网页扩展可优先检查：

- 列表字段补充：LoadStockSummaries、LoadPurchaseAndFollowRecordV3、LoadExtDatasModelStr、GetAllFeLabels。
- 出入库/物流：GetInoutInfo、GetTrace、LoadOrderAction、GetPickableIndexNew。
- 发票日志/供分销：GetOrderInvoiceActions、GetDrpExtData。
- 历史归档：GetOrderNewestArchiveExecuteInfo、GetOrderArchiveInfo。当前详情只验证 archive=false。

这些方法没有完整参数/响应验证，不能用名称判断是否绝对只读。手机号报备、收件信息解密、审核、支付、退款、取消、发货等没有作为采集动作调用。

## 已做验证与限制

真实按 ID 查询、Sent 状态筛选、详情 GET、完整商品刷新、日志读取、空售后、批量完整采集、第二页查询、计数、不存在订单的非零退出。SQLite 逐层保留和权限、HTML 数据注入防护有自动测试。Chrome 验证离线网页列表、点击详情出现 11 个分区、搜索无结果后恢复、关闭弹窗。

非空售后、复杂分销/跨境、归档单、千条以上商品订单、平台特殊订单字段仍需相应样本验证。暂无实测限流阈值，采集顺序执行且每次最多 20 条；不宣称完整覆盖全部状态和所有 358 处静态引用。网页是可检查的数据还原原型，尚非原站视觉/操作复刻。
