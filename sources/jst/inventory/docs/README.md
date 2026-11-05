# jst-inventory

Read-only CLI for 聚水潭「商品采购及库存预警」. It imports the active Chrome session once, stores the filtered `erp321.com` session in macOS Keychain, and then calls the report API without running Chrome.

## Setup

The simplest setup is to copy the full `Cookie` request header from an authenticated 聚水潭 API request, then run:

```bash
jst-inventory auth import
```

Paste the Cookie header at the hidden prompt. On macOS, copying it to the clipboard first also supports:

```bash
pbpaste | jst-inventory auth import
```

Alternatively, log in to 聚水潭 in Chrome on the same Mac and import directly from its profile:

```bash
jst-inventory auth sync
```

Choose **Always Allow** for Chrome Safe Storage if you want later syncs to run without another prompt. Chrome can be closed after the command succeeds.

本机另有 `com.xdr.jst-auth-refresh` 自动维护任务：每日 09:30、15:30、21:30 从
OpenBridge 中实际可用的浏览器会话更新同一套 Keychain 凭据，先验证 API 再保存，
并保留浏览器实际到期时间。该任务不固定读取 `Default` 配置；凭据仍只保存在
本机 Keychain。所有浏览器均退出登录时，需要先登录聚水潭。

## Commands

```bash
jst-inventory login-status
jst-inventory summary
jst-inventory list --page 1 --limit 10
jst-inventory daily-metrics --input ./jst-inventory-full.sqlite
jst-inventory export-sqlite --output ./jst-inventory-full.sqlite
jst-inventory export-sqlite --output ./jst-inventory-full.sqlite --include-shop-shortage --shop-shortage-concurrency 2
jst-inventory shop-shortage list --page 1 --limit 10
jst-inventory shop-shortage summary
jst-inventory shop-shortage export-sqlite --output ./jst-shop-shortage.sqlite
jst-inventory sales-analysis shops --spu-id 4241 --days 30
jst-inventory sales-analysis platform --spu-id 4241 --days 30
jst-inventory sales-analysis channel --spu-id 4241 --days 30
jst-inventory sales-analysis link --spu-id 4241 --days 30
jst-inventory sales-analysis daily --spu-id 4241 --days 30
jst-inventory sale-channel platform --spu-id 4241
jst-inventory sale-channel channel --spu-id 4241
jst-inventory sale-channel export-sqlite --output ./jst-inventory-full.sqlite --concurrency 16
jst-inventory shop-sku-batch export-sqlite --output ./inventory-checkpoint.sqlite
jst-inventory shop-sku-batch export-sqlite --output ./inventory-checkpoint.sqlite --max-batches 2
jst-inventory auth clear
```

Every command emits JSON. This CLI contains no write operations for purchase orders, inventory rules, exports, or batch edits.

`daily-metrics` combines the two verified report families in a completed SQLite export.  
Shortage, overdue, presale shortage, and unshipped quantities come from  
「订单 → 缺货处罚预警 → 按链接看」. Available inventory, inventory in transit,  
and 7-day active style counts come from 「商品采购及库存预警 → 按款式看」.  
The command reads local SQLite only and does not call 聚水潭. Complete exports that  
include shop shortage data also write one row per Shanghai calendar date to  
`inventory_daily_metrics`, carrying prior dates forward when  
`--reuse-sales-analysis` supplies the previous XDR inventory database.

The SQLite `spu_inventory` and `sku_inventory` tables expose the report fields as  
queryable columns instead of requiring consumers to parse `raw_json`. The expanded  
schema is versioned as `export_info.schema_version = 4` and includes:

- 商品资料：名称、图片、品牌、分类、虚拟分类、供应商、标签、创建时间、采购备注及备注信息
- 商品属性：SKU、规格、成本价、末次采购价
- 库存：主仓、采购在途、销退在途、销退、进货仓、调拨在途、仓库合计、可售库存及可售天数
- 待发货：总数、预售、已超时、1 天内、1-3 天、3-7 天和 7 天以上分段
- 销量：今日、昨日、近 3/7/15/30/180 天及接口提供的各周期日均值
- 出库及退货：今日/昨日和近 3/7/15/30/180 天接口提供的周期值
- 店铺链接：总链接、昨日动销链接、近 7 天动销链接
- 经营指标：近 7/30 天毛利及利润指标、退款率预测、建议采购数

