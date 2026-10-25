# Order Detail Archaeology

- Page: 聚水潭「数据 / 订单明细查询」
- Verified through OpenBridge on 2026-09-06
- Detail endpoint: `sales_theme_order_list`
- Summary endpoint: `sales_theme_order_list_sum`
- Root: `POST https://api.erp321.com/jst-data-report/getData/transportData`
- Domain/page: `salesTheme` / `SALES_THEME_ORDER`
- Table code: `sales_theme_analysis_order_by_order_table`
- Grain: order (the tabs use separate APIs, not a `dataType` switch)
- Date field: shipment time (`dateType=send_date`)
- Filters: sent, split bundles, exclude unfinished, exchange orders, 特殊单, 统计排除标
- Pagination: `pageNum`, `pageSize`; 5,000 rows per page verified
- Verified 30-day range: 2026-08-07 through 2026-09-05
- Verified count: 816,210 orders
- Verified response: HTTP 200, `code=0`, `success=true`, 53 order fields
- Authentication: shared `u_sso_token`, `u_id`, and `u_co_id` Keychain session

## Report tabs

The page has two report tabs. The default `订单` tab is the verified order-grain
request above. The second `订单（商品）` tab changes the same list and summary
requests to the item dimension:

| Tab | `dataType` | custom column table code | Status |
|---|---:|---|---|
| 订单 | n/a | `sales_theme_analysis_order_by_order_table` | Verified |
| 订单（商品） | n/a | `sales_theme_analysis_order_by_shop_table` | Verified 2026-09-08 |

The item tab uses `sales_theme_order_item_list` and
`sales_theme_order_item_list_sum`; it does not switch the order endpoint with a
`dataType` parameter. A verified one-day request for 2026-09-07 returned 30,706
rows and 87 fields. Item rows are stored separately in `order_item_details`, keyed
by `o_id + sku_id + oi_shop_sku_id + oi_outer_oi_id`; that combination was unique
across all 30,706 rows. One order had as many as 49 item rows.

The endpoint is read-only. Responses include logistics and message fields that may contain personal data; local database permissions must remain `0600` and agents should not print those fields by default.