All fields are copied from the report response. Missing fields remain `NULL`; the  
CLI does not substitute an average for a quantity or calculate rolling averages.  
The original API row is retained in `raw_json` for auditing and forward compatibility.

Purchase-rule configuration, custom purchase days, replenishment formulas, and  
new/hot/growth/stagnant scenario statistics are not emitted as row columns because  
their account-specific definitions are not part of the verified detail response.

## Shop shortage warning

The `shop-shortage` commands read 「订单 → 缺货处罚预警 → 按链接看」 through the  
verified `stock_out_shop_spu_alarm_list` endpoint:

- `list` returns paginated shop-link rows and parsed shop-SKU children.
- `summary` reads all warning links and aggregates the three downstream metrics by shop.
- `export-sqlite` writes link details to `shop_stockout_warning`, shop totals to  
  `shop_shortage_summary`, and run metadata to `shop_shortage_export_info`.
- Main inventory export accepts `--include-shop-shortage` to append those three tables  
  to the inventory SQLite file used by XDR.
- Ordinary API errors are not silently repeated. When 聚水潭 explicitly returns  
  「访问超过限制」, all reads pause for 10 minutes and then continue the blocked  
  page request; XDR uses a lower concurrency of 2 for slower endpoints.

The downstream columns are `shop_stockout_qty`, `shop_urgent_stockout_qty`, and  
`shop_no_sent_qty`. `shop_urgent_stockout_qty` is explicitly defined as  
`timeout_qty + will_timeout_qty_1d`, matching the page's 「已超时」 and  
「剩余<=1天」 buckets. Source fields and the original response row remain available  
for audit. The shortage tables retain their own schema version when included in the  
main inventory database.

## Product sales analysis

### Default XDR collection: reuse inventory, batch only shop detail

The inventory `purchase_alarm_sku_detail` response already includes SKU children  
and their direct sales quantities. XDR reuses those totals instead of opening a  
drawer for each SKU. `shop-sku-batch export-sqlite` supplements only shop-filtered  
values through `purchase_alarm_sku_detail_unfold`: one shop, up to 500 SKU IDs from  
the existing inventory database, `excludeNoPayQtyFlag=0`. Codes constrain the query  
so disabling the historical-activity filter cannot expand it to the whole catalog.  
Shops are discovered from `platform_shop_list` without platform/auth-state filters;  
only shop ID, name and platform are persisted from that directory.

The batch collector skips today's complete SKU popup snapshots, requests serially  
with >=1500 ms spacing and retains the existing ten-minute risk-control backoff.  
It freezes the scope/date, saves successful pages, rejects incomplete pagination,  
and publishes `sale_channel_batch_snapshots` only after the entire scope succeeds.  
An interrupted run resumes the same checkpoint; `--max-batches N` returns  
`published=false` while unfinished. Cross-day or changed-scope checkpoints fail  
explicitly instead of restarting or blending dates.

Batch list data is NOT a complete channel-popup snapshot. It uses  
`quality=batch_list`, `coverage=listed_shops_only`, `complete=false`, and  
`distributor_granularity=unavailable`. Missing fields stay null, and raw projected  
fields distinguish missing from explicit null/zero. All-missing matrix entries  
do not prove a shop/SKU sales relationship. Old complete popup snapshots and  
their distributor/unassigned rows are untouched. No sales windows, yesterday  
quantities, totals or platform splits are calculated. Hourly exports carry both  
snapshot tables forward. `--empty-sales-analysis` initializes the upload schema  
locally on a first inventory-only sync without opening any sales drawers.

### Explicit legacy/detail commands

The complete page and drawer endpoint map is documented in  
[`PAGE-API-MAP.md`](./PAGE-API-MAP.md).

`sales-analysis platform`, `channel`, and `link` reproduce the three tabs in the  
sales-analysis drawer. They share the verified `purchase_goods_analysis_trend_detail`  
endpoint and select the response grain with `countType`. `shops` remains a compatibility  
alias for `channel`.

`sale-channel platform` and `sale-channel channel` reproduce the current page's  
「今日销量 → 分渠道看」popup. They return today's and rolling 3/7/15/30-day  
quantities, with optional shop/platform/distributor filters.

`sale-channel export-sqlite --query-type sku` reads all SKUs from an existing inventory database  
and collects only the unfiltered channel popup. It saves successful pages and  
complete products before atomically replacing the SKU rows in `sale_channel_snapshots`.  
No other analysis dimension or date-window request is issued. Capture times and  
the source API are retained in each row's `raw_json`. Nulls remain null. A short  
page or changing total fails without replacing the old snapshots. Distributor  
and unassigned rows are retained without merging. Cross-day unfinished pagination  
is rejected for inspection. `--query-type spu` selects SPUs explicitly.  
The SKU collector retries an explicit `系统繁忙` response on the same page at  
most three times, waiting 30 seconds each time. Other non-rate-limit errors fail  
without replacing the previous complete snapshot.

`sales-analysis shops` reads the read-only sales-analysis popup for one SPU. It  
returns shop identity, current and previous periods, sales quantity and comparison,  
and paid-return quantity and comparison. The default period is the last 30 complete  
days ending yesterday in Asia/Shanghai; `--days` and `--end-date` select another  
current period and the immediately preceding period.

`sales-analysis daily` reads the popup trend for one SPU. Every date contains the  
API's direct values for sales quantity (`sales_qty`), sales amount (`sales_amount`),  
order count (`order_count`), and net sales amount (`net_sales_amount`).

The sales-analysis schema is version 10. `platform_product_sales_analysis`,  
`shop_product_sales_analysis`, and `link_product_sales_analysis` persist the drawer's  
platform, channel, and link tabs respectively. Link identity is keyed by  
`spu_id + shop_id + shop_spu_id` and retains the listing name, image, creation time,  
SKU identifier, and URL returned by the popup. All three aggregate tables retain  
the same period-comparison metrics and raw response row.

`return_item_qty_180d` maps the popup's verified `afs_return_refund_qty_180d` field  
from each response row. Forecast refund rates likewise come only from that row and  
remain null when the API does not provide them.

Existing daily history tables are carried forward unchanged by the three-table  
sales-analysis refresh; it does not issue extra trend or one-day shop requests.

The legacy sales-analysis full export requires SPU identifiers. An explicit  
`--include-sales-analysis` requests every SPU with bounded concurrency and appends  
`platform_product_sales_analysis`, `shop_product_sales_analysis`,  
`link_product_sales_analysis`, and `sales_analysis_export_info` to the inventory  
SQLite file.


Hourly XDR exports use `--reuse-sales-analysis PATH` to carry those tables forward  
without repeating every popup request. A daily refresh copies the current inventory  
database and runs `shop-sku-batch export-sqlite --output PATH` as described above.  
The explicit legacy `sales-analysis export-sqlite` command remains available;  
each SPU batch commits independently and  
records completed SPUs locally; rerunning an interrupted period continues from  
unfinished SPUs.

## Security

- `auth import` accepts a full Cookie header but retains only `u_sso_token`, `u_id`, and `u_co_id`.
- Each imported field is stored in a separate `com.xx-cli.jst-inventory.*` macOS Keychain item.
- Cookie values are never printed by the CLI.
- `auth clear` deletes the imported Keychain item.
- A saved session has the same account access as the browser session until it expires or is revoked.  
  All three tables also persist `pay_qty_today`, `pay_qty_3d`, `pay_qty_7d`,  
  `pay_qty_15d`, and `pay_qty_30d`. Platform and shop rows copy all five fields from  
  one `purchase_alarm_sale_channel_detail` response per dimension. The link tab only  
  exposes one selected period, so its five values come from the five corresponding  
  direct page ranges, queried sequentially and matched by `shop_id + shop_spu_id`.  
  Values are never summed, averaged, inferred, or backfilled from a higher grain.

SPU/SKU 轻量快照仅在接口明确返回“系统异常，请稍后再试”且 HTTP 为200/5xx时，对同一只读页最多尝试三次，间隔5秒、15秒。登录/权限错误、普通API错误及快照完整性失败不自动重试。错误JSON保留API名称、失败页码、页大小、HTTP状态、响应错误码及尝试次数，不保存Cookie、鉴权头或业务响应明细。既有总量、唯一性、页完整性及SPU/SKU数量一致性检查保持生效。
